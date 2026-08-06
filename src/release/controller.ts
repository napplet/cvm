import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "../promotion/schema";
import {
  ProviderCapabilityObservationSchema,
  ReleaseAuthorizationRequestSchema,
  ReleaseControllerCurrentPointerSchema,
  ReleaseControllerStateSchema,
  ReleaseEffectPlanSchema,
  type ProviderCapabilityObservation,
  type ReleaseAuthorizationRequest,
  type ReleaseControllerState,
  type ReleaseProviderId,
  type ReleaseProviderRegistry,
} from "./contracts";
import { deriveReleaseTopology, RELEASE_PROVIDER_IDS } from "./topology";

export const RELEASE_WORKSPACE_ENV = "NAPPLET_CVM_RELEASE_WORKSPACE";
export const RELEASE_AUTHORIZATION_SHA256_ENV = "NAPPLET_CVM_RELEASE_AUTHORIZATION_SHA256";

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
  reasonCode: "CREDENTIALS_UNAVAILABLE",
});

/** The local controller has no implicit authority: every provider is a finite
 * no-credential discovery port until a later authorization-gated registry is supplied. */
export function createNoCredentialReleaseProviderRegistry(): ReleaseProviderRegistry {
  return Object.fromEntries(RELEASE_PROVIDER_IDS.map((provider) => [provider, {
    discover: async () => {
      const { version: _version, provider: _provider, accountScopeSha256: _scope, costEstimateSha256: _cost, ...observation } = defaultObservation(provider);
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
    ["collector", "collector", "create_or_update", 500_000], ["database", "cockroach_postgres", "create_or_update", 5_000_000],
    ["modal-benchmark", "modal", "benchmark", 4_000_000], ["fly-benchmark", "fly", "benchmark", 4_000_000],
    ["contextvm-rails", "contextvm", "verify_integration", 2_000_000], ["payments", "cep8_lightning", "verify_integration", 2_000_000],
    ["cashu", "cashu", "verify_integration", 2_000_000], ["model", "model", "verify_integration", 5_000_000],
    ["host-signer", "compatible_host", "verify_integration", 1_000_000], ["publication", "upload", "verify_integration", 1_000_000],
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
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error(collision);
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
    const existing = await this.status();
    if (existing) {
      if (existing.state.candidate.candidateSha256 !== candidate.candidateSha256) throw new Error("RELEASE_CONTROLLER_CANDIDATE_MISMATCH");
      if (existing.state.topologySha256 !== topology.topologySha256 || existing.authorizationRequest.effectPlanSha256 !== plan.effectPlanSha256 || existing.authorizationRequest.maximumAuthorizedCostMicros !== plan.maximumAuthorizedCostMicros) {
        throw new Error("RELEASE_CONTROLLER_RESUME_INPUT_MISMATCH");
      }
      return existing;
    }
    const capabilities = await discoverProviders(this.#providers);
    const discovering = await stateFor({
      version: 1, status: "discovering", candidate, topologySha256: topology.topologySha256, capabilities,
      priorStateSha256: null, authorizationRequestSha256: null, createdAtMs: this.#now(),
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
      priorStateSha256: discovering.stateSha256, authorizationRequestSha256: request.authorizationRequestSha256, createdAtMs: discovering.createdAtMs,
    });
    await createOrVerify(join(this.#workspace, "states", `${final.stateSha256}.json`), `${canonicalJson(final)}\n`, "RELEASE_CONTROLLER_STATE_COLLISION");
    const pointerBase = { version: 1 as const, stateSha256: final.stateSha256, candidateSha256: candidate.candidateSha256 };
    const pointer = { ...pointerBase, pointerSha256: await digest(pointerBase) };
    await createOrVerify(join(this.#workspace, "current.json"), `${canonicalJson(pointer)}\n`, "RELEASE_CONTROLLER_CONCURRENT_WRITE");
    return (await this.status())!;
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

export async function runReleaseCertification(options: ControllerOptions & Readonly<{ dryRun: true }>): Promise<ReleaseCertificationResult> {
  return new ReleaseCertificationController(options).dryRun();
}
