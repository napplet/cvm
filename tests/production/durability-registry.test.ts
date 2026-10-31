import { expect, test } from "bun:test";
import { createProductionDurabilitySubjectRegistry } from "../../src/production/durability-registry";
import { DURABILITY_SUBJECT_KINDS } from "../../src/resilience/fault-harness";
import { ProductionRestoreCertification } from "../../src/production/restore-certification";
import { ProductionMigrationSource, MigrationArchiveCipher } from "../../src/production/migration-control";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { DeterministicObjectStore } from "../../src/continuity/object-store";

import { scriptedSqlPool } from "../fixtures/scripted-sql-pool";

const digest = "a".repeat(64);

test("durability inventory is keyed by its original checkpoint, not a latest action", async () => {
  const subjects: Record<string, unknown>[] = [];
  const pool = scriptedSqlPool(async (text, values = []) => {
    if (text.includes("session_user::text AS session_user")) return { rows: [{ current_user: "napplet_runtime", session_user: "napplet_runtime", current_is_superuser: false, session_is_superuser: false }] };
    if (text === "SELECT current_user::text AS current_user") return { rows: [{ current_user: "napplet_production_real" }] };
    if (text.startsWith("SET ROLE") || text.startsWith("SET search_path")) return { rows: [] };
    if (text.startsWith("INSERT")) {
      const exists = subjects.some(row => row.checkpoint_id === values[0] && row.kind === values[1]);
      if (!exists) subjects.push({ checkpoint_id: values[0], kind: values[1], source_identity: values[2], object_key: values[3], object_generation: values[4], object_checksum: values[5], payload_sha256: values[6], owner_id: values[7], session_id: values[8], action_id: values[9], retention_until: values[10], deletion_state: values[11] });
      return { rows: exists ? [] : [{ checkpoint_id: values[0] }] };
    }
    if (text.startsWith("SELECT checkpoint_id")) return { rows: subjects.filter(row => row.checkpoint_id === values[0] && row.kind === values[1]) };
    if (text.startsWith("SELECT kind")) return { rows: subjects.filter(row => row.checkpoint_id === values[0] && row.session_id === values[1] && row.owner_id === values[2]) };
    if (text.startsWith("SELECT deletion_state")) return { rows: subjects.filter(row => row.checkpoint_id === values[0] && row.kind === values[1] && row.object_generation === values[2] && row.object_checksum === values[3]) };
    if (text.startsWith("UPDATE")) {
      const row = subjects.find(row => row.checkpoint_id === values[0] && row.kind === values[1] && row.object_generation === values[2] && row.object_checksum === values[3] && (row.deletion_state === "retained" || (row.deletion_state === "tombstoned" && values[4] === "deleted")));
      if (row) row.deletion_state = values[4];
      return { rows: row ? [{ checkpoint_id: values[0] }] : [] };
    }
    throw new Error(`unexpected query ${text}`);
  });
  const registry = createProductionDurabilitySubjectRegistry(pool);
  for (const deletionState of ["tombstoned", "deleted"] as const) {
    await expect(registry.register({ checkpointId: `checkpoint-${deletionState}`, sessionId: "session-original", actionId: "action-original", kind: "checkpoint",
      sourceIdentity: `source:${deletionState}`, object: { key: `objects/${deletionState}`, generation: 1, checksum: digest }, payloadSha256: digest,
      ownerId: "owner-original", retentionUntil: "2030-01-01T00:00:00.000Z", deletionState })).rejects.toThrow("PRODUCTION_DURABILITY_SUBJECT_INITIAL_RETAINED_REQUIRED");
  }
  expect(subjects).toHaveLength(0);
  for (const [index, kind] of DURABILITY_SUBJECT_KINDS.entries()) await registry.register({ checkpointId: "checkpoint-original", sessionId: "session-original", actionId: "action-original", kind, sourceIdentity: `source:${kind}`, object: { key: `objects/${kind}`, generation: index + 1, checksum: digest }, payloadSha256: digest, ownerId: "owner-original", retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained" });
  expect(await registry.inventory({ checkpointId: "checkpoint-original", sessionId: "session-original", ownerId: "owner-original" })).toHaveLength(7);
  await expect(registry.inventory({ checkpointId: "checkpoint-later", sessionId: "session-original", ownerId: "owner-original" })).rejects.toThrow();
  await registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 1, objectChecksum: digest, state: "tombstoned" });
  await expect(registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 2, objectChecksum: digest, state: "deleted" })).rejects.toThrow("PRODUCTION_DURABILITY_DELETE_BINDING_REQUIRED");
  await registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 1, objectChecksum: digest, state: "deleted" });
  await registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 1, objectChecksum: digest, state: "deleted" });
  await expect(registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 1, objectChecksum: digest, state: "tombstoned" })).rejects.toThrow("PRODUCTION_DURABILITY_DELETE_BINDING_REQUIRED");
});

test("restore exposes receipt-bound preparation separately from its read-only seven-subject inventory", async () => {
  const subjects: Record<string, unknown>[] = [];
  const pool = scriptedSqlPool(async (text, values = []) => {
    if (text.includes("session_user::text AS session_user")) return { rows: [{ current_user: "napplet_runtime", session_user: "napplet_runtime", current_is_superuser: false, session_is_superuser: false }] };
    if (text === "SELECT current_user::text AS current_user") return { rows: [{ current_user: "napplet_production_real" }] };
    if (text.startsWith("SET ROLE") || text.startsWith("SET search_path")) return { rows: [] };
    if (text.startsWith("INSERT")) {
      const exists = subjects.some(row => row.checkpoint_id === values[0] && row.kind === values[1]);
      if (!exists) subjects.push({ checkpoint_id: values[0], kind: values[1], source_identity: values[2], object_key: values[3], object_generation: values[4], object_checksum: values[5], payload_sha256: values[6], owner_id: values[7], session_id: values[8], action_id: values[9], retention_until: values[10], deletion_state: values[11] });
      return { rows: exists ? [] : [{ checkpoint_id: values[0] }] };
    }
    if (text.startsWith("SELECT checkpoint_id")) return { rows: subjects.filter(row => row.checkpoint_id === values[0] && row.kind === values[1]) };
    if (text.startsWith("SELECT kind")) return { rows: subjects.filter(row => row.checkpoint_id === values[0] && row.session_id === values[1] && row.owner_id === values[2]) };
    throw new Error(`unexpected query ${text}`);
  });
  const scope = { checkpointId: "checkpoint-prepared", sessionId: "session-prepared", ownerId: "owner-prepared" };
  const registry = createProductionDurabilitySubjectRegistry(pool);
  for (const [index, kind] of DURABILITY_SUBJECT_KINDS.entries()) await registry.register({ ...scope, actionId: "action-prepared", kind,
    sourceIdentity: `source:${kind}`, object: { key: `objects/${kind}`, generation: index + 1, checksum: digest }, payloadSha256: digest,
    retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained" });
  let prepared = 0;
  const restore = new ProductionRestoreCertification({ sourceInstanceId: "source-prepared", scope, sourcePool: pool,
    migrationSource: new ProductionMigrationSource({ pool, source: { sourceIdentity: "source-prepared", serviceIdentity: digest, sourceRevision: digest, schemaVersions: [], migrationDigests: {}, writers: [], records: [], objects: [], externalOperations: [] } }),
    migrationCipher: new MigrationArchiveCipher(new Uint8Array(32).fill(1)), backupStore: new DeterministicObjectStore(),
    journal: new PostgresOperationJournal(pool, { namespace: "prepared-inventory", scopeSha256: digest }),
    provisioner: { async create() { throw new Error("PROVIDER_EFFECT_DENIED"); }, async attach() { throw new Error("PROVIDER_EFFECT_DENIED"); }, async observeCleanup() { throw new Error("PROVIDER_EFFECT_DENIED"); } },
    candidateSha256: digest, topologySha256: digest,
    retainedSubjects: { async prepare(actual) { prepared++; expect(actual).toEqual(scope); } },
  });
  await expect(restore.restore({ operationId: "prepared-inventory", action: "restore.inventory", payload: {} })).rejects.toThrow("PRODUCTION_RETAINED_SUBJECT_PREPARATION_REQUIRED");
  expect(prepared).toBe(0);
  await expect(restore.restore({ operationId: "prepared-effect", action: "restore.prepare", payload: {} })).resolves.toEqual({ status: "prepared" });
  const inventory = await restore.restore({ operationId: "prepared-inventory-after-effect", action: "restore.inventory", payload: {} });
  expect(inventory).toHaveLength(7);
  expect(prepared).toBe(1);
});
