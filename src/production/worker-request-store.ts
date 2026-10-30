import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkerRunRequestSchema, type WorkerRunRequest } from "../phase-02/contracts";
import { canonicalJson } from "../promotion/schema";
import { assertPostgresOperationJournal, PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";

type Binding = Pick<WorkerRunRequest, "sessionId" | "actionId" | "expectedVersion" | "policyVersion" | "capabilityGrant" | "workspaceId">;
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const Stored = z.object({ request: WorkerRunRequestSchema }).strict();
const Index = z.object({ originalOperationId: z.string().regex(/^worker-request:[a-f0-9]{64}$/u), requestSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const binding = (request: Binding): Binding => ({ sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId });
const indexKey = (request: Binding) => `worker-request-index:${sha({ sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion })}`;
const restoreKey = (request: Binding) => `worker-restore-request:${sha({ sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion })}`;
const Restore = z.object({ schemaVersion: z.literal("worker-restore-request-v1"), sourceActionId: z.string().min(1),
  sourceRequestSha256: z.string().regex(/^[a-f0-9]{64}$/u), restoreRequest: WorkerRunRequestSchema }).strict();

/** Preserve full-request legacy keys, adding a correlation index for recovery. */
export class ProductionWorkerRequestStore {
  constructor(private readonly journal: PostgresOperationJournal) { assertPostgresOperationJournal(journal); }
  async persist(value: WorkerRunRequest): Promise<void> {
    const request = WorkerRunRequestSchema.parse(value), requestSha256 = sha(request), originalOperationId = `worker-request:${requestSha256}`;
    // Resolve first, including legacy originals, to refuse a changed proposal
    // before adding another full-request record to a historical action.
    const prior = await this.read(binding(request));
    if (prior && sha(prior) !== requestSha256) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    await this.journal.claim(indexKey(request), requestSha256, { originalOperationId, requestSha256 });
    await this.journal.claim(originalOperationId, requestSha256, { request });
  }
  async read(value: Binding): Promise<WorkerRunRequest | undefined> {
    const expected = binding(value), indexRecord = await this.journal.read(indexKey(expected));
    let original;
    if (indexRecord) {
      const index = Index.parse(indexRecord.value);
      if (indexRecord.identitySha256 !== index.requestSha256 || index.originalOperationId !== `worker-request:${index.requestSha256}`) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
      original = await this.journal.read(index.originalOperationId);
    } else original = await this.journal.readUniqueByObjectFields("request", { sessionId: expected.sessionId, actionId: expected.actionId, expectedVersion: expected.expectedVersion });
    if (!original) return undefined;
    const request = Stored.parse(original.value).request;
    const digest = sha(request);
    if (original.operationId !== `worker-request:${digest}` || original.identitySha256 !== digest || canonicalJson(binding(request)) !== canonicalJson(expected)) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    return request;
  }

  /** Correlate a checkpoint restore without claiming the resumed action's
   * actual run request. That request belongs to its new model proposal. */
  async persistRestore(sourceValue: WorkerRunRequest, target: Binding): Promise<void> {
    const source = WorkerRunRequestSchema.parse(sourceValue), request = WorkerRunRequestSchema.parse({ ...source, ...binding(target) });
    if (source.actionId === target.actionId || canonicalJson(binding({ ...request, actionId: source.actionId })) !== canonicalJson(binding(source)))
      throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    const original = await this.read(binding(source));
    if (!original || sha(original) !== sha(source)) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    const value = Restore.parse({ schemaVersion: "worker-restore-request-v1", sourceActionId: source.actionId, sourceRequestSha256: sha(source), restoreRequest: request });
    const saved = await this.journal.claim(restoreKey(request), sha(value), value);
    if (saved.record.revision !== 1 || canonicalJson(saved.record.value) !== canonicalJson(value)) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
  }

  async readRestore(value: Binding): Promise<WorkerRunRequest | undefined> {
    const expected = binding(value), record = await this.journal.read(restoreKey(expected));
    if (!record) return undefined;
    const stored = Restore.parse(record.value), request = stored.restoreRequest;
    if (record.revision !== 1 || record.identitySha256 !== sha(stored) || canonicalJson(binding(request)) !== canonicalJson(expected))
      throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    const original = await this.read({ ...expected, actionId: stored.sourceActionId });
    if (!original || stored.sourceActionId === request.actionId || sha(original) !== stored.sourceRequestSha256
      || sha({ ...original, actionId: request.actionId }) !== sha(request)) throw new Error("PRODUCTION_CHECKPOINT_REQUEST_BINDING_INVALID");
    return request;
  }
}
