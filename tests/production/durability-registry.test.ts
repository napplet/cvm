import { expect, test } from "bun:test";
import { createProductionDurabilitySubjectRegistry } from "../../src/production/durability-registry";
import { DURABILITY_SUBJECT_KINDS } from "../../src/resilience/fault-harness";

import { scriptedSqlPool } from "../fixtures/scripted-sql-pool";

const digest = "a".repeat(64);

test("durability inventory is keyed by its original checkpoint, not a latest action", async () => {
  const subjects: Record<string, unknown>[] = [];
  const pool = scriptedSqlPool(async (text, values = []) => {
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
  for (const [index, kind] of DURABILITY_SUBJECT_KINDS.entries()) await registry.register({ checkpointId: "checkpoint-original", sessionId: "session-original", actionId: "action-original", kind, sourceIdentity: `source:${kind}`, object: { key: `objects/${kind}`, generation: index + 1, checksum: digest }, payloadSha256: digest, ownerId: "owner-original", retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained" });
  expect(await registry.inventory({ checkpointId: "checkpoint-original", sessionId: "session-original", ownerId: "owner-original" })).toHaveLength(7);
  await expect(registry.inventory({ checkpointId: "checkpoint-later", sessionId: "session-original", ownerId: "owner-original" })).rejects.toThrow();
  await registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 1, objectChecksum: digest, state: "tombstoned" });
  await expect(registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 2, objectChecksum: digest, state: "deleted" })).rejects.toThrow("PRODUCTION_DURABILITY_DELETE_BINDING_REQUIRED");
  await registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 1, objectChecksum: digest, state: "deleted" });
  await registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 1, objectChecksum: digest, state: "deleted" });
  await expect(registry.markDeletion({ checkpointId: "checkpoint-original", kind: "checkpoint", objectGeneration: 1, objectChecksum: digest, state: "tombstoned" })).rejects.toThrow("PRODUCTION_DURABILITY_DELETE_BINDING_REQUIRED");
});
