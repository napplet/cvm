import { z } from "zod";
import { DURABILITY_SUBJECT_KINDS, DurabilitySubjectSchema, validateDurabilityInventory } from "../resilience/fault-harness";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.string().min(1).max(256);
const Kind = z.enum(DURABILITY_SUBJECT_KINDS);
const State = z.enum(["tombstoned", "deleted"]);

export type ProductionDurabilitySubject = z.infer<typeof DurabilitySubjectSchema> & Readonly<{ checkpointId: string; sessionId: string; actionId: string }>;
export type DurabilitySubjectRegistry = Readonly<{
  register(subject: ProductionDurabilitySubject): Promise<void>;
  inventory(input: Readonly<{ checkpointId: string; sessionId: string; ownerId: string }>): Promise<readonly z.infer<typeof DurabilitySubjectSchema>[]>;
  markDeletion(input: Readonly<{ checkpointId: string; kind: z.infer<typeof Kind>; objectGeneration: number; objectChecksum: string; state: z.infer<typeof State> }>): Promise<void>;
}>;

/** SQL authority for the seven D-125 retained subjects.  Checkpoint ID is
 * always supplied by the original checkpoint binding, never inferred from a
 * latest/completed action, so a later action cannot rewrite restore facts. */
export function createProductionDurabilitySubjectRegistry(pool: PostgresSqlPool): DurabilitySubjectRegistry {
  const query = async <T extends Record<string, unknown>>(text: string, values: readonly unknown[]) => {
    const client = await pool.connect();
    try { return await client.query<T>(text, values); }
    finally { client.release(); }
  };
  return Object.freeze({
    async register(raw) {
      const subject = DurabilitySubjectSchema.parse({ kind: raw.kind, sourceIdentity: raw.sourceIdentity, object: raw.object, payloadSha256: raw.payloadSha256, ownerId: raw.ownerId, retentionUntil: raw.retentionUntil, deletionState: raw.deletionState });
      subject.retentionUntil = new Date(subject.retentionUntil).toISOString();
      const checkpointId = Identity.parse(raw.checkpointId); const sessionId = Identity.parse(raw.sessionId); const actionId = Identity.parse(raw.actionId);
      const inserted = await query("INSERT INTO production_real.durability_subjects(checkpoint_id,kind,source_identity,object_key,object_generation,object_checksum,payload_sha256,owner_id,session_id,action_id,retention_until,deletion_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(checkpoint_id,kind) DO NOTHING RETURNING checkpoint_id", [checkpointId, subject.kind, subject.sourceIdentity, subject.object.key, subject.object.generation, subject.object.checksum, subject.payloadSha256, subject.ownerId, sessionId, actionId, subject.retentionUntil, subject.deletionState]);
      if (inserted.rows.length) return;
      const existing = (await query<Record<string, unknown>>("SELECT checkpoint_id,kind,source_identity,object_key,object_generation,object_checksum,payload_sha256,owner_id,session_id,action_id,retention_until::text AS retention_until,deletion_state FROM production_real.durability_subjects WHERE checkpoint_id=$1 AND kind=$2", [checkpointId, subject.kind])).rows[0];
      const actual = existing && DurabilitySubjectSchema.safeParse({ kind: existing.kind, sourceIdentity: existing.source_identity, object: { key: existing.object_key, generation: Number(existing.object_generation), checksum: existing.object_checksum }, payloadSha256: existing.payload_sha256, ownerId: existing.owner_id, retentionUntil: new Date(String(existing.retention_until)).toISOString(), deletionState: existing.deletion_state });
      if (!actual?.success || existing?.checkpoint_id !== checkpointId || existing?.session_id !== sessionId || existing?.action_id !== actionId || JSON.stringify(actual.data) !== JSON.stringify(subject)) throw new Error("PRODUCTION_DURABILITY_SUBJECT_CONFLICT");
    },
    async inventory(input) {
      const checkpointId = Identity.parse(input.checkpointId); const sessionId = Identity.parse(input.sessionId); const ownerId = Identity.parse(input.ownerId);
      const rows = (await query<Record<string, unknown>>("SELECT kind,source_identity,object_key,object_generation,object_checksum,payload_sha256,owner_id,retention_until::text AS retention_until,deletion_state FROM production_real.durability_subjects WHERE checkpoint_id=$1 AND session_id=$2 AND owner_id=$3 ORDER BY kind", [checkpointId, sessionId, ownerId])).rows;
      return validateDurabilityInventory(rows.map(row => ({ kind: row.kind, sourceIdentity: row.source_identity, object: { key: row.object_key, generation: Number(row.object_generation), checksum: row.object_checksum }, payloadSha256: row.payload_sha256, ownerId: row.owner_id, retentionUntil: new Date(String(row.retention_until)).toISOString(), deletionState: row.deletion_state })));
    },
    async markDeletion(input) {
      const checkpointId = Identity.parse(input.checkpointId); const kind = Kind.parse(input.kind); const generation = z.number().int().positive().parse(input.objectGeneration); const checksum = Digest.parse(input.objectChecksum); const state = State.parse(input.state);
      const values = [checkpointId, kind, generation, checksum, state];
      const result = await query("UPDATE production_real.durability_subjects SET deletion_state=$5,updated_at=clock_timestamp() WHERE checkpoint_id=$1 AND kind=$2 AND object_generation=$3 AND object_checksum=$4 AND (deletion_state='retained' OR (deletion_state='tombstoned' AND $5='deleted')) RETURNING checkpoint_id", values);
      if (result.rows.length === 1) return;
      const original = await query("SELECT deletion_state FROM production_real.durability_subjects WHERE checkpoint_id=$1 AND kind=$2 AND object_generation=$3 AND object_checksum=$4", values.slice(0, 4));
      if (original.rows[0]?.deletion_state !== state) throw new Error("PRODUCTION_DURABILITY_DELETE_BINDING_REQUIRED");
    },
  });
}
