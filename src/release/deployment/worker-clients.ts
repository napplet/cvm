import { z } from "zod";
import { readBoundedModalProcessOutput, type ModalSandboxCreateOptions, type ModalSandboxPort, type ModalSdkPort } from "../../worker-adapters/modal-worker";
import { PRODUCTION_WORKER_POLICY, type ProductionWorkerPolicy } from "../../worker-adapters/production-worker-policy";
import { createWorkerBenchmarkSchedule, WorkerBenchmarkProfileSchema } from "../../admission/benchmark";

const ImageSchema = z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu);
const AppNameSchema = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u);
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,48}$/u);
const RegionSchema = z.string().regex(/^[a-z0-9-]{2,32}$/u);
const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{3,128}$/u);
const COHORTS = ["pool_hit", "pool_miss", "cold", "step_load", "contention", "reclaim", "ambiguity", "cleanup", "failure"] as const;

export { PRODUCTION_WORKER_POLICY };
export type FlyFetch = (url: string, init: RequestInit) => Promise<Response>;
export type WorkerSchedule = Readonly<{ id: string; cohort: typeof COHORTS[number] }>;

/** Exact verifier schedule: 1,000 total attempts including both forced
 * 200-attempt cohorts, rather than a transport-local approximation. */
export const LOCKED_WORKER_SCHEDULE: readonly WorkerSchedule[] = Object.freeze(createWorkerBenchmarkSchedule(WorkerBenchmarkProfileSchema.parse({})).map(({ id, cohort }) => Object.freeze({ id, cohort })));

/** The immutable cross-provider envelope. It is construction evidence only;
 * selection remains impossible without fresh protected cohort evidence. */
export const WORKER_RUNNER_DEFINITION = Object.freeze({
  ...PRODUCTION_WORKER_POLICY,
  durableBacklog: 0 as const,
});

type WorkerOperationState = "claimed" | "dispatching" | "dispatched" | "reconciled" | "unknown" | "terminating" | "terminated";
export type WorkerOperationRecord = Readonly<{
  operationId: string;
  provider?: "modal" | "fly";
  appName?: string;
  requestSha256: string;
  state: WorkerOperationState;
  resourceName: string;
  resourceId?: string;
  /** Immutable request facts are persisted before a provider mutation.  They
   * are deliberately repeated here rather than reconstructed from current
   * configuration during reconciliation. */
  image?: string;
  region?: string;
  policyVersion?: string;
  createdAtMs?: number;
  sessionLeaseSha256?: string;
  toolchainSha256?: string;
  providerDeadlineEpochMs?: number;
  providerCreatedAtMs?: number;
}>;
/** This is a controller persistence port. Production injects a durable CAS
 * implementation; the in-memory version below is limited to contract tests. */
export type WorkerOperationJournal = Readonly<{
  claim(record: Omit<WorkerOperationRecord, "state" | "resourceId">): Promise<Readonly<{ claimed: boolean; record: WorkerOperationRecord }>>;
  read(operationId: string): Promise<WorkerOperationRecord | undefined>;
  update(input: Readonly<{ operationId: string; requestSha256: string; state: WorkerOperationState; resourceId?: string; providerCreatedAtMs?: number }>): Promise<WorkerOperationRecord>;
}>;

export function createMemoryWorkerOperationJournal(seed: readonly WorkerOperationRecord[] = []): WorkerOperationJournal {
  const records = new Map(seed.map((record) => [record.operationId, Object.freeze({ ...record })]));
  return Object.freeze({
    async claim(record) {
      const current = records.get(record.operationId);
      if (current) return Object.freeze({ claimed: false, record: current });
      const claimed = Object.freeze({ ...record, state: "claimed" as const }); records.set(claimed.operationId, claimed);
      return Object.freeze({ claimed: true, record: claimed });
    },
    async read(operationId) { return records.get(OperationIdSchema.parse(operationId)); },
    async update(input) {
      const current = records.get(OperationIdSchema.parse(input.operationId));
      if (!current || current.requestSha256 !== input.requestSha256) throw new Error("WORKER_OPERATION_CAS_CONFLICT");
      if ((current.resourceId && input.resourceId && current.resourceId !== input.resourceId) || (current.providerCreatedAtMs !== undefined && input.providerCreatedAtMs !== undefined && current.providerCreatedAtMs !== input.providerCreatedAtMs)) throw new Error("WORKER_OPERATION_IDENTITY_CONFLICT");
      const next = Object.freeze({ ...current, state: input.state, ...(input.resourceId ? { resourceId: ResourceIdSchema.parse(input.resourceId) } : {}), ...(input.providerCreatedAtMs !== undefined ? { providerCreatedAtMs: z.number().int().positive().parse(input.providerCreatedAtMs) } : {}) });
      records.set(next.operationId, next); return next;
    },
  });
}

function stableName(operationId: string): string { return `napplet-cvm-${OperationIdSchema.parse(operationId)}`; }
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const MachineSchema = z.object({
  id: ResourceIdSchema,
  name: z.string().min(1).max(128),
  state: z.string().optional(),
  created_at: z.string().min(1).max(128),
  config: z.object({ image: ImageSchema, metadata: z.record(z.string(), z.string()).optional(), guest: z.object({ cpus: z.number().int().positive(), memory_mb: z.number().int().positive() }).optional(), services: z.array(z.unknown()).optional(), env: z.record(z.string(), z.string()).optional() }).passthrough(),
}).passthrough();

const MAX_PROVIDER_RESPONSE_BYTES = 128 * 1024;
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const BOOTSTRAP = "/usr/local/bin/napplet-cvm-bootstrap";
const ImageDigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());

function imageDigest(image: string): string { return ImageDigestSchema.parse(ImageSchema.parse(image).split("@sha256:")[1]); }
function createdAtMs(machine: z.infer<typeof MachineSchema>): number | undefined { const value = Date.parse(machine.created_at); return Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function isolatedExec(command: readonly string[]): readonly string[] {
  if (command[0] === BOOTSTRAP) throw new Error("WORKER_EXEC_WRAPPER_FORBIDDEN");
  return Object.freeze([BOOTSTRAP, ...command]);
}

/** Never use Response.json()/text() at a provider boundary: a compromised or
 * malformed endpoint must not be able to make the controller buffer an
 * unbounded body. */
async function boundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("PROVIDER_RESPONSE_BODY_MISSING");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(new Error("FLY_REQUEST_TIMEOUT")).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export type FlyCreateResult = Readonly<{ status: "created" | "reconciled"; operationId: string; resourceId: string }> | Readonly<{ status: "unknown"; operationId: string }>;
export type FlyMachinesHttpTransport = Readonly<{
  create(input: Readonly<{ operationId: string; region: string; image: string; policy: ProductionWorkerPolicy; sessionLeaseSha256: string; toolchainSha256: string; providerDeadlineEpochMs: number }>): Promise<FlyCreateResult>;
  observe(input: Readonly<{ operationId: string }>): Promise<Readonly<{ status: "missing" | "pending" | "completed" | "unknown"; resourceId?: string }>>;
  terminate(input: Readonly<{ operationId: string }>): Promise<Readonly<{ status: "terminated" | "pending" | "unknown" | "blocked" }>>;
  /** Controller-only bounded Machines exec. It is used for the immutable
   * image's readiness probe, never to re-run generated or paid work. */
  exec(input: Readonly<{ operationId: string; command: readonly string[]; stdin?: string; timeoutSeconds?: number }>): Promise<Readonly<{ status: "completed" | "unknown"; stdout?: string; stderr?: string; exitCode?: number }>>;
}>;

export type ModalProductionTransport = Readonly<{
  create(input: Readonly<{ operationId: string; sessionLeaseSha256: string; toolchainSha256: string; providerDeadlineEpochMs: number }>): Promise<Readonly<{ status: "created" | "reconciled" | "unknown"; operationId: string; resourceId?: string }>>;
  observe(input: Readonly<{ operationId: string }>): Promise<Readonly<{ status: "completed" | "pending" | "unknown"; resourceId?: string }>>;
  terminate(input: Readonly<{ operationId: string }>): Promise<Readonly<{ status: "terminated" | "pending" | "unknown" | "blocked" }>>;
  /** Production-only, bounded and bootstrap-wrapped command surface. */
  exec(input: Readonly<{ operationId: string; command: readonly string[]; timeoutMs?: number }>): Promise<Readonly<{ status: "completed" | "unknown"; stdout?: string; stderr?: string; exitCode?: number }>>;
}>;

function modalIdentityTags(input: Readonly<{ operationId: string; requestSha256: string; image: string; sessionLeaseSha256: string; toolchainSha256: string; tags: Readonly<Record<string, string>> }>) {
  return Object.freeze({ ...input.tags, "napplet-cvm-operation": input.operationId, "napplet-cvm-policy": PRODUCTION_WORKER_POLICY.version, "napplet-cvm-role": "isolated-worker", "napplet-cvm-request-sha256": input.requestSha256, "napplet-cvm-image-sha256": imageDigest(input.image), "napplet-cvm-lease-sha256": input.sessionLeaseSha256, "napplet-cvm-toolchain-sha256": input.toolchainSha256 });
}
function productionModalOptions(input: Readonly<{ operationId: string; requestSha256: string; image: string; sessionLeaseSha256: string; toolchainSha256: string; providerDeadlineEpochMs: number; workspaceRoot: string; tags: Readonly<Record<string, string>>; regions?: readonly string[] }>): ModalSandboxCreateOptions {
  return Object.freeze({
    cpu: PRODUCTION_WORKER_POLICY.cpu, cpuLimit: PRODUCTION_WORKER_POLICY.cpuLimit,
    memoryMiB: PRODUCTION_WORKER_POLICY.memoryMiB, memoryLimitMiB: PRODUCTION_WORKER_POLICY.memoryLimitMiB,
    timeoutMs: PRODUCTION_WORKER_POLICY.totalLifetimeMs, idleTimeoutMs: PRODUCTION_WORKER_POLICY.idleGraceMs,
    workdir: input.workspaceRoot,
    command: Object.freeze([BOOTSTRAP, "/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(input.providerDeadlineEpochMs)]),
    env: Object.freeze({ NAPPLET_CVM_POLICY_VERSION: PRODUCTION_WORKER_POLICY.version }), blockNetwork: true,
    tags: modalIdentityTags(input),
    name: stableName(input.operationId), ...(input.regions ? { regions: Object.freeze([...input.regions]) } : {}),
  });
}

/** Real controller-side Modal lifecycle.  A missing or ambiguous lookup is a
 * terminal unknown: it deliberately never causes a replacement sandbox. */
export function createModalProductionTransport(input: Readonly<{ appName: string; image: string; workspaceRoot: string; tags: Readonly<Record<string, string>>; regions?: readonly string[]; sdk: ModalSdkPort; journal: WorkerOperationJournal }>): ModalProductionTransport {
  const appName = AppNameSchema.parse(input.appName); const image = ImageSchema.parse(input.image);
  if (input.workspaceRoot !== PRODUCTION_WORKER_POLICY.workspaceRoot || !input.sdk.sandboxes.findByName) throw new Error("MODAL_PRODUCTION_CAPABILITY_UNSUPPORTED");
  const find = input.sdk.sandboxes.findByName;
  const matchesRecord = async (sandbox: ModalSandboxPort, record: WorkerOperationRecord) => {
    if (record.provider !== "modal" || record.appName !== appName || !record.image || !record.sessionLeaseSha256 || !record.toolchainSha256 || !sandbox.getTags) return false;
    const expected = modalIdentityTags({ operationId: record.operationId, requestSha256: record.requestSha256, image: record.image, sessionLeaseSha256: record.sessionLeaseSha256, toolchainSha256: record.toolchainSha256, tags: input.tags });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const tags = await Promise.race([sandbox.getTags(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MODAL_TAG_LOOKUP_TIMEOUT")), 15_000); })]);
      return Object.entries(expected).every(([key, value]) => tags[key] === value) && Object.keys(tags).length === Object.keys(expected).length;
    } catch { return false; } finally { clearTimeout(timer); }
  };
  const exec = async (value: Readonly<{ operationId: string; command: readonly string[]; timeoutMs?: number }>) => {
    const record = await input.journal.read(OperationIdSchema.parse(value.operationId));
    const command = z.array(z.string().min(1).max(256)).min(1).max(12).parse(value.command);
    const timeoutMs = z.number().int().min(1).max(60_000).parse(value.timeoutMs ?? 60_000);
    if (!record?.resourceId) return Object.freeze({ status: "unknown" as const });
    const observed = await find(appName, record.resourceName);
    if (observed.kind !== "found" || observed.sandbox.id !== record.resourceId || !await matchesRecord(observed.sandbox, record)) return Object.freeze({ status: "unknown" as const });
    try {
      const output = await readBoundedModalProcessOutput(await observed.sandbox.exec(isolatedExec(command), { timeoutMs }));
      return Object.freeze({ status: "completed" as const, stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode });
    } catch { return Object.freeze({ status: "unknown" as const }); }
  };
  return Object.freeze({
    async create(value) {
      const operationId = OperationIdSchema.parse(value.operationId); const sessionLeaseSha256 = ImageDigestSchema.parse(value.sessionLeaseSha256); const toolchainSha256 = ImageDigestSchema.parse(value.toolchainSha256); const providerDeadlineEpochMs = z.number().int().positive().parse(value.providerDeadlineEpochMs);
      if (providerDeadlineEpochMs <= Date.now() || providerDeadlineEpochMs > Date.now() + PRODUCTION_WORKER_POLICY.totalLifetimeMs) throw new Error("WORKER_DEADLINE_INVALID");
      const requestSha256 = await sha256(JSON.stringify({ provider: "modal", appName, regions: input.regions ?? [], tags: Object.entries(input.tags).sort(([a], [b]) => a.localeCompare(b)), operationId, image, policy: PRODUCTION_WORKER_POLICY, sessionLeaseSha256, toolchainSha256, providerDeadlineEpochMs }));
      const resourceName = stableName(operationId);
      const claim = await input.journal.claim({ operationId, provider: "modal", appName, requestSha256, resourceName, image, policyVersion: PRODUCTION_WORKER_POLICY.version, createdAtMs: Date.now(), sessionLeaseSha256, toolchainSha256, providerDeadlineEpochMs });
      if (!claim.claimed) {
        if (claim.record.provider !== "modal" || claim.record.appName !== appName || claim.record.requestSha256 !== requestSha256 || claim.record.image !== image || claim.record.policyVersion !== PRODUCTION_WORKER_POLICY.version || claim.record.sessionLeaseSha256 !== sessionLeaseSha256 || claim.record.toolchainSha256 !== toolchainSha256 || claim.record.providerDeadlineEpochMs !== providerDeadlineEpochMs) return Object.freeze({ status: "unknown" as const, operationId });
        // A deterministic name alone is not an immutable provider binding.  A
        // lost create without the returned Sandbox ID remains ambiguous; never
        // attach or replace it based on an SDK name lookup.
        if (!claim.record.resourceId) {
          const observed = await find(appName, resourceName);
          if (observed.kind !== "found" || !await matchesRecord(observed.sandbox, claim.record)) return Object.freeze({ status: "unknown" as const, operationId });
          await input.journal.update({ operationId, requestSha256, state: "reconciled", resourceId: observed.sandbox.id });
          return Object.freeze({ status: "reconciled" as const, operationId, resourceId: observed.sandbox.id });
        }
        const observed = await find(appName, resourceName);
        if (observed.kind !== "found" || claim.record.resourceId !== observed.sandbox.id || !await matchesRecord(observed.sandbox, claim.record)) return Object.freeze({ status: "unknown" as const, operationId });
        await input.journal.update({ operationId, requestSha256, state: "reconciled", resourceId: observed.sandbox.id });
        return Object.freeze({ status: "reconciled" as const, operationId, resourceId: observed.sandbox.id });
      }
      const prior = await find(appName, resourceName);
      if (prior.kind === "unknown") return Object.freeze({ status: "unknown" as const, operationId });
      if (prior.kind === "found") return Object.freeze({ status: "unknown" as const, operationId });
      const app = await input.sdk.apps.fromName(appName, { createIfMissing: false });
      await input.journal.update({ operationId, requestSha256, state: "dispatching" });
      try {
        const sandbox = await input.sdk.sandboxes.create(app, input.sdk.images.fromRegistry(image), productionModalOptions({ operationId, requestSha256, image, sessionLeaseSha256, toolchainSha256, providerDeadlineEpochMs, workspaceRoot: input.workspaceRoot, tags: input.tags, ...(input.regions ? { regions: input.regions } : {}) }));
        await input.journal.update({ operationId, requestSha256, state: "dispatched", resourceId: sandbox.id });
        return Object.freeze({ status: "created" as const, operationId, resourceId: sandbox.id });
      } catch { await input.journal.update({ operationId, requestSha256, state: "unknown" }); return Object.freeze({ status: "unknown" as const, operationId }); }
    },
    async observe(value) {
      const record = await input.journal.read(OperationIdSchema.parse(value.operationId));
      if (!record?.resourceId || record.image !== image || record.policyVersion !== PRODUCTION_WORKER_POLICY.version || !record.sessionLeaseSha256 || !record.toolchainSha256 || !record.providerDeadlineEpochMs) return Object.freeze({ status: "unknown" as const });
      const observed = await find(appName, record.resourceName);
      if (observed.kind !== "found" || observed.sandbox.id !== record.resourceId) return Object.freeze({ status: "unknown" as const, resourceId: record.resourceId });
      try {
        const output = await exec({ operationId: record.operationId, command: [...PRODUCTION_WORKER_POLICY.probeCommand, "--session-lease-sha256", record.sessionLeaseSha256, "--provider-image", record.image, "--toolchain-sha256", record.toolchainSha256, "--provider-deadline-epoch-ms", String(record.providerDeadlineEpochMs)] });
        if (output.status !== "completed" || output.exitCode !== 0 || output.stdout === undefined) return Object.freeze({ status: "pending" as const, resourceId: record.resourceId });
        const report = z.object({ checks: z.object({ toolchain_readonly: z.literal(true), workspace_bounded: z.literal(true), non_root: z.literal(true), no_ambient_credentials: z.literal(true), network_denied: z.literal(true), no_inbound_ports: z.literal(true), minimal_capabilities: z.literal(true) }).strict(), exactReady: z.object({ image: ImageSchema, sessionLeaseSha256: ImageDigestSchema, toolchainSha256: ImageDigestSchema, remainingLifetimeMs: z.number().int().positive().max(PRODUCTION_WORKER_POLICY.totalLifetimeMs) }).strict() }).strict().safeParse(JSON.parse(output.stdout));
        if (!report.success || report.data.exactReady.image !== image || report.data.exactReady.sessionLeaseSha256 !== record.sessionLeaseSha256 || report.data.exactReady.toolchainSha256 !== record.toolchainSha256) return Object.freeze({ status: "unknown" as const, resourceId: record.resourceId });
        return Object.freeze({ status: "completed" as const, resourceId: record.resourceId });
      } catch { return Object.freeze({ status: "pending" as const, resourceId: record.resourceId }); }
    },
    exec,
    async terminate(value) {
      const record = await input.journal.read(OperationIdSchema.parse(value.operationId));
      if (!record?.resourceId || record.provider !== "modal" || record.appName !== appName || record.image !== image || record.policyVersion !== PRODUCTION_WORKER_POLICY.version) return Object.freeze({ status: "blocked" as const });
      const observed = await find(appName, record.resourceName);
      if (observed.kind === "missing") { await input.journal.update({ operationId: record.operationId, requestSha256: record.requestSha256, state: "terminated", resourceId: record.resourceId }); return Object.freeze({ status: "terminated" as const }); }
      if (observed.kind !== "found" || observed.sandbox.id !== record.resourceId) return Object.freeze({ status: "unknown" as const });
      await input.journal.update({ operationId: record.operationId, requestSha256: record.requestSha256, state: "terminating", resourceId: record.resourceId });
      try { await observed.sandbox.terminate(); } catch { return Object.freeze({ status: "pending" as const }); }
      const after = await find(appName, record.resourceName);
      if (after.kind !== "missing") return Object.freeze({ status: after.kind === "unknown" ? "unknown" as const : "pending" as const });
      await input.journal.update({ operationId: record.operationId, requestSha256: record.requestSha256, state: "terminated", resourceId: record.resourceId });
      return Object.freeze({ status: "terminated" as const });
    },
  });
}

const ReadinessAttestationSchema = z.object({
  version: z.literal(1),
  policyVersion: z.literal(PRODUCTION_WORKER_POLICY.version),
  image: ImageSchema,
  sessionLeaseSha256: z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase()),
  remainingLifetimeMs: z.number().int().positive().max(PRODUCTION_WORKER_POLICY.timeoutMs),
  networkPolicyEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase()),
  checks: z.object({
    toolchain_readonly: z.literal(true), workspace_bounded: z.literal(true), non_root: z.literal(true),
    no_ambient_credentials: z.literal(true), network_denied: z.literal(true), no_inbound_ports: z.literal(true), minimal_capabilities: z.literal(true),
  }).strict(),
}).strict();

/** The trusted controller calls this only after provider observation.  In
 * particular Fly's metadata cannot stand in for its app-level network policy:
 * the controller must present a verified policy plus the inner denial probe. */
export function validateWorkerReadinessAttestation(input: unknown, expected: Readonly<{ image: string; sessionLeaseSha256: string; networkPolicyEvidenceSha256: string }>) {
  const observed = ReadinessAttestationSchema.parse(input);
  if (observed.image !== ImageSchema.parse(expected.image) || observed.sessionLeaseSha256 !== expected.sessionLeaseSha256.toLowerCase() || observed.networkPolicyEvidenceSha256 !== expected.networkPolicyEvidenceSha256.toLowerCase()) {
    throw new Error("WORKER_READINESS_BINDING_INVALID");
  }
  return Object.freeze(observed);
}

/** Authenticated controller-only Fly Machines transport. It never resolves
 * ambient environment credentials and never retries a create after a lost
 * response: it queries the deterministic name/metadata identity instead. */
export function createFlyMachinesHttpTransport(input: Readonly<{
  appName: string;
  getAccessToken: () => Promise<string>;
  journal: WorkerOperationJournal;
  fetch: FlyFetch;
  apiOrigin?: string;
  /** Test-only seam for proving that a body which stalls after headers cannot
   * outlive the controller request deadline. */
  requestTimeoutMs?: number;
}>): FlyMachinesHttpTransport {
  const appName = AppNameSchema.parse(input.appName);
  const base = new URL(input.apiOrigin ?? "https://api.machines.dev");
  if (base.origin !== "https://api.machines.dev" || base.pathname !== "/" || base.search || base.username || base.password) throw new Error("FLY_API_ORIGIN_INVALID");
  const requestTimeoutMs = z.number().int().min(1).max(PROVIDER_REQUEST_TIMEOUT_MS).parse(input.requestTimeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS);
  const pendingResponses = new WeakMap<Response, Readonly<{ controller: AbortController; timer: ReturnType<typeof setTimeout> }>>();
  const request = async (path: string, init: RequestInit) => {
    const token = await input.getAccessToken();
    if (typeof token !== "string" || token.length < 12 || /\s/u.test(token)) throw new Error("FLY_ACCESS_TOKEN_INVALID");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("FLY_REQUEST_TIMEOUT")), requestTimeoutMs);
    try {
      const response = await input.fetch(new URL(path, base).toString(), {
        ...init, signal: controller.signal, redirect: "error",
        headers: Object.freeze({ authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) }),
      });
      // Headers are not completion: retain the deadline through body draining.
      // Every branch below consumes or explicitly disposes the response.
      pendingResponses.set(response, Object.freeze({ controller, timer }));
      return response;
    } catch (error) { clearTimeout(timer); throw error; }
  };
  const dispose = async (response: Response) => {
    const pending = pendingResponses.get(response);
    if (pending) {
      clearTimeout(pending.timer);
      pendingResponses.delete(response);
    }
    await response.body?.cancel().catch(() => undefined);
  };
  const responseJson = async (response: Response): Promise<unknown> => {
    const pending = pendingResponses.get(response);
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("FLY_REQUEST_TIMEOUT"));
      pending?.controller.signal.addEventListener("abort", abort, { once: true });
      if (pending?.controller.signal.aborted) abort();
    });
    try { return await Promise.race([boundedJson(response, pending?.controller.signal), aborted]); }
    finally {
      pending?.controller.signal.removeEventListener("abort", abort);
      await dispose(response);
    }
  };

function intendedMachine(machine: z.infer<typeof MachineSchema>, record: Pick<WorkerOperationRecord, "operationId" | "resourceName" | "image" | "policyVersion" | "provider" | "appName">, image: string): boolean {
  const metadata = machine.config.metadata;
  return record.provider === "fly" && record.appName === appName && Boolean(record.image) && machine.name === record.resourceName && machine.config.image === image && image === record.image
    && metadata?.["napplet-cvm-operation"] === record.operationId
    && metadata?.["napplet-cvm-policy"] === record.policyVersion
    && metadata?.["napplet-cvm-role"] === "isolated-worker"
    && Object.keys(metadata).sort().join(",") === "napplet-cvm-operation,napplet-cvm-policy,napplet-cvm-role"
    && machine.config.guest?.cpus === PRODUCTION_WORKER_POLICY.cpu
    && machine.config.guest?.memory_mb === PRODUCTION_WORKER_POLICY.memoryMiB
    && machine.config.services?.length === 0
    && machine.config.env?.NAPPLET_CVM_POLICY_VERSION === PRODUCTION_WORKER_POLICY.version;
}
function ownedMachine(machine: z.infer<typeof MachineSchema>, record: Pick<WorkerOperationRecord, "operationId" | "resourceName" | "image" | "policyVersion" | "providerCreatedAtMs" | "provider" | "appName">, image: string): boolean {
  return Number.isSafeInteger(record.providerCreatedAtMs) && createdAtMs(machine) === record.providerCreatedAtMs && intendedMachine(machine, record, image);
}
  const findOriginal = async (operationId: string, name: string, expectedImage: string): Promise<Readonly<{ kind: "found"; id: string; providerCreatedAtMs: number }> | Readonly<{ kind: "missing" | "unknown" }>> => {
    let response: Response;
    try { response = await request(`/v1/apps/${encodeURIComponent(appName)}/machines?metadata.napplet-cvm-operation=${encodeURIComponent(operationId)}&include_deleted=true`, { method: "GET" }); } catch { return Object.freeze({ kind: "unknown" as const }); }
    if (response.status === 404) { await dispose(response); return Object.freeze({ kind: "missing" as const }); }
    if (!response.ok) { await dispose(response); return Object.freeze({ kind: "unknown" as const }); }
    const machines = z.array(MachineSchema).safeParse(await responseJson(response).catch(() => undefined));
    if (!machines.success) return Object.freeze({ kind: "unknown" as const });
    const matched = machines.data.filter((machine) => {
      const metadata = machine.config.metadata;
      return machine.name === name && machine.config.image === expectedImage
        && metadata?.["napplet-cvm-operation"] === operationId
        && metadata?.["napplet-cvm-policy"] === PRODUCTION_WORKER_POLICY.version
        && metadata?.["napplet-cvm-role"] === "isolated-worker"
        && Object.keys(metadata).sort().join(",") === "napplet-cvm-operation,napplet-cvm-policy,napplet-cvm-role";
    });
    const providerCreatedAtMs = matched.length === 1 ? createdAtMs(matched[0]!) : undefined;
    return matched.length === 1 && providerCreatedAtMs ? Object.freeze({ kind: "found" as const, id: matched[0]!.id, providerCreatedAtMs }) : matched.length === 0 ? Object.freeze({ kind: "missing" as const }) : Object.freeze({ kind: "unknown" as const });
  };
  return Object.freeze({
    async create(value) {
      const operationId = OperationIdSchema.parse(value.operationId); const region = RegionSchema.parse(value.region); const image = ImageSchema.parse(value.image);
      const sessionLeaseSha256 = ImageDigestSchema.parse(value.sessionLeaseSha256);
      const toolchainSha256 = ImageDigestSchema.parse(value.toolchainSha256);
      const providerDeadlineEpochMs = z.number().int().positive().parse(value.providerDeadlineEpochMs);
      if (providerDeadlineEpochMs <= Date.now() || providerDeadlineEpochMs > Date.now() + PRODUCTION_WORKER_POLICY.totalLifetimeMs) throw new Error("WORKER_DEADLINE_INVALID");
      if (value.policy !== PRODUCTION_WORKER_POLICY || value.policy.blockNetwork !== true || value.policy.noInboundPorts !== true) throw new Error("WORKER_POLICY_IDENTITY_REQUIRED");
      const resourceName = stableName(operationId);
      const requestSha256 = await sha256(JSON.stringify({ provider: "fly", appName, operationId, region, image, policy: value.policy, sessionLeaseSha256, toolchainSha256, providerDeadlineEpochMs }));
      const claimed = await input.journal.claim({ operationId, provider: "fly", appName, requestSha256, resourceName, image, region, policyVersion: value.policy.version, createdAtMs: Date.now(), sessionLeaseSha256, toolchainSha256, providerDeadlineEpochMs });
      if (!claimed.claimed) {
        if (claimed.record.provider !== "fly" || claimed.record.appName !== appName || claimed.record.requestSha256 !== requestSha256 || claimed.record.image !== image || claimed.record.region !== region || claimed.record.policyVersion !== value.policy.version || claimed.record.sessionLeaseSha256 !== sessionLeaseSha256 || claimed.record.toolchainSha256 !== toolchainSha256 || claimed.record.providerDeadlineEpochMs !== providerDeadlineEpochMs || !Number.isSafeInteger(claimed.record.createdAtMs)) return Object.freeze({ status: "unknown" as const, operationId });
        if (claimed.record.resourceId) {
          const observed = await findOriginal(operationId, resourceName, image);
          return observed.kind === "found" && observed.id === claimed.record.resourceId && observed.providerCreatedAtMs === claimed.record.providerCreatedAtMs ? Object.freeze({ status: "reconciled" as const, operationId, resourceId: observed.id }) : Object.freeze({ status: "unknown" as const, operationId });
        }
        const found = await findOriginal(operationId, resourceName, image);
        if (found.kind !== "found") return Object.freeze({ status: "unknown" as const, operationId });
        await input.journal.update({ operationId, requestSha256: claimed.record.requestSha256, state: "reconciled", resourceId: found.id, providerCreatedAtMs: found.providerCreatedAtMs });
        return Object.freeze({ status: "reconciled" as const, operationId, resourceId: found.id });
      }
      await input.journal.update({ operationId, requestSha256, state: "dispatching" });
      const existing = await findOriginal(operationId, resourceName, image);
      if (existing.kind === "unknown") return Object.freeze({ status: "unknown" as const, operationId });
      if (existing.kind === "found") {
        await input.journal.update({ operationId, requestSha256, state: "reconciled", resourceId: existing.id, providerCreatedAtMs: existing.providerCreatedAtMs });
        return Object.freeze({ status: "reconciled" as const, operationId, resourceId: existing.id });
      }
      const body = {
        name: resourceName, region, skip_service_registration: true,
        config: {
          image, auto_destroy: true, restart: { policy: "no" }, services: [],
          guest: { cpu_kind: "shared", cpus: value.policy.cpu, memory_mb: value.policy.memoryMiB },
          init: { exec: [BOOTSTRAP, "/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(providerDeadlineEpochMs)] },
          env: { NAPPLET_CVM_POLICY_VERSION: value.policy.version },
          metadata: { "napplet-cvm-operation": operationId, "napplet-cvm-policy": value.policy.version, "napplet-cvm-role": "isolated-worker" },
        },
      };
      try {
        const response = await request(`/v1/apps/${encodeURIComponent(appName)}/machines`, { method: "POST", body: JSON.stringify(body) });
        if (!response.ok) { await dispose(response); await input.journal.update({ operationId, requestSha256, state: "unknown" }); return Object.freeze({ status: "unknown" as const, operationId }); }
        const machine = MachineSchema.safeParse(await responseJson(response).catch(() => undefined));
        if (!machine.success || !intendedMachine(machine.data, claimed.record, image)) {
          await input.journal.update({ operationId, requestSha256, state: "unknown" }); return Object.freeze({ status: "unknown" as const, operationId });
        }
        const providerCreatedAtMs = createdAtMs(machine.data);
        if (!providerCreatedAtMs) { await input.journal.update({ operationId, requestSha256, state: "unknown" }); return Object.freeze({ status: "unknown" as const, operationId }); }
        await input.journal.update({ operationId, requestSha256, state: "dispatched", resourceId: machine.data.id, providerCreatedAtMs });
        return Object.freeze({ status: "created" as const, operationId, resourceId: machine.data.id });
      } catch {
        await input.journal.update({ operationId, requestSha256, state: "unknown" });
        return Object.freeze({ status: "unknown" as const, operationId });
      }
    },
    async observe(value) {
      const record = await input.journal.read(OperationIdSchema.parse(value.operationId));
      if (!record?.resourceId || record.provider !== "fly" || record.appName !== appName) return Object.freeze({ status: record ? "unknown" as const : "missing" as const });
      const response = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}`, { method: "GET" });
      if (response.status === 404) { await dispose(response); return Object.freeze({ status: "missing" as const }); }
      if (!response.ok) { await dispose(response); return Object.freeze({ status: "unknown" as const }); }
      const machine = MachineSchema.safeParse(await responseJson(response).catch(() => undefined));
      if (!machine.success || !record.image || machine.data.id !== record.resourceId || !ownedMachine(machine.data, record, record.image) || machine.data.state !== "started") return Object.freeze({ status: "unknown" as const });
      // Readiness must be executed against the Machine ID that was durably
      // recorded.  The command is diagnostic-only and cannot initiate work.
      if (!record.sessionLeaseSha256 || !record.toolchainSha256 || !record.providerDeadlineEpochMs) return Object.freeze({ status: "unknown" as const, resourceId: record.resourceId });
      const probe = await this.exec({ operationId: record.operationId, command: [...PRODUCTION_WORKER_POLICY.probeCommand, "--session-lease-sha256", record.sessionLeaseSha256, "--provider-image", record.image, "--toolchain-sha256", record.toolchainSha256, "--provider-deadline-epoch-ms", String(record.providerDeadlineEpochMs)], timeoutSeconds: 60 });
      if (probe.status !== "completed" || probe.exitCode !== 0 || !probe.stdout) return Object.freeze({ status: "pending" as const, resourceId: record.resourceId });
      const report = z.object({ checks: z.object({ toolchain_readonly: z.literal(true), workspace_bounded: z.literal(true), non_root: z.literal(true), no_ambient_credentials: z.literal(true), network_denied: z.literal(true), no_inbound_ports: z.literal(true), minimal_capabilities: z.literal(true) }).strict(), exactReady: z.object({ image: ImageSchema, sessionLeaseSha256: ImageDigestSchema, remainingLifetimeMs: z.number().int().positive().max(PRODUCTION_WORKER_POLICY.totalLifetimeMs), toolchainSha256: ImageDigestSchema }).strict() }).strict().safeParse(JSON.parse(probe.stdout));
      if (!report.success || report.data.exactReady.image !== record.image || report.data.exactReady.sessionLeaseSha256 !== record.sessionLeaseSha256 || report.data.exactReady.toolchainSha256 !== record.toolchainSha256 || report.data.exactReady.remainingLifetimeMs > PRODUCTION_WORKER_POLICY.totalLifetimeMs) return Object.freeze({ status: "unknown" as const, resourceId: record.resourceId });
      // A probe from inside the Machine proves only that the image observed a
      // denied connection.  Fly's Machines response has no authoritative
      // egress-policy/version field, so it cannot establish provider network
      // enforcement. Keep this pending rather than accepting a controller or
      // worker-supplied digest as proof.
      return Object.freeze({ status: "pending" as const, resourceId: record.resourceId });
    },
    async terminate(value) {
      const operationId = OperationIdSchema.parse(value.operationId); const record = await input.journal.read(operationId);
      if (!record?.resourceId || record.provider !== "fly" || record.appName !== appName) return Object.freeze({ status: "blocked" as const });
      const before = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}`, { method: "GET" });
      if (before.status === 404) {
        await dispose(before);
        await input.journal.update({ operationId, requestSha256: record.requestSha256, state: "terminated", resourceId: record.resourceId });
        return Object.freeze({ status: "terminated" as const });
      }
      const machine = before.ok ? MachineSchema.safeParse(await responseJson(before).catch(() => undefined)) : (await dispose(before), undefined);
      const metadata = machine?.success ? machine.data.config.metadata : undefined;
      if (!machine?.success || machine.data.name !== record.resourceName || metadata?.["napplet-cvm-operation"] !== operationId
        || metadata?.["napplet-cvm-policy"] !== PRODUCTION_WORKER_POLICY.version || metadata?.["napplet-cvm-role"] !== "isolated-worker"
        || !record.image || !ownedMachine(machine.data, record, record.image)) return Object.freeze({ status: "unknown" as const });
      await input.journal.update({ operationId, requestSha256: record.requestSha256, state: "terminating", resourceId: record.resourceId });
      const removed = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}?force=true`, { method: "DELETE" });
      if (!removed.ok && removed.status !== 404) { await dispose(removed); return Object.freeze({ status: "pending" as const }); }
      await dispose(removed);
      const after = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}`, { method: "GET" });
      if (after.status !== 404) { await dispose(after); return Object.freeze({ status: "pending" as const }); }
      await dispose(after);
      await input.journal.update({ operationId, requestSha256: record.requestSha256, state: "terminated", resourceId: record.resourceId });
      return Object.freeze({ status: "terminated" as const });
    },
    async exec(value) {
      const operationId = OperationIdSchema.parse(value.operationId); const record = await input.journal.read(operationId);
      const command = z.array(z.string().min(1).max(256)).min(1).max(12).parse(value.command);
      const stdin = z.string().max(32 * 1024).parse(value.stdin ?? "");
      const timeout = z.number().int().min(1).max(60).parse(value.timeoutSeconds ?? 60);
      if (!record?.resourceId || record.provider !== "fly" || record.appName !== appName || !record.image) return Object.freeze({ status: "unknown" as const });
      try {
        const before = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}`, { method: "GET" });
        const machine = before.ok ? MachineSchema.safeParse(await responseJson(before)) : (await dispose(before), undefined);
        if (!machine?.success || !ownedMachine(machine.data, record, record.image)) return Object.freeze({ status: "unknown" as const });
        const response = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}/exec`, { method: "POST", body: JSON.stringify({ command: isolatedExec(command), stdin, timeout }) });
        if (!response.ok) { await dispose(response); return Object.freeze({ status: "unknown" as const }); }
        const body = z.object({ stdout: z.string().max(MAX_PROVIDER_RESPONSE_BYTES).optional(), stderr: z.string().max(MAX_PROVIDER_RESPONSE_BYTES).optional(), exit_code: z.number().int().optional(), exitCode: z.number().int().optional() }).passthrough().safeParse(await responseJson(response));
        const exitCode = body.success ? (body.data.exit_code ?? body.data.exitCode) : undefined;
        return body.success && exitCode !== undefined ? Object.freeze({ status: "completed" as const, ...(body.data.stdout !== undefined ? { stdout: body.data.stdout } : {}), ...(body.data.stderr !== undefined ? { stderr: body.data.stderr } : {}), exitCode }) : Object.freeze({ status: "unknown" as const });
      } catch { return Object.freeze({ status: "unknown" as const }); }
    },
  });
}

export function createWorkerDeploymentClients(input: Readonly<{
  image: string;
  workspaceRoot: string;
  policyVersion: string;
  modalAppName: string;
  modalTags: Readonly<Record<string, string>>;
  modalRegions?: readonly string[];
  journal: WorkerOperationJournal;
  modalSdk: ModalSdkPort;
  fly: FlyMachinesHttpTransport;
}>) {
  const image = ImageSchema.parse(input.image);
  if (input.workspaceRoot !== PRODUCTION_WORKER_POLICY.workspaceRoot || input.policyVersion !== PRODUCTION_WORKER_POLICY.version) throw new Error("WORKER_CLIENT_CONFIG_INVALID");
  const definition = Object.freeze({ ...WORKER_RUNNER_DEFINITION });
  const modalTransport = createModalProductionTransport({ appName: input.modalAppName, image, workspaceRoot: input.workspaceRoot, tags: input.modalTags, ...(input.modalRegions ? { regions: input.modalRegions } : {}), sdk: input.modalSdk, journal: input.journal });
  return Object.freeze({
    selection: Object.freeze({ status: "unselected" as const, reasonCode: "FRESH_PROTECTED_EVIDENCE_REQUIRED" as const }),
    modal: Object.freeze({ definition, schedules: LOCKED_WORKER_SCHEDULE, create: modalTransport.create, observe: modalTransport.observe, terminate: modalTransport.terminate, exec: modalTransport.exec, config: Object.freeze({ image, workspaceRoot: input.workspaceRoot, policyVersion: input.policyVersion }) }),
    fly: Object.freeze({ definition, schedules: LOCKED_WORKER_SCHEDULE, create: (operation: Readonly<{ operationId: string; region: string; sessionLeaseSha256: string; toolchainSha256: string; providerDeadlineEpochMs: number }>) => input.fly.create({ ...operation, image, policy: PRODUCTION_WORKER_POLICY }), observe: input.fly.observe, terminate: input.fly.terminate, exec: input.fly.exec, config: Object.freeze({ image, workspaceRoot: input.workspaceRoot, policyVersion: input.policyVersion }) }),
  });
}
