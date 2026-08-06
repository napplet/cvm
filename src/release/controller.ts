import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import {
  ProviderCapabilityObservationSchema,
  ReleaseAuthorizationRequestSchema,
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
import { deriveReleaseTopology, RELEASE_PROVIDER_IDS } from "./topology";
import { ReleaseAuthorizationReceiptSchema, ReleaseProviderOperationSchema, type ReleaseAuthorizationReceipt, type ReleaseProviderOperation, type ReleaseProviderRegistry as AuthorizedProviderRegistry } from "./providers";

export const RELEASE_WORKSPACE_ENV = "NAPPLET_CVM_RELEASE_WORKSPACE";
export const RELEASE_AUTHORIZATION_SHA256_ENV = "NAPPLET_CVM_RELEASE_AUTHORIZATION_SHA256";
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());

type CandidateIdentity = ReleaseControllerState["candidate"];
type ControllerOptions = Readonly<{
  candidatePath: string;
  workspace: string;
  providers?: ReleaseProviderRegistry;
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

type ProviderOperationRecord = Readonly<{
  version: 1;
  operation: ReleaseProviderOperation;
  status: "pending" | "unknown" | "completed";
  actualCostMicros: number;
  resourceIdentitySha256: string | null;
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
  return observations.sort((left, right) => left.provider.localeCompare(right.provider));
}

async function effectPlan(candidateSha256: string, topologySha256: string) {
  const effects = [
    ["cloud-run-ingress", "cloud_run", "create_or_update", 5_000_000], ["gcs-retention", "gcs", "configure", 500_000],
    ["collector", "collector", "create_or_update", 500_000], ["database", "cloud_sql_postgres", "create_or_update", 5_000_000],
    ["modal-benchmark", "modal", "benchmark", 4_000_000], ["fly-benchmark", "fly", "benchmark", 4_000_000],
    ["contextvm-rails", "contextvm", "verify_integration", 2_000_000], ["payments", "cep8_lightning", "verify_integration", 2_000_000],
    ["cashu", "cashu", "verify_integration", 2_000_000], ["model", "model", "verify_integration", 5_000_000],
    ["host-signer", "compatible_host", "verify_integration", 1_000_000], ["signer", "signer", "verify_integration", 1_000_000],
    ["cli-asset", "promoted_cli", "verify_integration", 1_000_000], ["publication", "upload", "verify_integration", 1_000_000],
    ["owner-relay", "owner_relay", "verify_integration", 1_000_000], ["attestation-relay", "attestation_relay", "verify_integration", 1_000_000],
  ] as const;
  const base = {
    version: 1 as const, candidateSha256, topologySha256,
    effects: effects.map(([id, provider, operation, estimatedCostMicros]) => ({ id, provider, operation, estimatedCostMicros })),
    maximumAuthorizedCostMicros: effects.reduce((total, item) => total + item[3], 0),
  };
  return ReleaseEffectPlanSchema.parse({ ...base, effectPlanSha256: await digest(base) });
}

async function stateFor(input: Omit<ReleaseControllerState, "stateSha256">): Promise<ReleaseControllerState> {
  return ReleaseControllerStateSchema.parse({ ...input, stateSha256: await digest(input) });
}

async function requestFor(input: Omit<ReleaseAuthorizationRequest, "authorizationRequestSha256">): Promise<ReleaseAuthorizationRequest> {
  return ReleaseAuthorizationRequestSchema.parse({ ...input, authorizationRequestSha256: await digest(input) });
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

export class ReleaseCertificationController {
  readonly #candidatePath: string;
  readonly #workspace: string;
  readonly #providers: ReleaseProviderRegistry;
  readonly #now: () => number;

  constructor(options: ControllerOptions) {
    this.#candidatePath = resolve(options.candidatePath);
    this.#workspace = resolve(options.workspace);
    this.#providers = options.providers ?? createNoCredentialReleaseProviderRegistry();
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
    const state = await this.#readState(pointer.data.stateSha256);
    if (state.candidate.candidateSha256 !== pointer.data.candidateSha256 || state.status !== "authorization_required" || !state.authorizationRequestSha256) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    if ((await candidateIdentity(this.#candidatePath)).candidateSha256 !== state.candidate.candidateSha256) throw new Error("RELEASE_CONTROLLER_CANDIDATE_MISMATCH");
    const request = await this.#readRequest(state.authorizationRequestSha256);
    const expectedEffectPlanSha256 = await digest({
      version: 1,
      candidateSha256: request.candidate.candidateSha256,
      topologySha256: request.topologySha256,
      effects: request.plannedEffects,
      maximumAuthorizedCostMicros: request.maximumAuthorizedCostMicros,
    });
    const plannedCost = request.plannedEffects.reduce((total, effect) => total + effect.estimatedCostMicros, 0);
    if (
      request.resumeStateSha256 !== state.priorStateSha256
      || canonicalJson(request.candidate) !== canonicalJson(state.candidate)
      || request.topologySha256 !== state.topologySha256
      || request.providerCapabilitiesSha256 !== await digest(state.capabilities)
      || request.effectPlanSha256 !== expectedEffectPlanSha256
      || request.maximumAuthorizedCostMicros !== plannedCost
      || request.expiresAtMs <= state.createdAtMs
    ) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    return { exitCode: 1, state, authorizationRequest: request };
  }

  async dryRun(): Promise<ReleaseCertificationResult> {
    const candidate = await candidateIdentity(this.#candidatePath);
    const topology = await deriveReleaseTopology(candidate.candidateSha256);
    const plan = await effectPlan(candidate.candidateSha256, topology.topologySha256);
    const capabilities = await discoverProviders(this.#providers);
    const existing = await this.status();
    if (existing) {
      if (existing.state.candidate.candidateSha256 !== candidate.candidateSha256) throw new Error("RELEASE_CONTROLLER_CANDIDATE_MISMATCH");
      if (existing.state.topologySha256 !== topology.topologySha256 || existing.authorizationRequest.effectPlanSha256 !== plan.effectPlanSha256 || existing.authorizationRequest.maximumAuthorizedCostMicros !== plan.maximumAuthorizedCostMicros) {
        throw new Error("RELEASE_CONTROLLER_RESUME_INPUT_MISMATCH");
      }
      if (canonicalJson(existing.state.capabilities) === canonicalJson(capabilities)) return existing;
    }
    const discovering = await stateFor({
      version: 1, status: "discovering", candidate, topologySha256: topology.topologySha256, capabilities,
      priorStateSha256: null, authorizationRequestSha256: null, authorizationReceiptSha256: null,
      providerOperationIds: [], deployedTopologySha256: null, blockReasonCode: null, createdAtMs: this.#now(),
    });
    await createOrVerify(join(this.#workspace, "states", `${discovering.stateSha256}.json`), `${canonicalJson(discovering)}\n`, "RELEASE_CONTROLLER_STATE_COLLISION");
    const request = await requestFor({
      version: 1, candidate, topologySha256: topology.topologySha256, effectPlanSha256: plan.effectPlanSha256,
      plannedEffects: plan.effects, maximumAuthorizedCostMicros: plan.maximumAuthorizedCostMicros,
      providerCapabilitiesSha256: await digest(capabilities), expiresAtMs: discovering.createdAtMs + 24 * 60 * 60 * 1000,
      resumeStateSha256: discovering.stateSha256,
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
    if (existing) await this.#writeCurrent(final);
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

  /** Local-only composition path. The protected runner injects authenticated ports later;
   * this controller neither constructs them nor writes certification evidence. */
  async provision(input: Readonly<{ receipt: unknown; registry: AuthorizedProviderRegistry }>): Promise<ReleaseProvisioningResult> {
    const current = await this.#loadCurrent();
    if (!current.state.authorizationRequestSha256) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    const request = await this.#readRequest(current.state.authorizationRequestSha256);
    const receipt = ReleaseAuthorizationReceiptSchema.safeParse(input.receipt);
    if (!receipt.success || receipt.data.expiresAtMs <= this.#now()
      || receipt.data.authorizationRequestSha256 !== request.authorizationRequestSha256
      || receipt.data.candidateSha256 !== current.state.candidate.candidateSha256
      || receipt.data.topologySha256 !== current.state.topologySha256
      || receipt.data.effectPlanSha256 !== request.effectPlanSha256
      || receipt.data.maximumAuthorizedCostMicros !== request.maximumAuthorizedCostMicros) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");

    if (current.state.status === "topology_ready" && current.state.deployedTopologySha256) {
      return { state: current.state, authorizationRequest: request, topology: await this.#readTopology(current.state.deployedTopologySha256) };
    }
    if (!["authorization_required", "provisioning", "discovering_deployed"].includes(current.state.status)) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");

    const operations = await Promise.all(request.plannedEffects.map(async (effect) => ReleaseProviderOperationSchema.parse({
      version: 1,
      operationId: `op-${await digest({ candidateSha256: current.state.candidate.candidateSha256, authorizationRequestSha256: request.authorizationRequestSha256, provider: effect.provider, effectId: effect.id, desiredDigest: request.effectPlanSha256 })}`,
      provider: effect.provider, effectId: effect.id, operation: effect.operation,
      region: effect.provider === "cloud_run" || effect.provider === "collector" ? "europe-west1" : "global",
      desiredDigest: await digest({ effect, effectPlanSha256: request.effectPlanSha256 }),
      candidateSha256: current.state.candidate.candidateSha256,
      authorizationRequestSha256: request.authorizationRequestSha256,
    })));
    if (operations.length !== RELEASE_PROVIDER_IDS.length || new Set(operations.map((operation) => operation.provider)).size !== RELEASE_PROVIDER_IDS.length) throw new Error("RELEASE_CONTROLLER_TOPOLOGY_INVALID");

    for (const operation of operations) {
      try {
        const existing = await this.#readOperation(operation.operationId);
        if (canonicalJson(existing.operation) !== canonicalJson(operation)) throw new Error("RELEASE_CONTROLLER_OPERATION_COLLISION");
      } catch (error) {
        if (error instanceof Error && error.message === "RELEASE_CONTROLLER_OPERATION_COLLISION") throw error;
        await createOrVerify(join(this.#workspace, "provider-operations", `${operation.operationId}.json`), `${canonicalJson({ version: 1, operation, status: "pending", actualCostMicros: 0, resourceIdentitySha256: null } satisfies ProviderOperationRecord)}\n`, "RELEASE_CONTROLLER_OPERATION_COLLISION");
      }
    }
    let state = current.state;
    if (state.status === "authorization_required") state = await this.#advance(state, "provisioning", receipt.data.authorizationReceiptSha256, operations.map((operation) => operation.operationId), null, null);

    let totalCost = 0;
    for (const operation of operations) {
      const record = await this.#readOperation(operation.operationId);
      if (record.status === "completed") { totalCost += record.actualCostMicros; continue; }
      const result = record.status === "unknown"
        ? await input.registry.observe({ receipt: receipt.data, operation, approvedMaximumCostMicros: receipt.data.maximumAuthorizedCostMicros })
        : await input.registry.apply({ receipt: receipt.data, operation, approvedMaximumCostMicros: receipt.data.maximumAuthorizedCostMicros });
      if (result.status === "unknown" || result.status === "pending") {
        await this.#writeOperation({ ...record, status: "unknown", actualCostMicros: result.actualCostMicros, resourceIdentitySha256: result.resourceIdentitySha256 ?? null });
        throw new Error("RELEASE_CONTROLLER_PROVIDER_AMBIGUOUS");
      }
      if (result.status !== "applied" && result.status !== "completed") throw new Error("RELEASE_CONTROLLER_PROVIDER_BLOCKED");
      const actualCostMicros = result.actualCostMicros;
      totalCost += actualCostMicros;
      if (totalCost > receipt.data.maximumAuthorizedCostMicros) {
        await this.#writeOperation({ ...record, status: "completed", actualCostMicros, resourceIdentitySha256: result.resourceIdentitySha256 ?? null });
        await this.#advance(state, "blocked", receipt.data.authorizationReceiptSha256, operations.map((operation) => operation.operationId), null, "COST_EXCEEDED");
        throw new Error("RELEASE_CONTROLLER_COST_EXCEEDED");
      }
      if (!result.resourceIdentitySha256) throw new Error("RELEASE_CONTROLLER_PROVIDER_DRIFT");
      await this.#writeOperation({ ...record, status: "completed", actualCostMicros, resourceIdentitySha256: result.resourceIdentitySha256 });
    }

    state = await this.#advance(state, "discovering_deployed", receipt.data.authorizationReceiptSha256, operations.map((operation) => operation.operationId), null, null);
    const discovered = await Promise.all(operations.map((operation) => input.registry.discover(operation.provider)));
    if (discovered.some((item) => item.capability !== "available" || item.authentication !== "authorized")) {
      await this.#advance(state, "blocked", receipt.data.authorizationReceiptSha256, operations.map((operation) => operation.operationId), null, "PROVIDER_UNAVAILABLE");
      throw new Error("RELEASE_CONTROLLER_PROVIDER_DRIFT");
    }
    const resources = await Promise.all(operations.map(async (operation, index) => {
      const record = await this.#readOperation(operation.operationId);
      if (record.status !== "completed" || !record.resourceIdentitySha256) throw new Error("RELEASE_CONTROLLER_PROVIDER_DRIFT");
      return {
        provider: operation.provider, operationId: operation.operationId, region: operation.region, desiredDigest: operation.desiredDigest,
        configDigest: operation.desiredDigest, resourceIdentitySha256: record.resourceIdentitySha256,
        capability: discovered[index]!.capability, status: "observed" as const,
      };
    }));
    const desired = await deriveReleaseTopology(current.state.candidate.candidateSha256);
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
    state = await this.#advance(state, "topology_ready", receipt.data.authorizationReceiptSha256, operations.map((operation) => operation.operationId), topology.topologySha256, null);
    return { state, authorizationRequest: request, topology };
  }

  async #advance(prior: ReleaseControllerState, status: Extract<ReleaseControllerState["status"], "provisioning" | "discovering_deployed" | "topology_ready" | "blocked">, authorizationReceiptSha256: string, providerOperationIds: string[], deployedTopologySha256: string | null, blockReasonCode: ReleaseControllerState["blockReasonCode"]): Promise<ReleaseControllerState> {
    const { stateSha256: _priorStateSha256, ...priorState } = prior;
    const next = await stateFor({
      ...priorState, status, priorStateSha256: prior.stateSha256, authorizationReceiptSha256,
      providerOperationIds, deployedTopologySha256, blockReasonCode, createdAtMs: this.#now(),
    });
    await createOrVerify(join(this.#workspace, "states", `${next.stateSha256}.json`), `${canonicalJson(next)}\n`, "RELEASE_CONTROLLER_STATE_COLLISION");
    await this.#writeCurrent(next);
    return next;
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
    const state = await this.#readState(pointer.data.stateSha256);
    if (state.candidate.candidateSha256 !== pointer.data.candidateSha256) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    return { state, pointer: pointer.data };
  }

  async #readOperation(operationId: string): Promise<ProviderOperationRecord> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "provider-operations", `${operationId}.json`), "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID"); }
    const schema = z.object({ version: z.literal(1), operation: ReleaseProviderOperationSchema, status: z.enum(["pending", "unknown", "completed"]), actualCostMicros: z.number().int().nonnegative(), resourceIdentitySha256: DigestSchema.nullable() }).strict();
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.operation.operationId !== operationId) throw new Error("RELEASE_CONTROLLER_OPERATION_INVALID");
    return parsed.data;
  }

  async #writeOperation(record: ProviderOperationRecord): Promise<void> {
    await writeFile(join(this.#workspace, "provider-operations", `${record.operation.operationId}.json`), `${canonicalJson(record)}\n`, "utf8");
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
    if (state.data.status === "discovering" && (state.data.priorStateSha256 !== null || state.data.authorizationRequestSha256 !== null)) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
    if (state.data.status === "authorization_required") {
      if (!state.data.priorStateSha256 || !state.data.authorizationRequestSha256) throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
      const prior = await this.#readState(state.data.priorStateSha256, seen);
      if (prior.status !== "discovering" || prior.authorizationRequestSha256 !== null || prior.candidate.candidateSha256 !== state.data.candidate.candidateSha256 || prior.topologySha256 !== state.data.topologySha256 || prior.createdAtMs > state.data.createdAtMs || canonicalJson(prior.capabilities) !== canonicalJson(state.data.capabilities)) {
        throw new Error("RELEASE_CONTROLLER_STATE_INVALID");
      }
    }
    return state.data;
  }

  async #readRequest(authorizationRequestSha256: string): Promise<ReleaseAuthorizationRequest> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.#workspace, "authorization-requests", `${authorizationRequestSha256}.json`), "utf8")); }
    catch { throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID"); }
    const request = ReleaseAuthorizationRequestSchema.safeParse(raw);
    if (!request.success || request.data.authorizationRequestSha256 !== authorizationRequestSha256 || request.data.authorizationRequestSha256 !== await digest(withoutDigest(request.data, "authorizationRequestSha256"))) throw new Error("RELEASE_CONTROLLER_AUTHORIZATION_INVALID");
    return request.data;
  }
}

export async function runReleaseCertification(options: ControllerOptions & Readonly<{ dryRun: true }>): Promise<ReleaseCertificationResult>;
export async function runReleaseCertification(options: ControllerOptions & Readonly<{ dryRun: false; authorizationReceiptSha256?: string }>): Promise<never>;
export async function runReleaseCertification(options: ControllerOptions & Readonly<{ dryRun: boolean; authorizationReceiptSha256?: string }>): Promise<ReleaseCertificationResult> {
  if (!options.dryRun) {
    if (!options.authorizationReceiptSha256 || !DigestSchema.safeParse(options.authorizationReceiptSha256).success) throw new Error("RELEASE_AUTHORIZATION_REQUIRED");
    throw new Error("RELEASE_LIVE_PROVIDER_FAMILY_UNIMPLEMENTED");
  }
  const progress = await new ReleaseCertificationController(options).certify();
  return progress;
}
