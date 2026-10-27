import { createHash } from "node:crypto";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "./postgres-operation-journal";
import type { GoogleOperationJournal, GoogleOperationRecord } from "./google-clients";
import type { WorkerOperationJournal, WorkerOperationRecord } from "./worker-clients";
import type { VertexOperationJournal } from "./vertex-client";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
const clean = <T>(value: T): T => JSON.parse(canonical(value));
const identity = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function retainFacts<T extends object>(current: T, patch: Partial<T>, fields: readonly (keyof T)[]): void {
  for (const field of fields) if (current[field] !== undefined && patch[field] !== undefined && canonical(current[field]) !== canonical(patch[field])) throw new Error("PROVIDER_OPERATION_IDENTITY_CONFLICT");
}
async function update<T>(journal: PostgresOperationJournal, operationId: string, transform: (current: T) => T): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const record = await journal.read<T>(operationId);
    if (!record) throw new Error("PROVIDER_OPERATION_MISSING");
    const next = clean(transform(record.value));
    if (canonical(next) === canonical(record.value)) return record.value;
    const saved = await journal.compareAndSet(operationId, record.identitySha256, record.revision, next);
    if (saved) return saved.value;
  }
  throw new Error("PROVIDER_OPERATION_CAS_EXHAUSTED");
}

export function createPostgresGoogleOperationJournal(journal: PostgresOperationJournal): GoogleOperationJournal {
  assertPostgresOperationJournal(journal);
  const rank = { claimed: 0, dispatching: 1, unknown: 1, dispatched: 2, completed: 3 };
  const patch = (operationId: string, requestSha256: string, changes: Partial<GoogleOperationRecord>) => update<GoogleOperationRecord>(journal, operationId, current => {
    if (current.requestSha256 !== requestSha256) throw new Error("PROVIDER_OPERATION_IDENTITY_CONFLICT");
    retainFacts(current, changes, ["operationName", "generation", "resourceUid", "createTime"]);
    return { ...current, ...changes, state: changes.state && rank[changes.state] > rank[current.state] ? changes.state : current.state, owned: current.owned || changes.owned === true };
  });
  return Object.freeze({
    async claim(input) { const claimed = await journal.claim(input.operationId, identity(input), clean({ ...input, state: "claimed" as const })); return { claimed: claimed.claimed, record: claimed.record.value }; },
    async read(id) { return (await journal.read<GoogleOperationRecord>(id))?.value; },
    markDispatching: input => patch(input.operationId, input.requestSha256, { state: "dispatching" }),
    markDispatched: input => patch(input.operationId, input.requestSha256, clean({ state: "dispatched", operationName: input.operationName })),
    markCompleted: input => patch(input.operationId, input.requestSha256, clean({ state: "completed", generation: input.generation, resourceUid: input.resourceUid, createTime: input.createTime, owned: input.owned })),
  });
}

export function createPostgresWorkerOperationJournal(journal: PostgresOperationJournal): WorkerOperationJournal {
  assertPostgresOperationJournal(journal);
  const rank = { claimed: 0, dispatching: 1, unknown: 2, dispatched: 3, reconciled: 4, terminating: 5, terminated: 6 };
  return Object.freeze({
    async claim(input) { const claimed = await journal.claim(input.operationId, identity(input), clean({ ...input, state: "claimed" as const })); return { claimed: claimed.claimed, record: claimed.record.value }; },
    async read(id) { return (await journal.read<WorkerOperationRecord>(id))?.value; },
    async update(input) { return update<WorkerOperationRecord>(journal, input.operationId, current => {
      if (current.requestSha256 !== input.requestSha256) throw new Error("PROVIDER_OPERATION_IDENTITY_CONFLICT");
      retainFacts(current, input, ["resourceId", "providerCreatedAtMs"]);
      return { ...current, ...clean(input), state: rank[input.state] > rank[current.state] ? input.state : current.state };
    }); },
  });
}

type VertexEntry = Parameters<VertexOperationJournal["write"]>[0];
function vertexIdentity(entry: VertexEntry) { const { interactionId: _id, completedReceipt: _receipt, ...facts } = entry; return identity(facts); }
export function createPostgresVertexOperationJournal(journal: PostgresOperationJournal): VertexOperationJournal {
  assertPostgresOperationJournal(journal);
  return Object.freeze({
    async claim(entry) {
      if (entry.interactionId !== undefined || entry.completedReceipt !== undefined) throw new Error("VERTEX_INITIAL_OPERATION_INVALID");
      const claimed = await journal.claim(entry.operationId, vertexIdentity(entry), clean(entry));
      return { claimed: claimed.claimed, entry: claimed.record.value };
    },
    async read(id) { return (await journal.read<VertexEntry>(id))?.value; },
    async write(entry) {
      await update<VertexEntry>(journal, entry.operationId, current => {
        if (vertexIdentity(current) !== vertexIdentity(entry)) throw new Error("PROVIDER_OPERATION_IDENTITY_CONFLICT");
        retainFacts(current, entry, ["interactionId", "completedReceipt"]);
        return { ...current, ...clean(entry) };
      });
    },
  });
}
