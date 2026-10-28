import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { validateAuthorizationReceipt, validateAuthorizationRequest, ReleaseAuthorizationReceiptSchema } from "../release/authorization";
import type { ReleaseProviderPort } from "../release/providers";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { assertProductionReadyCapacity, type ProductionReadyCapacityPort } from "./worker-capacity";
import type { ProductionGenerationRuntime } from "./generation-runtime";

export type ProductionWorkerLifecyclePort = Pick<ReleaseProviderPort, "plan" | "apply" | "observe"> & Readonly<{
  cleanup(input: Parameters<ReleaseProviderPort["cleanup"]>[0]): Promise<Readonly<{ status: "cleaned" | "pending" | "blocked" }>>;
  observeCleanup(input: Parameters<ReleaseProviderPort["cleanup"]>[0]): Promise<Readonly<{ status: "cleaned" | "pending" | "blocked" }>>;
}>;
const lifecycles = new WeakSet<object>();
export function assertProductionWorkerLifecycle(value: unknown): asserts value is ProductionWorkerLifecyclePort {
  if (!value || typeof value !== "object" || !lifecycles.has(value)) throw new Error("PRODUCTION_WORKER_LIFECYCLE_REQUIRED");
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const Plan = z.object({ operationId: z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u), effectId: z.string().min(1).max(128), region: z.string().min(1).max(64), desiredDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

/** Uses exactly the same isolated worker authority as funded admission.
 * Allocation and termination have separate durable dispatch claims. Reads
 * may recover originals after expiry but cannot dispatch either effect.
 * This layer observes resources only; it never invents a provider bill. */
export function createProductionWorkerLifecycle(input: Readonly<{
  provider: "modal" | "fly"; capacity: ProductionReadyCapacityPort; journal: PostgresOperationJournal;
  authorization: ProductionGenerationRuntime["authorization"]; estimatedCostMicros: number; now?: () => number;
}>): ProductionWorkerLifecyclePort {
  assertProductionReadyCapacity(input.capacity); assertPostgresOperationJournal(input.journal);
  z.enum(["modal", "fly"]).parse(input.provider);
  z.number().int().nonnegative().safe().parse(input.estimatedCostMicros);
  const scope = input.authorization.authorizationRequestSha256;
  const key = (id: string) => `worker-lifecycle:${hash({ scope, provider: input.provider, id })}`;
  const facts = (plan: z.infer<typeof Plan>) => {
    const binding = hash({ scope, provider: input.provider, plan });
    return { intentReference: `capacity-intent:${binding}`, expectedSessionBindingDigest: `sha256:${hash({ binding, purpose: "release-worker" })}` };
  };
  const authorize = async (readOnly: boolean) => {
    const request = await validateAuthorizationRequest(input.authorization.request);
    const receipt = ReleaseAuthorizationReceiptSchema.parse(input.authorization.receipt);
    const now = (input.now ?? Date.now)();
    await validateAuthorizationReceipt({ request, receipt, nowMs: readOnly ? Math.min(now, receipt.expiresAtMs - 1) : now });
    if (request.authorizationRequestSha256 !== scope || receipt.authorizationReceiptSha256 !== input.authorization.authorizationReceiptSha256 || !request.providerScopes.some(value => value.provider === input.provider) || !request.orderedEffects.some(value => value.provider === input.provider)) throw new Error("WORKER_LIFECYCLE_AUTHORIZATION_REQUIRED");
  };
  const load = async (operationId: string) => {
    Plan.shape.operationId.parse(operationId);
    const record = await input.journal.read<z.infer<typeof Plan>>(key(operationId));
    if (record && (record.identitySha256 !== hash(Plan.parse(record.value)) || record.value.operationId !== operationId)) throw new Error("WORKER_LIFECYCLE_ORIGINAL_CHANGED");
    return record;
  };
  const observe = async (operationId: string) => {
    const original = await load(operationId);
    if (!original) return { status: "missing" as const };
    const value = facts(original.value);
    const record = await input.capacity.inspect(value);
    if (!record) return { status: "pending" as const };
    if (record.provider !== input.provider || record.expectedSessionBindingDigest !== value.expectedSessionBindingDigest) throw new Error("WORKER_LIFECYCLE_RESOURCE_CHANGED");
    const ready = await input.capacity.observe({ ...value, reference: record.reference });
    return { status: ready.status === "available" ? "completed" as const : ready.status === "refused" ? "missing" as const : "unknown" as const, resourceIdentitySha256: hash({ provider: record.provider, intentReference: record.intentReference, reference: record.reference, workerOperationId: record.workerOperationId }) };
  };
  const port = Object.freeze<ProductionWorkerLifecyclePort>({
    async plan(raw) {
      await authorize(true);
      const plan = Plan.parse(raw);
      await input.journal.claim(key(plan.operationId), hash(plan), plan);
      return { status: "planned" as const, estimatedCostMicros: input.estimatedCostMicros };
    },
    async apply(raw) {
      await authorize(true);
      const plan = Plan.parse(raw), original = await load(plan.operationId);
      if (!original || original.identitySha256 !== hash(plan)) throw new Error("WORKER_LIFECYCLE_ORIGINAL_REQUIRED");
      const dispatchKey = `${key(plan.operationId)}:dispatch`;
      if (!await input.journal.read(dispatchKey)) {
        await authorize(false);
        const claim = await input.journal.claim(dispatchKey, original.identitySha256, { operationId: plan.operationId });
        if (claim.claimed) { await authorize(false); await input.capacity.reserveNow(facts(plan)); }
      }
      const result = await observe(plan.operationId);
      return { ...result, status: result.status === "completed" ? "applied" as const : "unknown" as const };
    },
    async observe(value) { await authorize(true); return observe(value.operationId); },
    async observeCleanup(value) {
      await authorize(true);
      const original = await load(value.operationId);
      if (!original) return { status: "blocked" as const };
      const binding = facts(original.value), record = await input.capacity.inspect(binding);
      if (!record || record.provider !== input.provider || record.expectedSessionBindingDigest !== binding.expectedSessionBindingDigest) return { status: "blocked" as const };
      const identity = hash({ provider: record.provider, intentReference: record.intentReference, reference: record.reference, workerOperationId: record.workerOperationId });
      if (value.resourceIdentitySha256 !== identity) throw new Error("WORKER_LIFECYCLE_RESOURCE_CHANGED");
      const status = await input.capacity.observeRelease({ intentReference: record.intentReference, reference: record.reference });
      return { status: status.status === "terminated" ? "cleaned" as const : "pending" as const };
    },
    async cleanup(value) {
      await authorize(true);
      const original = await load(value.operationId);
      if (!original) return { status: "blocked" as const };
      const binding = facts(original.value), record = await input.capacity.inspect(binding);
      if (!record || record.provider !== input.provider || record.expectedSessionBindingDigest !== binding.expectedSessionBindingDigest) return { status: "blocked" as const };
      const identity = hash({ provider: record.provider, intentReference: record.intentReference, reference: record.reference, workerOperationId: record.workerOperationId });
      if (value.resourceIdentitySha256 !== undefined && value.resourceIdentitySha256 !== identity) throw new Error("WORKER_LIFECYCLE_RESOURCE_CHANGED");
      const release = { intentReference: record.intentReference, reference: record.reference };
      if ((await input.capacity.observeRelease(release)).status === "terminated") return { status: "cleaned" as const };
      const cleanupKey = `${key(value.operationId)}:cleanup`;
      if (await input.journal.read(cleanupKey)) return { status: "pending" as const };
      await authorize(false);
      const claim = await input.journal.claim(cleanupKey, identity, release);
      if (!claim.claimed) return { status: "pending" as const };
      await authorize(false); await input.capacity.release(release);
      return { status: (await input.capacity.observeRelease(release)).status === "terminated" ? "cleaned" as const : "pending" as const };
    },
  });
  lifecycles.add(port);
  return port;
}
