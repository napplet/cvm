import { link, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import {
  ProviderCapabilityObservationSchema,
  ReleaseControllerCurrentPointerSchema,
  ReleaseControllerStateSchema,
  ReleaseEffectPlanSchema,
  ReleaseTopologyObservationSchema,
  type ProviderCapabilityObservation,
  type ReleaseAuthorizationRequest,
  type ReleaseControllerState,
  type ReleaseProviderId,
  type ReleaseProviderRegistry,
  type ReleaseTopologyObservation,
} from "./contracts";
import { deriveReleaseTopology, RELEASE_PROVIDER_IDS, RELEASE_TOPOLOGY_QUANTITY_CONTRACT } from "./topology";
import { isObservedCollectorRegistryImage, type ObservedCollectorRegistryImage, type PreparedCollectorImage } from "./collector-image";
import { createAuthorizationRequest, createOfficialConsentReceipt, validateAuthorizationReceipt, validateAuthorizationRequest, type ReleaseAuthorizationReceipt } from "./authorization";
import type { OfficialConsentPort } from "./deployment/consent";
import { ReleaseProviderCostObservationSchema, ReleaseProviderOperationSchema, type ReleaseProviderCostObservation, type ReleaseProviderOperation, type ReleaseProviderRegistry as AuthorizedProviderRegistry } from "./providers";
import { createReleaseControllerProviderRegistry } from "./native-registry";
import { materializeProtectedCertifier, type MaterializeProtectedCertifierInput, type MaterializedCertifier } from "./materialize-certifier";
import { finalizeReleaseCertification, type ReleaseFinalizationInput, type ReleaseFinalizationResult } from "./finalize";
import { createProductionLiveProtectedCertificationRegistry, type LiveProtectedRegistryInput } from "../certification/live/registry";
import type { ProductionLiveProtectedCertificationPorts } from "../certification/live/production-ports";
import { PROTECTED_SUITES, runProtectedCertificationProfile, type ProtectedCertificationRun } from "../certification/runner";
import { validateCertificationObservation } from "../certification/evidence";
import type { CertificationObservation } from "../certification/contracts";
import { createLiveCostEstimator, RELEASE_COST_FAMILIES, type LiveCostCatalogPort } from "./costs/live-estimator";
import { validateOperatorFundingReadiness, type OperatorFundingReadiness } from "./deployment/operator-funding";

export const RELEASE_WORKSPACE_ENV = "NAPPLET_CVM_RELEASE_WORKSPACE";
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());

type CandidateIdentity = ReleaseControllerState["candidate"];
type ControllerOptions = Readonly<{
  candidatePath: string;
  workspace: string;
  providers?: ReleaseProviderRegistry;
  consent?: OfficialConsentPort;
  /** Read-only price-catalog boundary. It is injected for authenticated
   * readiness and fake-only tests; this controller never creates a client. */
  costCatalog?: LiveCostCatalogPort;
  /** Product entrypoints must provide all current, source-attributed price
   * facts. The candidate fixture catalog is intentionally retained only for
   * direct local controller tests and historical no-credential workflows. */
  requireCurrentPriceCatalog?: boolean;
  /** Explicitly supplied, opaque service-funding prerequisites from the
   * same product request. Values are revalidated before they enter the
   * immutable authorization request; no wallet material is accepted here. */
  operatorFundingReadiness?: OperatorFundingReadiness;
  /** Local preapproval may supply only a prepared OCI layout. Provider work is
   * refused until the same layout has a post-upload registry observation. */
  collectorImage?: PreparedCollectorImage | ObservedCollectorRegistryImage;
  now?: () => number;
}>;
export type ReleaseCertificationResult = Readonly<{
  exitCode: 1;
  state: ReleaseControllerState;
  authorizationRequest: ReleaseAuthorizationRequest;
}>;
export type ReleaseCertificationProgress = ReleaseCertificationResult & Readonly<{
  /** This local implementation deliberately stops here. Only the later
   * authenticated executor may progress into provider or protected operations. */
  stage: "authorization_required";
}>;
export type ReleaseProvisioningResult = Readonly<{
  state: ReleaseControllerState;
  authorizationRequest: ReleaseAuthorizationRequest;
  topology: ReleaseTopologyObservation & Readonly<{ deployment: NonNullable<ReleaseTopologyObservation["deployment"]> }>;
}>;
export type AuthorizedLiveExecutionInput = Readonly<{
  receipt: unknown;
  /** The one project-owned production registry from native-registry.ts. */
  registry: AuthorizedProviderRegistry;
  materialization: Omit<MaterializeProtectedCertifierInput, "workerSelection" | "nowMs" | "authorization">;
  workerSelection: NonNullable<MaterializeProtectedCertifierInput["workerSelection"]>;
  protected: Omit<LiveProtectedRegistryInput, "ports"> & Readonly<{ ports: ProductionLiveProtectedCertificationPorts }>;
  protectedVerificationReferences?: Parameters<typeof runProtectedCertificationProfile>[0]["profile"]["protectedVerificationReferences"];
  /** Supplied by the authenticated protected executor only after all eight
   * canonical suite records are present. The controller owns the records and
   * delegates the sole evaluator/promotion/cleanup sequence to finalization. */
  finalization?: Omit<ReleaseFinalizationInput, "workspace" | "candidateId" | "topologySha256" | "authorizationReceiptSha256" | "protectedRecords">;
}>;
export type AuthorizedLiveExecutionResult = ReleaseProvisioningResult & Readonly<{
  materialized: MaterializedCertifier;
  protected: ProtectedCertificationRun;
  finalization: ReleaseFinalizationResult;
}>;
/** A hash-pinned deployment module supplies the one receipt-bound session.
 * It owns authenticated handles and official consent; the controller owns the
 * candidate-bound state machine and receives no ambient credentials. */
export type ReleaseExecutionSession = Readonly<{
  registry: AuthorizedProviderRegistry;
  collectorImage?: Readonly<{
    uploadAndObserve(input: Readonly<{ authorizationRequest: ReleaseAuthorizationRequest; collector: PreparedCollectorImage }>): Promise<ObservedCollectorRegistryImage>;
  }>;
  prepareAuthorizedExecution(input: Readonly<{ authorizationRequest: ReleaseAuthorizationRequest }>): Promise<Omit<AuthorizedLiveExecutionInput, "registry">>;
}>;

type LegacyProviderOperationRecord = Readonly<{
  version: 1;
  operation: ReleaseProviderOperation;
  status: "pending" | "unknown" | "completed";
  actualCostMicros: number;
  resourceIdentitySha256: string | null;
}>;
type LegacyCurrentProviderOperationRecord = Readonly<{
  version: 2;
  operation: ReleaseProviderOperation;
  status: "pending" | "unknown" | "completed";
  billingStatus: "unknown" | "observed";
  reservedCostMicros: number;
  actualCostMicros: number | null;
  costObservation: ReleaseProviderCostObservation | null;
  costObservationSha256: string | null;
  accountScopeSha256: string;
  projectScopeSha256: string;
  resourceIdentitySha256: string | null;
}>;
/** Version three keeps resource completion distinct from billing and appends
 * every transition as a content-addressed record. The reservation is bound to
 * the original authorization effect and held until a future report adapter
 * records receipt-bound actual usage. */
type CurrentProviderOperationRecord = Readonly<{
  version: 3;
  operation: ReleaseProviderOperation;
  status: "pending" | "unknown" | "completed";
  billingStatus: "unknown" | "observed";
  reservedCostMicros: number;
  actualCostMicros: number | null;
  costObservation: ReleaseProviderCostObservation | null;
  costObservationSha256: string | null;
  accountScopeSha256: string;
  projectScopeSha256: string;
  resourceIdentitySha256: string | null;
  priorRecordSha256: string | null;
  recordSha256: string;
}>;
type ProviderOperationRecord = LegacyProviderOperationRecord | LegacyCurrentProviderOperationRecord | CurrentProviderOperationRecord;
type DispatchClaim = Readonly<{
  version: 1;
  stateSha256: string;
  recordSha256: string;
  operation: ReleaseProviderOperation;
  reservedCostMicros: number;
  accountScopeSha256: string;
  projectScopeSha256: string;
  dispatchClaimSha256: string;
}>;
type StateTransition = Readonly<{
  version: 1;
  priorStateSha256: string;
  nextStateSha256: string;
  transitionSha256: string;
}>;

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withoutDigest<T extends Record<string, unknown>>(value: T, key: string): Omit<T, typeof key> {
  const { [key]: _digest, ...payload } = value;
  return payload;
}

async function candidateIdentity(path: string): Promise<CandidateIdentity> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("RELEASE_CONTROLLER_CANDIDATE_INVALID"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("RELEASE_CONTROLLER_CANDIDATE_INVALID");
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.status !== "string") throw new Error("RELEASE_CONTROLLER_CANDIDATE_INVALID");
  const candidateSha256 = await digest(record);
  const identity = (field: string) => digest({ candidateSha256, field, value: record[field] ?? null });
  return {
    candidateSha256,
    sourceSha256: await identity("sourceRevision"),
    packageSha256: await identity("packages"),
    lockfileSha256: await identity("lockfileSha256"),
    toolchainSha256: await identity("stages"),
    policySha256: await identity("policyVersion"),
    datasetSha256: await identity("fixtures"),
  };
}

/** Canonical candidate identity is shared with local, no-effect discovery so
 * its redacted scope/cost descriptors are bound to the same bytes as the
 * controller state and authorization request. */
export async function releaseCandidateSha256(path: string): Promise<string> {
  return (await candidateIdentity(path)).candidateSha256;
}

const defaultObservation = (provider: ReleaseProviderId): ProviderCapabilityObservation => ProviderCapabilityObservationSchema.parse({
  version: 1,
  provider,
  capability: "unavailable",
  authentication: "not_configured",
  accountScopeSha256: "0".repeat(64),
  costEstimateSha256: "0".repeat(64),
  secretReferenceNames: [],
  reasonCode: "CREDENTIALS_UNAVAILABLE",
});

/** The local controller has no implicit authority: every provider is a finite
 * no-credential discovery port until a later authorization-gated registry is supplied. */
export function createNoCredentialReleaseProviderRegistry(): ReleaseProviderRegistry {
  return Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
    discover: async () => {
      const { version: _version, provider: _provider, accountScopeSha256: _scope, costEstimateSha256: _cost, secretReferenceNames: _references, ...observation } = defaultObservation(provider);
      return observation;
    },
  }])) as ReleaseProviderRegistry;
}

async function discoverProviders(registry: ReleaseProviderRegistry): Promise<ProviderCapabilityObservation[]> {
  const observations = await Promise.all(RELEASE_PROVIDER_IDS.map(async (provider) => {
    const port = registry[provider];
    if (!port) return defaultObservation(provider);
    try {
      const discovered = await port.discover();
      return ProviderCapabilityObservationSchema.parse({
        ...discovered,
        version: 1,
        provider,
        accountScopeSha256: discovered.accountScopeSha256 ?? "0".repeat(64),
        costEstimateSha256: discovered.costEstimateSha256 ?? "0".repeat(64),
        secretReferenceNames: discovered.secretReferenceNames ?? [],
      });
    } catch {
      return ProviderCapabilityObservationSchema.parse({ ...defaultObservation(provider), reasonCode: "CAPABILITY_UNAVAILABLE" });
    }
  }));
  return observations;
}

const EFFECT_DEFINITIONS = [
  ["cloud-run-ingress", "cloud_run", "create_or_update"], ["gcs-retention", "gcs", "configure"],
  ["collector", "collector", "create_or_update"], ["database", "cloud_sql_postgres", "create_or_update"],
  ["modal-benchmark", "modal", "benchmark"], ["fly-benchmark", "fly", "benchmark"],
  ["contextvm-rails", "contextvm", "verify_integration"], ["payments", "cep8_lightning", "verify_integration"],
  ["cashu", "cashu", "verify_integration"], ["model", "model", "verify_integration"],
  ["host-signer", "compatible_host", "verify_integration"], ["signer", "signer", "verify_integration"],
  ["cli-asset", "promoted_cli", "verify_integration"], ["publication", "upload", "verify_integration"],
  ["owner-relay", "owner_relay", "verify_integration"], ["attestation-relay", "attestation_relay", "verify_integration"],
] as const;
/* Upper policy fence for 2,016 operations × 100k input + 8,192 combined
 * output/thought tokens, both worker cohorts and infrastructure, with
 * headroom. This is not approval or a quote: the fresh source-priced exact
 * envelope must still be reviewed and authorized before any protected effect. */
const RELEASE_MAX_AUTHORIZED_COST_MICROS = 2_000_000_000;

/** The local no-credential path has no external price authority. It produces
 * finite candidate-bound fixture facts only; authenticated readiness must
 * inject its own schema-bounded, read-only catalog. */
function candidateBoundFixtureCatalog(input: Readonly<{ capabilities: readonly ProviderCapabilityObservation[]; nowMs: number }>): LiveCostCatalogPort {
  return {
    async listPriceFacts({ providers }) {
      if (providers.length !== RELEASE_COST_FAMILIES.length || providers.some((provider, index) => provider !== RELEASE_COST_FAMILIES[index])) throw new Error("RELEASE_CONTROLLER_PRICE_COVERAGE_REQUIRED");
      return providers.map((provider, index) => {
        const capability = input.capabilities[index];
        if (!capability || capability.provider !== provider) throw new Error("RELEASE_CONTROLLER_PRICE_COVERAGE_REQUIRED");
        return {
          provider,
          sourceId: `${provider}-fixture-catalog`,
          sourceDocumentSha256: capability.costEstimateSha256,
          quoteSha256: capability.accountScopeSha256,
          currency: "USD",
          unit: "operation",
          priceMicros: index + 1,
          observedAtMs: input.nowMs,
          freshUntilMs: input.nowMs + 60 * 60 * 1000,
          status: "available",
        };
      });
    },
  };
}

async function effectPlan(candidateSha256: string, topologySha256: string, estimate: Awaited<ReturnType<ReturnType<typeof createLiveCostEstimator>["estimate"]>>) {
  if (estimate.maximumMicros > RELEASE_MAX_AUTHORIZED_COST_MICROS) throw new Error("RELEASE_CONTROLLER_PRICE_ABOVE_POLICY");
  const base = {
    version: 1 as const, candidateSha256, topologySha256,
    effects: EFFECT_DEFINITIONS.map(([id, provider, operation], index) => ({ id, provider, operation, estimatedCostMicros: estimate.lines[index]!.maximumMicros })),
    maximumAuthorizedCostMicros: estimate.maximumMicros,
  };
  return ReleaseEffectPlanSchema.parse({ ...base, effectPlanSha256: await digest(base) });
}

async function stateFor(input: Omit<ReleaseControllerState, "stateSha256">): Promise<ReleaseControllerState> {
  return ReleaseControllerStateSchema.parse({ ...input, stateSha256: await digest(input) });
}

async function createOrVerify(path: string, content: string, collision: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  try {
    await link(temporaryPath, path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error(collision);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** A durable create-only record is the CAS primitive for an effect claim or
 * state edge. `wx` admits one winner; the explicit sync places the claim
 * before any provider call. An interrupted/partial record is fail-closed. */
async function createSynced(path: string, content: string): Promise<"created" | "exists"> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    return "created";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return "exists";
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readProtectedRecord(input: Readonly<{
  workspace: string;
  suite: string;
  candidateId: string;
  topologySha256: string;
  authorizationReceiptSha256: string;
  nowMs: number;
}>): Promise<CertificationObservation | undefined> {
  const path = join(input.workspace, "protected-records", `${input.suite}.json`);
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("RELEASE_CONTROLLER_PROTECTED_RECORD_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RELEASE_CONTROLLER_PROTECTED_RECORD_INVALID");
  const stored = value as Readonly<{ version?: unknown; candidateSha256?: unknown; topologySha256?: unknown; authorizationReceiptSha256?: unknown; record?: unknown }>;
  if (stored.version !== 1 || stored.candidateSha256 !== input.candidateId || stored.topologySha256 !== input.topologySha256 || stored.authorizationReceiptSha256 !== input.authorizationReceiptSha256) {
    throw new Error("RELEASE_CONTROLLER_PROTECTED_RECORD_INVALID");
  }
  try {
    const record = await validateCertificationObservation(stored.record, { nowMs: input.nowMs, candidateId: input.candidateId });
    if (record.input.command[1] !== `suite:${input.suite}` || record.input.topologySha256 !== input.topologySha256) throw new Error("RELEASE_CONTROLLER_PROTECTED_RECORD_INVALID");
    return record;
  } catch (error) {
    if (error instanceof Error && error.message === "RELEASE_CONTROLLER_PROTECTED_RECORD_INVALID") throw error;
    throw new Error("RELEASE_CONTROLLER_PROTECTED_RECORD_INVALID");
  }
}

export class ReleaseCertificationController {
  readonly #candidatePath: string;
  readonly #workspace: string;
  readonly #providers: ReleaseProviderRegistry;
  readonly #consent: OfficialConsentPort | undefined;
  readonly #costCatalog: LiveCostCatalogPort | undefined;
  readonly #requireCurrentPriceCatalog: boolean;
  readonly #operatorFundingReadiness: OperatorFundingReadiness | undefined;
  readonly #collectorImage: PreparedCollectorImage | ObservedCollectorRegistryImage | undefined;
  readonly #now: () => number;

  constructor(options: ControllerOptions) {
    this.#candidatePath = resolve(options.candidatePath);
    this.#workspace = resolve(options.workspace);
    this.#providers = options.providers ?? createNoCredentialReleaseProviderRegistry();
    this.#consent = options.consent;
    this.#costCatalog = options.costCatalog;
    this.#requireCurrentPriceCatalog = options.requireCurrentPriceCatalog ?? false;
    this.#operatorFundingReadiness = options.operatorFundingReadiness;
    this.#collectorImage = options.collectorImage;
    this.#now = options.now ?? Date.now;
  }

  async status(): Promise<ReleaseCertificationResult | undefined> {
    const pointerPath = join(this.#workspace, "current.json");
    let pointerRaw: unknown;
    try { pointerRaw = JSON.parse(await readFile(pointerPath, "utf8")); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new Error("RELEASE_CONTROLLER_POINTER_INVALID");
    }
    const pointer = ReleaseControllerCurrentPointerSchema.safeParse(pointerRaw);
    if (!pointer.success || pointer.data.pointerSha256 !== await digest(withoutDigest(pointer.data, "pointerSha256"))) throw new Error("RELEASE_CONTROLLER_POINTER_INVALID");
    const state = (await this.#loadCurrent()).state;
    if (state.candidate.candidateSha256 !== pointer.data.candidateSha256 || !state.authorizationRequestSha256) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    if ((await candidateIdentity(this.#candidatePath)).candidateSha256 !== state.candidate.candidateSha256) throw new Error("RELEASE_CONTROLLER_CANDIDATE_MISMATCH");
    const request = await this.#readRequest(state.authorizationRequestSha256);
    await validateAuthorizationRequest(request);
    const plannedCost = request.orderedEffects.reduce((total, effect) => total + effect.estimatedCostMicros, 0);
    if (
      (state.status === "authorization_required" && request.controllerStateSha256 !== state.priorStateSha256)
      || request.candidateSha256 !== state.candidate.candidateSha256
      || request.topologySha256 !== state.topologySha256
      || request.providerCapabilitiesSha256 !== await digest(state.capabilities)
      || request.maximumAuthorizedCostMicros !== plannedCost
      || request.expiresAtMs <= state.createdAtMs
    ) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    return { exitCode: 1, state, authorizationRequest: request };
  }

  async dryRun(): Promise<ReleaseCertificationResult> {
    const candidate = await candidateIdentity(this.#candidatePath);
    const topology = await deriveReleaseTopology(candidate.candidateSha256, this.#collectorImage);
    const capabilities = await discoverProviders(this.#providers);
    const nowMs = this.#now();
    const operatorFundingReadiness = this.#operatorFundingReadiness === undefined
      ? undefined
      : await validateOperatorFundingReadiness(this.#operatorFundingReadiness);
    if (this.#requireCurrentPriceCatalog && !this.#costCatalog) {
      throw new Error("RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED");
    }
    const estimator = createLiveCostEstimator({
      catalog: this.#costCatalog ?? candidateBoundFixtureCatalog({ capabilities, nowMs }),
      now: () => nowMs,
    });
    const estimate = await estimator.estimate({
      topologySha256: topology.topologySha256,
      quantities: RELEASE_COST_FAMILIES.map((provider) => ({ provider, quantityNanos: 1_000_000_000n, headroomBasisPoints: 1_000 })),
      components: RELEASE_TOPOLOGY_QUANTITY_CONTRACT,
    });
    const plan = await effectPlan(candidate.candidateSha256, topology.topologySha256, estimate);
    let existing: ReleaseCertificationResult | undefined;
    let replaceInvalidPointer = false;
    try { existing = await this.status(); }
    catch (error) {
      if (error instanceof Error && error.message === "RELEASE_CONTROLLER_CANDIDATE_MISMATCH") throw error;
      replaceInvalidPointer = true;
      existing = undefined;
    }
    if (existing) {
      if (existing.state.candidate.candidateSha256 !== candidate.candidateSha256) throw new Error("RELEASE_CONTROLLER_CANDIDATE_MISMATCH");
      if (existing.state.status !== "authorization_required") throw new Error("RELEASE_CONTROLLER_RESUME_INPUT_MISMATCH");
      const requestStillCurrent = existing.state.topologySha256 === topology.topologySha256
        && existing.authorizationRequest.effectPlanSha256 === plan.effectPlanSha256
        && existing.authorizationRequest.maximumAuthorizedCostMicros === plan.maximumAuthorizedCostMicros;
      if (requestStillCurrent && canonicalJson(existing.state.capabilities) === canonicalJson(capabilities) && existing.authorizationRequest.expiresAtMs > nowMs) return existing;
    }
    const discovering = await stateFor({
      version: 1, status: "discovering", candidate, topologySha256: topology.topologySha256, capabilities,
      priorStateSha256: null, authorizationRequestSha256: null, authorizationReceiptSha256: null,
      providerOperationIds: [], deployedTopologySha256: null, blockReasonCode: null, createdAtMs: nowMs,
    });
    await createOrVerify(join(this.#workspace, "states", `${discovering.stateSha256}.json`), `${canonicalJson(discovering)}\n`, "RELEASE_CONTROLLER_STATE_COLLISION");
    const request = await createAuthorizationRequest({
      candidateSha256: candidate.candidateSha256,
      topologySha256: topology.topologySha256,
      effectPlanSha256: plan.effectPlanSha256,
      controllerStateSha256: discovering.stateSha256,
      providerCapabilitiesSha256: await digest(capabilities),
      orderedEffects: plan.effects,
      providerScopes: await Promise.all(capabilities.map(async (capability) => ({
        provider: capability.provider,
        accountScopeSha256: capability.accountScopeSha256,
        projectScopeSha256: await digest({ version: 1, provider: capability.provider, topologySha256: topology.topologySha256, accountScopeSha256: capability.accountScopeSha256 }),
      }))),
      estimate: { currency: "USD", maximumMicros: plan.maximumAuthorizedCostMicros, sourceId: "live-price-catalog-v1", sourceSha256: estimate.sourceSha256, observedAtMs: estimate.observedAtMs, freshUntilMs: estimate.freshUntilMs },
      priceLines: estimate.lines.map(({ components: _components, ...line }) => ({ ...line, quantityNanos: Number(line.quantityNanos) })),
      ...(operatorFundingReadiness ? { operatorFundingReadiness } : {}),
      maximumRunDurationMs: 15 * 60 * 1000,
      cleanupByMs: Math.min(discovering.createdAtMs + 15 * 60 * 1000, estimate.freshUntilMs - 1),
      evidenceRetentionDays: 30,
      artifactRetentionDays: 30,
      gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["run.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"] },
      expiresAtMs: Math.min(discovering.createdAtMs + 30 * 60 * 1000, estimate.freshUntilMs - 1),
      supersedesAuthorizationRequestSha256: existing?.authorizationRequest.authorizationRequestSha256 ?? null,
    });
    await createOrVerify(join(this.#workspace, "authorization-requests", `${request.authorizationRequestSha256}.json`), `${canonicalJson(request)}\n`, "RELEASE_CONTROLLER_AUTHORIZATION_COLLISION");
    const final = await stateFor({
      version: 1, status: "authorization_required", candidate, topologySha256: topology.topologySha256, capabilities,
      priorStateSha256: discovering.stateSha256, authorizationRequestSha256: request.authorizationRequestSha256,
      authorizationReceiptSha256: null, providerOperationIds: [], deployedTopologySha256: null, blockReasonCode: "AUTHORIZATION_REQUIRED", createdAtMs: discovering.createdAtMs,
    });
    await createOrVerify(join(this.#workspace, "states", `${final.stateSha256}.json`), `${canonicalJson(final)}\n`, "RELEASE_CONTROLLER_STATE_COLLISION");
    const pointerBase = { version: 1 as const, stateSha256: final.stateSha256, candidateSha256: candidate.candidateSha256 };
    const pointer = { ...pointerBase, pointerSha256: await digest(pointerBase) };
    if (existing || replaceInvalidPointer) await this.#writeCurrent(final);
    else await createOrVerify(join(this.#workspace, "current.json"), `${canonicalJson(pointer)}\n`, "RELEASE_CONTROLLER_CONCURRENT_WRITE");
    return (await this.status())!;
  }

  /** Candidate-only orchestration entrypoint. It persists and verifies the
   * content-addressed admission state, then fail-closes before authorization.
   * There is intentionally no test hook for a runner, evaluator, trust root,
   * bundle writer, provider mutation, or cleanup effect. */
  async certify(input: Readonly<{ onProtectedRunnerCall?: () => void }> = {}): Promise<ReleaseCertificationProgress> {
    void input.onProtectedRunnerCall;
    const result = await this.dryRun();
    if (result.state.status !== "authorization_required") throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    return { ...result, stage: "authorization_required" };
  }

  /** Launches the one official consent boundary for the current immutable
   * request. The result is persisted by digest and contains references only;
   * provider execution remains unreachable from this method. */
  async launchOfficialConsent(): Promise<ReleaseAuthorizationReceipt> {
    if (!this.#consent) throw new Error("RELEASE_CONTROLLER_CONSENT_UNAVAILABLE");
    const current = await this.#loadCurrent();
    if (!current.state.authorizationRequestSha256 || current.state.status !== "authorization_required") {
      throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    }
    const request = await this.#readRequest(current.state.authorizationRequestSha256);
    const approval = await this.#consent.launch({ authorizationRequest: request });
    const receipt = await createOfficialConsentReceipt({ request, approval });
    await createOrVerify(
      join(this.#workspace, "authorization-receipts", `${receipt.authorizationReceiptSha256}.json`),
      `${canonicalJson(receipt)}\n`,
      "RELEASE_CONTROLLER_AUTHORIZATION_RECEIPT_COLLISION",
    );
    return receipt;
  }

  /** Receipt validation is a pure state transition. It accepts a structured
   * official (or deny-effects fixture) receipt but never calls a provider,
   * starts a worker, launches consent, or prepares live execution. */
  async validateStructuredReceipt(receiptInput: unknown): Promise<ReleaseCertificationResult> {
    const current = await this.#loadCurrent();
    if (current.state.status !== "authorization_required" || !current.state.authorizationRequestSha256) {
      throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    }
    const request = await this.#readRequest(current.state.authorizationRequestSha256);
    let receipt: ReleaseAuthorizationReceipt;
    try { receipt = await validateAuthorizationReceipt({ request, receipt: receiptInput, nowMs: this.#now() }); }
    catch { throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID"); }
    await createOrVerify(
      join(this.#workspace, "authorization-receipts", `${receipt.authorizationReceiptSha256}.json`),
      `${canonicalJson(receipt)}\n`,
      "RELEASE_CONTROLLER_AUTHORIZATION_RECEIPT_COLLISION",
    );
    const state = await this.#advanceLive(current.state, "receipt_valid", receipt.authorizationReceiptSha256, [], null, null);
    return { exitCode: 1, state, authorizationRequest: request };
  }

  /** Local-only composition path. The protected runner injects authenticated ports later;
   * this controller neither constructs them nor writes certification evidence. */
  async provision(input: Readonly<{ receipt: unknown; registry: AuthorizedProviderRegistry }>): Promise<ReleaseProvisioningResult> {
    if (!isObservedCollectorRegistryImage(this.#collectorImage)) throw new Error("COLLECTOR_REGISTRY_OBSERVATION_REQUIRED");
    const current = await this.#loadCurrent();
    if (!current.state.authorizationRequestSha256) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    const request = await this.#readRequest(current.state.authorizationRequestSha256);
    let receipt: ReleaseAuthorizationReceipt;
    try { receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs: this.#now() }); }
    catch { throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID"); }

    if (["topology_ready", "materializing", "protected_suite_running", "finalizing", "cleaning", "completed"].includes(current.state.status) && current.state.deployedTopologySha256) {
      await this.#assertStateOperationBindings(current.state, request);
      return { state: current.state, authorizationRequest: request, topology: await this.#readTopology(current.state.deployedTopologySha256) };
    }
    if (!["authorization_required", "receipt_valid", "bootstrap", "provisioning", "discovering_deployed", "observing"].includes(current.state.status)) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");

    const operations = await Promise.all(request.orderedEffects.map(async (effect) => ReleaseProviderOperationSchema.parse({
      version: 1,
      operationId: `op-${await digest({ candidateSha256: current.state.candidate.candidateSha256, authorizationRequestSha256: request.authorizationRequestSha256, provider: effect.provider, effectId: effect.id, desiredDigest: request.effectPlanSha256 })}`,
      provider: effect.provider, effectId: effect.id, operation: effect.operation,
      region: effect.provider === "cloud_run" || effect.provider === "collector" ? "europe-west1" : "global",
      desiredDigest: await digest({ effect, effectPlanSha256: request.effectPlanSha256 }),
      candidateSha256: current.state.candidate.candidateSha256,
      authorizationRequestSha256: request.authorizationRequestSha256,
    })));
    if (operations.length !== RELEASE_PROVIDER_IDS.length || new Set(operations.map((operation) => operation.provider)).size !== RELEASE_PROVIDER_IDS.length) throw new Error("RELEASE_CONTROLLER_TOPOLOGY_INVALID");

    const operationRecordSha256s: string[] = [];
    for (const operation of operations) {
      const currentIndex = current.state.providerOperationIds.indexOf(operation.operationId);
      const currentRecordSha256 = currentIndex >= 0 ? current.state.providerOperationRecordSha256s?.[currentIndex] : undefined;
      if (currentRecordSha256) {
        const existing = await this.#readOperationRecord(currentRecordSha256);
        this.#assertOperationAuthorization(existing, operation, request);
        operationRecordSha256s.push(existing.recordSha256);
        continue;
      }
      try {
        const existing = await this.#readLegacyOperation(operation.operationId);
        this.#assertOperationAuthorization(existing, operation, request);
        if (existing.version !== 3) throw new Error("RELEASE_CONTROLLER_OPERATION_LEGACY_UNTRUSTED");
        operationRecordSha256s.push(existing.recordSha256);
      } catch (error) {
        if (error instanceof Error && (error.message === "RELEASE_CONTROLLER_OPERATION_COLLISION" || error.message === "RELEASE_CONTROLLER_OPERATION_LEGACY_UNTRUSTED" || error.message === "RELEASE_CONTROLLER_COST_RESERVATION_INVALID")) throw error;
        const effect = request.orderedEffects.find((item) => item.id === operation.effectId && item.provider === operation.provider);
        const scope = request.providerScopes.find((item) => item.provider === operation.provider);
        if (!effect || !scope || !Number.isSafeInteger(effect.estimatedCostMicros) || effect.estimatedCostMicros < 0) throw new Error("RELEASE_CONTROLLER_COST_RESERVATION_INVALID");
        const initial = await this.#appendOperation({ version: 3, operation, status: "pending", billingStatus: "unknown", reservedCostMicros: effect.estimatedCostMicros, actualCostMicros: null, costObservation: null, costObservationSha256: null, accountScopeSha256: scope.accountScopeSha256, projectScopeSha256: scope.projectScopeSha256, resourceIdentitySha256: null, priorRecordSha256: null });
        await createOrVerify(join(this.#workspace, "provider-operations", `${operation.operationId}.json`), `${canonicalJson(initial)}\n`, "RELEASE_CONTROLLER_OPERATION_COLLISION");
        operationRecordSha256s.push(initial.recordSha256);
      }
    }
    let state = current.state;
    if (state.providerOperationRecordSha256s) {
      if (state.providerOperationRecordSha256s.length !== operations.length || !state.providerOperationRecordSha256s.every((value, index) => value === operationRecordSha256s[index])) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
    }
    if (["authorization_required", "receipt_valid", "bootstrap"].includes(state.status)) state = await this.#advance(state, "provisioning", receipt.authorizationReceiptSha256, operations.map((operation) => operation.operationId), null, null, operationRecordSha256s);

    let totalCost = 0;
    let reservedCost = 0;
    for (const [index, operation] of operations.entries()) {
      const record = await this.#currentOperation(state, operation, request);
      if (record.version !== 3) throw new Error("RELEASE_CONTROLLER_OPERATION_LEGACY_UNTRUSTED");
      const reservation = record.reservedCostMicros;
      reservedCost += reservation;
      if (reservedCost > receipt.maximumAuthorizedCostMicros) throw new Error("RELEASE_CONTROLLER_COST_RESERVATION_EXCEEDED");
      if (record.status === "completed") { totalCost += record.actualCostMicros ?? 0; continue; }
      // Claim dispatch durably before planning or applying. A restart or
      // concurrent loser observes this original operation only; absence or a
      // timeout is not native proof that a paid effect was never dispatched.
      let result;
      if (record.status === "pending") {
        if (await this.#claimDispatch(state, record)) {
          try { await input.registry.plan({ receipt, operation }); }
          catch {
            await this.#advance(state, "blocked", receipt.authorizationReceiptSha256, operations.map((item) => item.operationId), null, "PROVIDER_UNAVAILABLE");
            throw new Error("RELEASE_CONTROLLER_PROVIDER_BLOCKED");
          }
          result = await input.registry.apply({ receipt, operation, approvedMaximumCostMicros: receipt.maximumAuthorizedCostMicros });
        } else {
          result = await input.registry.observe({ receipt, operation, approvedMaximumCostMicros: receipt.maximumAuthorizedCostMicros });
        }
      } else {
        result = await input.registry.observe({ receipt, operation, approvedMaximumCostMicros: receipt.maximumAuthorizedCostMicros });
      }
      if (record.status === "unknown" && record.resourceIdentitySha256 && result.resourceIdentitySha256
        && record.resourceIdentitySha256 !== result.resourceIdentitySha256) {
        throw new Error("RELEASE_CONTROLLER_PROVIDER_DRIFT");
      }
      const billingPatch = await this.#billingPatch(record, result);
      if (result.status === "unknown" || result.status === "pending") {
        const { recordSha256, ...base } = record;
        const next = await this.#appendOperation({ ...base, status: "unknown", ...billingPatch, resourceIdentitySha256: result.resourceIdentitySha256 ?? null, priorRecordSha256: recordSha256 });
        operationRecordSha256s[index] = next.recordSha256;
        state = await this.#advance(state, "provisioning", receipt.authorizationReceiptSha256, operations.map((item) => item.operationId), null, null, operationRecordSha256s);
        throw new Error("RELEASE_CONTROLLER_PROVIDER_AMBIGUOUS");
      }
      if (result.status !== "applied" && result.status !== "completed") throw new Error("RELEASE_CONTROLLER_PROVIDER_BLOCKED");
      const actualCostMicros = result.actualCostMicros ?? 0;
      totalCost += actualCostMicros;
      if (totalCost > receipt.maximumAuthorizedCostMicros) {
        const { recordSha256, ...base } = record;
        const next = await this.#appendOperation({ ...base, status: "completed", ...billingPatch, resourceIdentitySha256: result.resourceIdentitySha256 ?? null, priorRecordSha256: recordSha256 });
        operationRecordSha256s[index] = next.recordSha256;
        await this.#advance(state, "blocked", receipt.authorizationReceiptSha256, operations.map((operation) => operation.operationId), null, "COST_EXCEEDED", operationRecordSha256s);
        throw new Error("RELEASE_CONTROLLER_COST_EXCEEDED");
      }
      if (!result.resourceIdentitySha256) throw new Error("RELEASE_CONTROLLER_PROVIDER_DRIFT");
      const { recordSha256, ...base } = record;
      const next = await this.#appendOperation({ ...base, status: "completed", ...billingPatch, resourceIdentitySha256: result.resourceIdentitySha256, priorRecordSha256: recordSha256 });
      operationRecordSha256s[index] = next.recordSha256;
      state = await this.#advance(state, "provisioning", receipt.authorizationReceiptSha256, operations.map((item) => item.operationId), null, null, operationRecordSha256s);
    }

    state = await this.#advance(state, state.version === 2 ? "observing" : "discovering_deployed", receipt.authorizationReceiptSha256, operations.map((operation) => operation.operationId), null, null, operationRecordSha256s);
    const discovered = await Promise.all(operations.map((operation) => input.registry.discover(operation.provider)));
    if (discovered.some((item) => item.capability !== "available" || item.authentication !== "authorized")) {
      await this.#advance(state, "blocked", receipt.authorizationReceiptSha256, operations.map((operation) => operation.operationId), null, "PROVIDER_UNAVAILABLE");
      throw new Error("RELEASE_CONTROLLER_PROVIDER_DRIFT");
    }
    const resources = await Promise.all(operations.map(async (operation, index) => {
      const record = await this.#currentOperation(state, operation, request);
      if (record.status !== "completed" || !record.resourceIdentitySha256) throw new Error("RELEASE_CONTROLLER_PROVIDER_DRIFT");
      return {
        provider: operation.provider, operationId: operation.operationId, region: operation.region, desiredDigest: operation.desiredDigest,
        configDigest: operation.desiredDigest, resourceIdentitySha256: record.resourceIdentitySha256,
        capability: discovered[index]!.capability, status: "observed" as const,
      };
    }));
    const desired = await deriveReleaseTopology(current.state.candidate.candidateSha256, this.#collectorImage);
    const { topologySha256: _desiredTopologySha256, ...topologyBase } = desired;
    const deployment = {
      resources,
      routing: { activeRegions: desired.controlPlane.regions, standby: "none" as const },
      failureDomains: ["control-plane-region", "authoritative-database", "worker-provider"],
      rtoMinutes: 60, rpoMinutes: 60,
      limitations: ["DATABASE_CONTINUITY_NOT_CERTIFIED", "OBJECT_STORE_FAILOVER_NOT_CERTIFIED", "WORKER_CONTINUITY_NOT_CERTIFIED", "LIVE_DRILL_REQUIRED"] as const,
    };
    const topology = ReleaseTopologyObservationSchema.parse({ ...topologyBase, deployment, topologySha256: await digest({ ...topologyBase, deployment }) }) as ReleaseProvisioningResult["topology"];
    await createOrVerify(join(this.#workspace, "topologies", `${topology.topologySha256}.json`), `${canonicalJson(topology)}\n`, "RELEASE_CONTROLLER_TOPOLOGY_COLLISION");
    state = await this.#advance(state, "topology_ready", receipt.authorizationReceiptSha256, operations.map((operation) => operation.operationId), topology.topologySha256, null);
    return { state, authorizationRequest: request, topology };
  }

  /**
   * The only same-run live path.  It accepts project-owned native handles and
   * real protected ports, but never creates a client, reads credentials, or
   * substitutes an evaluator.  Each stage is content-addressed before the
   * next external boundary, so a new controller instance reconciles the
   * original provider operation rather than replacing it.
   */
  async executeAuthorized(input: AuthorizedLiveExecutionInput): Promise<AuthorizedLiveExecutionResult> {
    const current = await this.#loadCurrent();
    if (!current.state.authorizationRequestSha256) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    const request = await this.#readRequest(current.state.authorizationRequestSha256);
    let receipt: ReleaseAuthorizationReceipt;
    try { receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs: this.#now() }); }
    catch { throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID"); }

    let state = current.state;
    if (state.status === "authorization_required") {
      state = await this.#advanceLive(state, "receipt_valid", receipt.authorizationReceiptSha256, [], null, null);
    }
    if (state.authorizationReceiptSha256 !== receipt.authorizationReceiptSha256) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    if (state.status === "receipt_valid") {
      // Bootstrap is journalled as a state boundary before the native registry
      // sees any operation. No provider is called by this transition.
      state = await this.#advanceLive(state, "bootstrap", receipt.authorizationReceiptSha256, state.providerOperationIds, null, null);
    }

    const provisioned = await this.provision({ receipt, registry: input.registry });
    state = provisioned.state;
    if (state.status === "topology_ready") {
      state = await this.#advanceLive(state, "materializing", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, null);
    }
    if (state.status !== "materializing" && state.status !== "protected_suite_running" && state.status !== "finalizing" && state.status !== "cleaning" && state.status !== "completed") {
      throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    }

    const materialized = await materializeProtectedCertifier({
      ...input.materialization,
      topology: provisioned.topology,
      authorization: { authorizationReceiptSha256: receipt.authorizationReceiptSha256, authorizationRequestSha256: request.authorizationRequestSha256 },
      workerSelection: input.workerSelection,
      nowMs: this.#now(),
    });
    if (state.status === "materializing") {
      state = await this.#advanceLive(state, "protected_suite_running", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, null);
    }

    const protectedRegistry = createProductionLiveProtectedCertificationRegistry(input.protected);
    const profile = {
      candidate: input.protected.candidate,
      datasetSha256: input.protected.input.datasetSha256,
      topologySha256: provisioned.topology.topologySha256,
      profileSha256: input.protected.input.profileSha256,
      releaseBinding: input.protected.releaseBinding,
      protectedVerificationReferences: input.protectedVerificationReferences,
      credentialsAvailable: true,
    } as const;
    const records: CertificationObservation[] = [];
    for (const suite of PROTECTED_SUITES) {
      let record = await readProtectedRecord({
        workspace: this.#workspace, suite, candidateId: state.candidate.candidateSha256,
        topologySha256: provisioned.topology.topologySha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256, nowMs: this.#now(),
      });
      if (!record) {
        const run = await runProtectedCertificationProfile({
          profile, selectedSuites: [suite], evidenceDirectory: materialized.evidenceDirectory,
          registry: protectedRegistry, requireExactRegistry: true, now: this.#now,
        });
        record = run.records[0];
        if (!record) throw new Error("RELEASE_CONTROLLER_PROTECTED_SET_INVALID");
        await createOrVerify(join(this.#workspace, "protected-records", `${suite}.json`), `${canonicalJson({ version: 1, candidateSha256: state.candidate.candidateSha256, topologySha256: provisioned.topology.topologySha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256, record })}\n`, "RELEASE_CONTROLLER_PROTECTED_RECORD_COLLISION");
      }
      records.push(record);
    }
    const protectedRun: ProtectedCertificationRun = {
      records,
      status: records.every((record) => record.status === "passed") ? "passed" : records.some((record) => record.status === "failed") ? "failed" : "blocked",
    };
    // The controller commits each suite index before the next suite dispatch.
    if (protectedRun.records.length !== PROTECTED_SUITES.length || new Set(protectedRun.records.map((record) => record.input.command[1])).size !== PROTECTED_SUITES.length) {
      await this.#advanceLive(state, "blocked", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, "EVIDENCE_INVALID");
      throw new Error("RELEASE_CONTROLLER_PROTECTED_SET_INVALID");
    }
    if (protectedRun.status !== "passed") {
      await this.#advanceLive(state, "blocked", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, "PROTECTED_SUITE_BLOCKED");
      throw new Error("RELEASE_CONTROLLER_PROTECTED_SUITE_BLOCKED");
    }
    if (!input.finalization) {
      await this.#advanceLive(state, "blocked", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, "EVIDENCE_INVALID");
      throw new Error("RELEASE_CONTROLLER_FINALIZATION_INPUT_REQUIRED");
    }
    await this.#assertCostsObserved(state, request, receipt.maximumAuthorizedCostMicros);
    state = await this.#advanceLive(state, "finalizing", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, null);
    const finalization = await finalizeReleaseCertification({
      ...input.finalization,
      workspace: this.#workspace,
      candidateId: state.candidate.candidateSha256,
      topologySha256: provisioned.topology.topologySha256,
      authorizationReceiptSha256: receipt.authorizationReceiptSha256,
      protectedRecords: protectedRun.records,
    });
    if (finalization.status !== "promoted") {
      await this.#advanceLive(state, "blocked", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, finalization.status === "cleanup_incomplete" ? "PROTECTED_SUITE_BLOCKED" : "EVIDENCE_INVALID");
      throw new Error(finalization.status === "cleanup_incomplete" ? "RELEASE_CONTROLLER_CLEANUP_INCOMPLETE" : "RELEASE_CONTROLLER_FINALIZATION_BLOCKED");
    }
    state = await this.#advanceLive(state, "cleaning", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, null);
    state = await this.#advanceLive(state, "completed", receipt.authorizationReceiptSha256, state.providerOperationIds, provisioned.topology.topologySha256, null);
    return { ...provisioned, state, materialized, protected: protectedRun, finalization };
  }

  async #advance(prior: ReleaseControllerState, status: ReleaseControllerState["status"], authorizationReceiptSha256: string, providerOperationIds: string[], deployedTopologySha256: string | null, blockReasonCode: ReleaseControllerState["blockReasonCode"], providerOperationRecordSha256s = prior.providerOperationRecordSha256s): Promise<ReleaseControllerState> {
    const { stateSha256: _priorStateSha256, ...priorState } = prior;
    const next = await stateFor({
      ...priorState, status, priorStateSha256: prior.stateSha256, authorizationReceiptSha256,
      providerOperationIds, ...(providerOperationRecordSha256s ? { providerOperationRecordSha256s } : {}), deployedTopologySha256, blockReasonCode, createdAtMs: this.#now(),
    });
    await createOrVerify(join(this.#workspace, "states", `${next.stateSha256}.json`), `${canonicalJson(next)}\n`, "RELEASE_CONTROLLER_STATE_COLLISION");
    return this.#commitStateTransition(prior.stateSha256, next);
  }

  async #advanceLive(prior: ReleaseControllerState, status: Extract<ReleaseControllerState["status"], "receipt_valid" | "bootstrap" | "materializing" | "protected_suite_running" | "finalizing" | "cleaning" | "completed" | "blocked">, authorizationReceiptSha256: string, providerOperationIds: string[], deployedTopologySha256: string | null, blockReasonCode: ReleaseControllerState["blockReasonCode"]): Promise<ReleaseControllerState> {
    const { stateSha256: _priorStateSha256, ...priorState } = prior;
    const next = await stateFor({
      ...priorState, version: 2, status, priorStateSha256: prior.stateSha256, authorizationReceiptSha256,
      providerOperationIds, deployedTopologySha256, blockReasonCode, createdAtMs: this.#now(),
    });
    await createOrVerify(join(this.#workspace, "states", `${next.stateSha256}.json`), `${canonicalJson(next)}\n`, "RELEASE_CONTROLLER_STATE_COLLISION");
    return this.#commitStateTransition(prior.stateSha256, next);
  }

  async #writeCurrent(state: ReleaseControllerState): Promise<void> {
    const pointerBase = { version: 1 as const, stateSha256: state.stateSha256, candidateSha256: state.candidate.candidateSha256 };
    await writeFile(join(this.#workspace, "current.json"), `${canonicalJson({ ...pointerBase, pointerSha256: await digest(pointerBase) })}\n`, "utf8");
  }

  async #loadCurrent(): Promise<Readonly<{ state: ReleaseControllerState; pointer: z.infer<typeof ReleaseControllerCurrentPointerSchema> }>> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "current.json"), "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_POINTER_INVALID"); }
    const pointer = ReleaseControllerCurrentPointerSchema.safeParse(raw);
    if (!pointer.success || pointer.data.pointerSha256 !== await digest(withoutDigest(pointer.data, "pointerSha256"))) throw new Error("RELEASE_CONTROLLER_POINTER_INVALID");
    let state = await this.#readState(pointer.data.stateSha256);
    const seen = new Set<string>();
    while (true) {
      if (seen.has(state.stateSha256)) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
      seen.add(state.stateSha256);
      const transition = await this.#readStateTransition(state.stateSha256);
      if (!transition) break;
      state = await this.#readState(transition.nextStateSha256);
    }
    if (state.candidate.candidateSha256 !== pointer.data.candidateSha256) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    return { state, pointer: pointer.data };
  }

  async #commitStateTransition(priorStateSha256: string, next: ReleaseControllerState): Promise<ReleaseControllerState> {
    const base = { version: 1 as const, priorStateSha256, nextStateSha256: next.stateSha256 };
    const transition: StateTransition = { ...base, transitionSha256: await digest(base) };
    const path = join(this.#workspace, "state-transitions", `${priorStateSha256}.json`);
    const outcome = await createSynced(path, `${canonicalJson(transition)}\n`);
    if (outcome === "created") return next;
    const existing = await this.#readStateTransition(priorStateSha256);
    if (!existing || existing.nextStateSha256 !== next.stateSha256) throw new Error("RELEASE_CONTROLLER_STATE_RACE");
    return this.#readState(existing.nextStateSha256);
  }

  async #readStateTransition(priorStateSha256: string): Promise<StateTransition | undefined> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "state-transitions", `${priorStateSha256}.json`), "utf8")); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    }
    const parsed = z.object({ version: z.literal(1), priorStateSha256: DigestSchema, nextStateSha256: DigestSchema, transitionSha256: DigestSchema }).strict().safeParse(raw);
    if (!parsed.success || parsed.data.priorStateSha256 !== priorStateSha256 || parsed.data.transitionSha256 !== await digest(withoutDigest(parsed.data, "transitionSha256"))) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    return parsed.data;
  }

  async #claimDispatch(state: ReleaseControllerState, record: CurrentProviderOperationRecord): Promise<boolean> {
    const base = {
      version: 1 as const, stateSha256: state.stateSha256, recordSha256: record.recordSha256,
      operation: record.operation, reservedCostMicros: record.reservedCostMicros,
      accountScopeSha256: record.accountScopeSha256, projectScopeSha256: record.projectScopeSha256,
    };
    const claim: DispatchClaim = { ...base, dispatchClaimSha256: await digest(base) };
    const path = join(this.#workspace, "provider-dispatch-claims", `${record.operation.operationId}.json`);
    const outcome = await createSynced(path, `${canonicalJson(claim)}\n`);
    if (outcome === "created") return true;
    let raw: unknown;
    try { raw = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_DISPATCH_CLAIM_INVALID"); }
    const parsed = z.object({ version: z.literal(1), stateSha256: DigestSchema, recordSha256: DigestSchema, operation: ReleaseProviderOperationSchema, reservedCostMicros: z.number().int().nonnegative(), accountScopeSha256: DigestSchema, projectScopeSha256: DigestSchema, dispatchClaimSha256: DigestSchema }).strict().safeParse(raw);
    if (!parsed.success || parsed.data.dispatchClaimSha256 !== await digest(withoutDigest(parsed.data, "dispatchClaimSha256"))
      || canonicalJson(parsed.data.operation) !== canonicalJson(record.operation)
      || parsed.data.reservedCostMicros !== record.reservedCostMicros
      || parsed.data.accountScopeSha256 !== record.accountScopeSha256
      || parsed.data.projectScopeSha256 !== record.projectScopeSha256) {
      throw new Error("RELEASE_CONTROLLER_DISPATCH_CLAIM_INVALID");
    }
    return false;
  }

  async #readLegacyOperation(operationId: string): Promise<ProviderOperationRecord> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "provider-operations", `${operationId}.json`), "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID"); }
    const schema = z.union([
      z.object({ version: z.literal(1), operation: ReleaseProviderOperationSchema, status: z.enum(["pending", "unknown", "completed"]), actualCostMicros: z.number().int().nonnegative(), resourceIdentitySha256: DigestSchema.nullable() }).strict(),
      z.object({ version: z.literal(2), operation: ReleaseProviderOperationSchema, status: z.enum(["pending", "unknown", "completed"]), billingStatus: z.enum(["unknown", "observed"]), reservedCostMicros: z.number().int().nonnegative(), actualCostMicros: z.number().int().nonnegative().nullable(), costObservation: ReleaseProviderCostObservationSchema.nullable(), costObservationSha256: DigestSchema.nullable(), accountScopeSha256: DigestSchema, projectScopeSha256: DigestSchema, resourceIdentitySha256: DigestSchema.nullable() }).strict(),
      z.object({ version: z.literal(3), operation: ReleaseProviderOperationSchema, status: z.enum(["pending", "unknown", "completed"]), billingStatus: z.enum(["unknown", "observed"]), reservedCostMicros: z.number().int().nonnegative(), actualCostMicros: z.number().int().nonnegative().nullable(), costObservation: ReleaseProviderCostObservationSchema.nullable(), costObservationSha256: DigestSchema.nullable(), accountScopeSha256: DigestSchema, projectScopeSha256: DigestSchema, resourceIdentitySha256: DigestSchema.nullable(), priorRecordSha256: DigestSchema.nullable(), recordSha256: DigestSchema }).strict(),
    ]);
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.operation.operationId !== operationId) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
    if (parsed.data.version === 3 && parsed.data.recordSha256 !== await digest(withoutDigest(parsed.data, "recordSha256"))) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
    return parsed.data;
  }

  async #appendOperation(record: Omit<CurrentProviderOperationRecord, "recordSha256">): Promise<CurrentProviderOperationRecord> {
    const next = { ...record, recordSha256: await digest(record) } as CurrentProviderOperationRecord;
    await createOrVerify(join(this.#workspace, "provider-operation-records", `${next.recordSha256}.json`), `${canonicalJson(next)}\n`, "RELEASE_CONTROLLER_OPERATION_RECORD_COLLISION");
    return next;
  }

  async #readOperationRecord(recordSha256: string): Promise<CurrentProviderOperationRecord> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "provider-operation-records", `${recordSha256}.json`), "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID"); }
    const record = await this.#readRecordValue(raw);
    if (record.recordSha256 !== recordSha256) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
    if (record.priorRecordSha256) {
      const prior = await this.#readOperationRecord(record.priorRecordSha256);
      if (canonicalJson(prior.operation) !== canonicalJson(record.operation)) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
    }
    return record;
  }

  async #readRecordValue(raw: unknown): Promise<CurrentProviderOperationRecord> {
    const parsed = z.object({ version: z.literal(3), operation: ReleaseProviderOperationSchema, status: z.enum(["pending", "unknown", "completed"]), billingStatus: z.enum(["unknown", "observed"]), reservedCostMicros: z.number().int().nonnegative(), actualCostMicros: z.number().int().nonnegative().nullable(), costObservation: ReleaseProviderCostObservationSchema.nullable(), costObservationSha256: DigestSchema.nullable(), accountScopeSha256: DigestSchema, projectScopeSha256: DigestSchema, resourceIdentitySha256: DigestSchema.nullable(), priorRecordSha256: DigestSchema.nullable(), recordSha256: DigestSchema }).strict().safeParse(raw);
    if (!parsed.success || parsed.data.recordSha256 !== await digest(withoutDigest(parsed.data, "recordSha256"))) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
    return parsed.data;
  }

  #assertOperationAuthorization(record: ProviderOperationRecord, operation: ReleaseProviderOperation, request: ReleaseAuthorizationRequest): void {
    const effect = request.orderedEffects.find((item) => item.id === operation.effectId && item.provider === operation.provider && item.operation === operation.operation);
    const scope = request.providerScopes.find((item) => item.provider === operation.provider);
    if (!effect || !scope || canonicalJson(record.operation) !== canonicalJson(operation)) throw new Error("RELEASE_CONTROLLER_OPERATION_COLLISION");
    if (record.version === 1) return;
    if (record.reservedCostMicros !== effect.estimatedCostMicros
      || record.accountScopeSha256 !== scope.accountScopeSha256
      || record.projectScopeSha256 !== scope.projectScopeSha256) {
      throw new Error("RELEASE_CONTROLLER_COST_RESERVATION_INVALID");
    }
  }

  async #currentOperation(state: ReleaseControllerState, operation: ReleaseProviderOperation, request: ReleaseAuthorizationRequest): Promise<ProviderOperationRecord> {
    const index = state.providerOperationIds.indexOf(operation.operationId);
    const recordSha256 = index >= 0 ? state.providerOperationRecordSha256s?.[index] : undefined;
    const record = recordSha256 ? await this.#readOperationRecord(recordSha256) : await this.#readLegacyOperation(operation.operationId);
    this.#assertOperationAuthorization(record, operation, request);
    return record;
  }

  async #assertStateOperationBindings(state: ReleaseControllerState, request: ReleaseAuthorizationRequest): Promise<void> {
    if (!state.providerOperationRecordSha256s || state.providerOperationRecordSha256s.length !== state.providerOperationIds.length) throw new Error("RELEASE_CONTROLLER_OPERATION_LEGACY_UNTRUSTED");
    for (const [index, operationId] of state.providerOperationIds.entries()) {
      const record = await this.#readOperationRecord(state.providerOperationRecordSha256s[index]!);
      if (record.operation.operationId !== operationId) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
      this.#assertOperationAuthorization(record, record.operation, request);
    }
  }

  async #assertCostsObserved(state: ReleaseControllerState, request: ReleaseAuthorizationRequest, _maximumAuthorizedCostMicros: number): Promise<void> {
    if (!state.providerOperationRecordSha256s || state.providerOperationRecordSha256s.length !== state.providerOperationIds.length) throw new Error("RELEASE_CONTROLLER_PROVIDER_COST_UNOBSERVED");
    for (const [index, operationId] of state.providerOperationIds.entries()) {
      const record = await this.#readOperationRecord(state.providerOperationRecordSha256s[index]!);
      if (record.operation.operationId !== operationId) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
      this.#assertOperationAuthorization(record, record.operation, request);
      if (record.billingStatus === "observed") throw new Error("RELEASE_CONTROLLER_PROVIDER_COST_REPORT_TRANSPORT_UNAVAILABLE");
      if (record.actualCostMicros !== null || record.costObservation !== null || record.costObservationSha256 !== null) {
        throw new Error("RELEASE_CONTROLLER_PROVIDER_COST_OBSERVATION_INVALID");
      }
      throw new Error("RELEASE_CONTROLLER_PROVIDER_COST_UNOBSERVED");
    }
  }

  async #billingPatch(record: CurrentProviderOperationRecord, result: Readonly<{
    actualCostMicros?: number;
    resourceIdentitySha256?: string;
    costObservation?: Readonly<{
      version: 1;
      provider: ReleaseProviderId;
      operationId: string;
      candidateSha256: string;
      authorizationRequestSha256: string;
      resourceIdentitySha256: string;
      accountScopeSha256: string;
      projectScopeSha256: string;
      rawReportSha256: string;
      intervalStartMs: number;
      intervalEndMs: number;
      observedAtMs: number;
      actualCostMicros: number;
    }>;
  }>): Promise<Pick<CurrentProviderOperationRecord, "billingStatus" | "actualCostMicros" | "costObservation" | "costObservationSha256">> {
    if (result.actualCostMicros === undefined && result.costObservation === undefined) {
      /* A persisted self-report from an older/forged record never survives a
       * generic reconciliation pass as actual billing evidence. */
      return { billingStatus: "unknown", actualCostMicros: null, costObservation: null, costObservationSha256: null };
    }
    /* No generic registry result can establish actual billing. An authenticated
     * provider-report adapter must first persist and verify provider-returned
     * material; until then the controller never self-hashes a port claim into
     * settled cost. */
    throw new Error("RELEASE_CONTROLLER_PROVIDER_COST_REPORT_TRANSPORT_UNAVAILABLE");
  }

  async #readTopology(topologySha256: string): Promise<ReleaseProvisioningResult["topology"]> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "topologies", `${topologySha256}.json`), "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_TOPOLOGY_INVALID"); }
    const topology = ReleaseTopologyObservationSchema.safeParse(raw);
    if (!topology.success || !topology.data.deployment || topology.data.topologySha256 !== topologySha256) throw new Error("RELEASE_CONTROLLER_TOPOLOGY_INVALID");
    const { topologySha256: stored, ...withoutTopologySha256 } = topology.data;
    if (stored !== await digest(withoutTopologySha256)) throw new Error("RELEASE_CONTROLLER_TOPOLOGY_INVALID");
    return topology.data as ReleaseProvisioningResult["topology"];
  }

  async #readState(stateSha256: string, seen = new Set<string>()): Promise<ReleaseControllerState> {
    if (seen.has(stateSha256)) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    seen.add(stateSha256);
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "states", `${stateSha256}.json`), "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_STATE_INVALID"); }
    const state = ReleaseControllerStateSchema.safeParse(raw);
    if (!state.success || state.data.stateSha256 !== stateSha256 || state.data.stateSha256 !== await digest(withoutDigest(state.data, "stateSha256"))) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    if (state.data.providerOperationRecordSha256s && state.data.providerOperationRecordSha256s.length !== state.data.providerOperationIds.length) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    if (state.data.status === "discovering" && (state.data.priorStateSha256 !== null || state.data.authorizationRequestSha256 !== null)) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    if (state.data.status === "authorization_required") {
      if (!state.data.priorStateSha256 || !state.data.authorizationRequestSha256) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
      const prior = await this.#readState(state.data.priorStateSha256, seen);
      if (prior.status !== "discovering" || prior.authorizationRequestSha256 !== null || prior.candidate.candidateSha256 !== state.data.candidate.candidateSha256 || prior.topologySha256 !== state.data.topologySha256 || prior.createdAtMs > state.data.createdAtMs || canonicalJson(prior.capabilities) !== canonicalJson(state.data.capabilities)) {
        throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
      }
    }
    if (state.data.version === 2) {
      if (!state.data.priorStateSha256 || !state.data.authorizationRequestSha256 || !state.data.authorizationReceiptSha256
        || !["receipt_valid", "bootstrap", "provisioning", "observing", "topology_ready", "materializing", "protected_suite_running", "finalizing", "cleaning", "completed", "blocked"].includes(state.data.status)) {
        throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
      }
      const prior = await this.#readState(state.data.priorStateSha256, seen);
      if (prior.candidate.candidateSha256 !== state.data.candidate.candidateSha256 || prior.topologySha256 !== state.data.topologySha256
        || prior.createdAtMs > state.data.createdAtMs || (state.data.status === "receipt_valid" && prior.status !== "authorization_required")
        || (state.data.status !== "receipt_valid" && prior.version !== 2 && !(state.data.status === "materializing" && prior.status === "topology_ready"))
        || (prior.authorizationReceiptSha256 !== null && prior.authorizationReceiptSha256 !== state.data.authorizationReceiptSha256)) {
        throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
      }
    }
    return state.data;
  }

  async #readRequest(authorizationRequestSha256: string): Promise<ReleaseAuthorizationRequest> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "authorization-requests", `${authorizationRequestSha256}.json`), "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID"); }
    try {
      const request = await validateAuthorizationRequest(raw);
      if (request.authorizationRequestSha256 !== authorizationRequestSha256) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
      return request;
    } catch { throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID"); }
  }
}

export async function runReleaseCertification(options: ControllerOptions & Readonly<{ dryRun: true }>): Promise<ReleaseCertificationResult>;
export async function runReleaseCertification(options: ControllerOptions & Readonly<{ dryRun: false; session: ReleaseExecutionSession }>): Promise<AuthorizedLiveExecutionResult>;
export async function runReleaseCertification(options: ControllerOptions & Readonly<{ dryRun: boolean; session?: ReleaseExecutionSession }>): Promise<ReleaseCertificationResult | AuthorizedLiveExecutionResult> {
  if (!options.dryRun) {
    if (!options.session) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED");
    const preapprovalCollector = options.collectorImage;
    const controller = new ReleaseCertificationController({
      candidatePath: options.candidatePath,
      workspace: options.workspace,
      providers: createReleaseControllerProviderRegistry(options.session.registry),
      ...(options.collectorImage ? { collectorImage: options.collectorImage } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const pending = await controller.dryRun();
    const collectorImage = preapprovalCollector && !isObservedCollectorRegistryImage(preapprovalCollector)
      ? await options.session.collectorImage?.uploadAndObserve({ authorizationRequest: pending.authorizationRequest, collector: preapprovalCollector })
      : preapprovalCollector;
    if (!isObservedCollectorRegistryImage(collectorImage)) throw new Error("COLLECTOR_REGISTRY_OBSERVATION_REQUIRED");
    const observedController = new ReleaseCertificationController({
      candidatePath: options.candidatePath, workspace: options.workspace,
      providers: createReleaseControllerProviderRegistry(options.session.registry), collectorImage,
      ...(options.now ? { now: options.now } : {}),
    });
    const execution = await options.session.prepareAuthorizedExecution({ authorizationRequest: pending.authorizationRequest });
    return observedController.executeAuthorized({ ...execution, registry: options.session.registry });
  }
  const progress = await new ReleaseCertificationController(options).certify();
  return progress;
}
