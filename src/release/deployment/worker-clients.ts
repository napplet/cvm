import { z } from "zod";
import type { ModalSdkPort } from "../../worker-adapters/modal-worker";
import { PRODUCTION_WORKER_POLICY, type ProductionWorkerPolicy } from "../../worker-adapters/production-worker-policy";

const ImageSchema = z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu);
const AppNameSchema = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u);
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,48}$/u);
const RegionSchema = z.string().regex(/^[a-z0-9-]{2,32}$/u);
const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{3,128}$/u);
const COHORTS = ["pool_hit", "pool_miss", "cold", "step_load", "contention", "reclaim", "ambiguity", "cleanup", "failure"] as const;

export { PRODUCTION_WORKER_POLICY };
export type FlyFetch = (url: string, init: RequestInit) => Promise<Response>;
export type WorkerSchedule = Readonly<{ id: string; cohort: typeof COHORTS[number] }>;

/** Mirrors the verifier's schedule exactly: 1,000 total accepted samples,
 * then a 200 pool-hit forced cohort and a 200 pool-miss/cold/contention cohort. */
export const LOCKED_WORKER_SCHEDULE: readonly WorkerSchedule[] = Object.freeze(Array.from({ length: 1_000 }, (_, index) => Object.freeze({
  id: `benchmark-${index + 1}`,
  cohort: index < 200
    ? "pool_hit"
    : index < 400
      ? (["pool_miss", "cold", "contention"] as const)[index % 3]!
      : COHORTS[index % COHORTS.length]!,
})));

/** The immutable cross-provider envelope. It is construction evidence only;
 * selection remains impossible without fresh protected cohort evidence. */
export const WORKER_RUNNER_DEFINITION = Object.freeze({
  ...PRODUCTION_WORKER_POLICY,
  durableBacklog: 0 as const,
});

type WorkerOperationState = "claimed" | "dispatching" | "dispatched" | "reconciled" | "unknown" | "terminated";
export type WorkerOperationRecord = Readonly<{
  operationId: string;
  requestSha256: string;
  state: WorkerOperationState;
  resourceName: string;
  resourceId?: string;
}>;
/** This is a controller persistence port. Production injects a durable CAS
 * implementation; the in-memory version below is limited to contract tests. */
export type WorkerOperationJournal = Readonly<{
  claim(record: Omit<WorkerOperationRecord, "state" | "resourceId">): Promise<Readonly<{ claimed: boolean; record: WorkerOperationRecord }>>;
  read(operationId: string): Promise<WorkerOperationRecord | undefined>;
  update(input: Readonly<{ operationId: string; requestSha256: string; state: WorkerOperationState; resourceId?: string }>): Promise<WorkerOperationRecord>;
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
      const next = Object.freeze({ ...current, state: input.state, ...(input.resourceId ? { resourceId: ResourceIdSchema.parse(input.resourceId) } : {}) });
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
  config: z.object({ image: ImageSchema, metadata: z.record(z.string(), z.string()).optional() }).passthrough(),
}).passthrough();

export type FlyCreateResult = Readonly<{ status: "created" | "reconciled"; operationId: string; resourceId: string }> | Readonly<{ status: "unknown"; operationId: string }>;
export type FlyMachinesHttpTransport = Readonly<{
  create(input: Readonly<{ operationId: string; region: string; image: string; policy: ProductionWorkerPolicy }>): Promise<FlyCreateResult>;
  observe(input: Readonly<{ operationId: string }>): Promise<Readonly<{ status: "missing" | "pending" | "completed" | "unknown"; resourceId?: string }>>;
  terminate(input: Readonly<{ operationId: string }>): Promise<Readonly<{ status: "terminated" | "pending" | "unknown" | "blocked" }>>;
}>;

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
}>): FlyMachinesHttpTransport {
  const appName = AppNameSchema.parse(input.appName);
  const base = new URL(input.apiOrigin ?? "https://api.machines.dev");
  if (base.origin !== "https://api.machines.dev" || base.pathname !== "/" || base.search || base.username || base.password) throw new Error("FLY_API_ORIGIN_INVALID");
  const request = async (path: string, init: RequestInit) => {
    const token = await input.getAccessToken();
    if (typeof token !== "string" || token.length < 12 || /\s/u.test(token)) throw new Error("FLY_ACCESS_TOKEN_INVALID");
    return input.fetch(new URL(path, base).toString(), {
      ...init,
      redirect: "error",
      headers: Object.freeze({ authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) }),
    });
  };
  const findOriginal = async (operationId: string, name: string, expectedImage: string): Promise<Readonly<{ kind: "found"; id: string }> | Readonly<{ kind: "missing" | "unknown" }>> => {
    let response: Response;
    try { response = await request(`/v1/apps/${encodeURIComponent(appName)}/machines?metadata.napplet-cvm-operation=${encodeURIComponent(operationId)}&include_deleted=true`, { method: "GET" }); } catch { return Object.freeze({ kind: "unknown" as const }); }
    if (response.status === 404) return Object.freeze({ kind: "missing" as const });
    if (!response.ok) return Object.freeze({ kind: "unknown" as const });
    const machines = z.array(MachineSchema).safeParse(await response.json().catch(() => undefined));
    if (!machines.success) return Object.freeze({ kind: "unknown" as const });
    const matched = machines.data.filter((machine) => {
      const metadata = machine.config.metadata;
      return machine.name === name && machine.config.image === expectedImage
        && metadata?.["napplet-cvm-operation"] === operationId
        && metadata?.["napplet-cvm-policy"] === PRODUCTION_WORKER_POLICY.version
        && metadata?.["napplet-cvm-role"] === "isolated-worker"
        && Object.keys(metadata).sort().join(",") === "napplet-cvm-operation,napplet-cvm-policy,napplet-cvm-role";
    });
    return matched.length === 1 ? Object.freeze({ kind: "found" as const, id: matched[0]!.id }) : matched.length === 0 ? Object.freeze({ kind: "missing" as const }) : Object.freeze({ kind: "unknown" as const });
  };
  return Object.freeze({
    async create(value) {
      const operationId = OperationIdSchema.parse(value.operationId); const region = RegionSchema.parse(value.region); const image = ImageSchema.parse(value.image);
      if (value.policy !== PRODUCTION_WORKER_POLICY || value.policy.blockNetwork !== true || value.policy.noInboundPorts !== true) throw new Error("WORKER_POLICY_IDENTITY_REQUIRED");
      const resourceName = stableName(operationId);
      const requestSha256 = await sha256(JSON.stringify({ operationId, region, image, policy: value.policy.version }));
      const claimed = await input.journal.claim({ operationId, requestSha256, resourceName });
      if (!claimed.claimed) {
        if (claimed.record.requestSha256 !== requestSha256) return Object.freeze({ status: "unknown" as const, operationId });
        if (claimed.record.resourceId) {
          const observed = await findOriginal(operationId, resourceName, image);
          return observed.kind === "found" && observed.id === claimed.record.resourceId ? Object.freeze({ status: "reconciled" as const, operationId, resourceId: observed.id }) : Object.freeze({ status: "unknown" as const, operationId });
        }
        const found = await findOriginal(operationId, resourceName, image);
        if (found.kind !== "found") return Object.freeze({ status: "unknown" as const, operationId });
        await input.journal.update({ operationId, requestSha256: claimed.record.requestSha256, state: "reconciled", resourceId: found.id });
        return Object.freeze({ status: "reconciled" as const, operationId, resourceId: found.id });
      }
      await input.journal.update({ operationId, requestSha256, state: "dispatching" });
      const existing = await findOriginal(operationId, resourceName, image);
      if (existing.kind === "unknown") return Object.freeze({ status: "unknown" as const, operationId });
      if (existing.kind === "found") {
        await input.journal.update({ operationId, requestSha256, state: "reconciled", resourceId: existing.id });
        return Object.freeze({ status: "reconciled" as const, operationId, resourceId: existing.id });
      }
      const body = {
        name: resourceName, region, skip_service_registration: true,
        config: {
          image, auto_destroy: true, restart: { policy: "no" }, services: [],
          guest: { cpu_kind: "shared", cpus: value.policy.cpu, memory_mb: value.policy.memoryMiB },
          init: { exec: ["/usr/local/bin/napplet-cvm-bootstrap", "/bin/sh", "-c", "while true; do sleep 60; done"] },
          env: { NAPPLET_CVM_POLICY_VERSION: value.policy.version },
          metadata: { "napplet-cvm-operation": operationId, "napplet-cvm-policy": value.policy.version, "napplet-cvm-role": "isolated-worker" },
        },
      };
      try {
        const response = await request(`/v1/apps/${encodeURIComponent(appName)}/machines`, { method: "POST", body: JSON.stringify(body) });
        if (!response.ok) { await input.journal.update({ operationId, requestSha256, state: "unknown" }); return Object.freeze({ status: "unknown" as const, operationId }); }
        const machine = MachineSchema.safeParse(await response.json());
        if (!machine.success || machine.data.name !== resourceName || machine.data.config.image !== image || machine.data.config.metadata?.["napplet-cvm-operation"] !== operationId) {
          await input.journal.update({ operationId, requestSha256, state: "unknown" }); return Object.freeze({ status: "unknown" as const, operationId });
        }
        await input.journal.update({ operationId, requestSha256, state: "dispatched", resourceId: machine.data.id });
        return Object.freeze({ status: "created" as const, operationId, resourceId: machine.data.id });
      } catch {
        await input.journal.update({ operationId, requestSha256, state: "unknown" });
        return Object.freeze({ status: "unknown" as const, operationId });
      }
    },
    async observe(value) {
      const record = await input.journal.read(OperationIdSchema.parse(value.operationId));
      if (!record?.resourceId) return Object.freeze({ status: record ? "unknown" as const : "missing" as const });
      const response = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}`, { method: "GET" });
      if (response.status === 404) return Object.freeze({ status: "missing" as const });
      if (!response.ok) return Object.freeze({ status: "unknown" as const });
      const machine = MachineSchema.safeParse(await response.json());
      if (!machine.success || machine.data.id !== record.resourceId || machine.data.name !== record.resourceName) return Object.freeze({ status: "unknown" as const });
      return Object.freeze({ status: "completed" as const, resourceId: record.resourceId });
    },
    async terminate(value) {
      const operationId = OperationIdSchema.parse(value.operationId); const record = await input.journal.read(operationId);
      if (!record?.resourceId) return Object.freeze({ status: "blocked" as const });
      const before = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}`, { method: "GET" });
      const machine = before.ok ? MachineSchema.safeParse(await before.json()) : undefined;
      const metadata = machine?.success ? machine.data.config.metadata : undefined;
      if (!machine?.success || machine.data.name !== record.resourceName || metadata?.["napplet-cvm-operation"] !== operationId
        || metadata?.["napplet-cvm-policy"] !== PRODUCTION_WORKER_POLICY.version || metadata?.["napplet-cvm-role"] !== "isolated-worker"
        || Object.keys(metadata).sort().join(",") !== "napplet-cvm-operation,napplet-cvm-policy,napplet-cvm-role") return Object.freeze({ status: "unknown" as const });
      const removed = await request(`/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(record.resourceId)}?force=true`, { method: "DELETE" });
      if (!removed.ok && removed.status !== 404) return Object.freeze({ status: "pending" as const });
      await input.journal.update({ operationId, requestSha256: record.requestSha256, state: "terminated", resourceId: record.resourceId });
      return Object.freeze({ status: "terminated" as const });
    },
  });
}

export function createWorkerDeploymentClients(input: Readonly<{
  image: string;
  workspaceRoot: string;
  policyVersion: string;
  modalSdk: ModalSdkPort;
  fly: FlyMachinesHttpTransport;
}>) {
  const image = ImageSchema.parse(input.image);
  if (input.workspaceRoot !== PRODUCTION_WORKER_POLICY.workspaceRoot || input.policyVersion !== PRODUCTION_WORKER_POLICY.version) throw new Error("WORKER_CLIENT_CONFIG_INVALID");
  const definition = Object.freeze({ ...WORKER_RUNNER_DEFINITION });
  return Object.freeze({
    selection: Object.freeze({ status: "unselected" as const, reasonCode: "FRESH_PROTECTED_EVIDENCE_REQUIRED" as const }),
    modal: Object.freeze({ definition, schedules: LOCKED_WORKER_SCHEDULE, sdk: input.modalSdk, config: Object.freeze({ image, workspaceRoot: input.workspaceRoot, policyVersion: input.policyVersion }) }),
    fly: Object.freeze({ definition, schedules: LOCKED_WORKER_SCHEDULE, create: (operation: Readonly<{ operationId: string; region: string }>) => input.fly.create({ ...operation, image, policy: PRODUCTION_WORKER_POLICY }), observe: input.fly.observe, terminate: input.fly.terminate, config: Object.freeze({ image, workspaceRoot: input.workspaceRoot, policyVersion: input.policyVersion }) }),
  });
}
