import { createHash } from "node:crypto";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { ReadyCapacityPort } from "../funding/funded-admission";
import type { ContinuationPause } from "../persistence/funding-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { PendingActionIntentSchema } from "../continuity/contracts";
import type { PendingCommandPort } from "../continuity/protected-command";
import { PendingCommandCheckpointArchiveSchema, validatePendingCommandCheckpointArchive } from "../continuity/checkpoint-envelope";
import { canonicalJson } from "../promotion/schema";
import { assertProductionCheckpointCoordinator, ProductionCheckpointCoordinator } from "./checkpoint-coordinator";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const checkpointIdFor = (value: Readonly<{ accountId: string; sessionId: string; pauseGeneration: number }>) => `pending-checkpoint:${sha({ accountId: value.accountId, sessionId: value.sessionId, pauseGeneration: value.pauseGeneration })}`;

export async function assertProductionPendingCheckpointSchema(pool: PostgresSqlPool): Promise<void> {
  const client = await bindAccountingRealmPool(pool, createAccountingRealm("production-real")).connect();
  try {
    const format = (await client.query<{ ready: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='production_real.checkpoint_envelopes'::regclass AND conname='checkpoint_manifest_format_binding' AND convalidated AND pg_catalog.pg_get_constraintdef(oid) LIKE '%checkpoint-manifest-v2%') AS ready")).rows[0];
    if (!format?.ready) throw new Error("CHECKPOINT_FORMAT_EXPANSION_REQUIRED");
  } catch (cause) { throw new Error("PRODUCTION_PENDING_CHECKPOINT_SCHEMA_REQUIRED", { cause }); }
  finally { client.release(); }
}

/** Saves an admitted initial command with no paid action or built workspace.
 * The existing checkpoint coordinator owns encryption, original-object CAS,
 * immutable SQL evidence and exact-generation recovery. */
export class ProductionInitialPendingCheckpoint {
  readonly #pool: PostgresSqlPool;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; checkpoint: ProductionCheckpointCoordinator; capacity: ReadyCapacityPort; commands: PendingCommandPort; now?: () => number }>) {
    assertProductionCheckpointCoordinator(input.checkpoint);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
  }

  async seal(pause: ContinuationPause) {
    const intent = PendingActionIntentSchema.parse(pause.intent);
    if (intent.actionKind !== "start_session" || intent.expectedSessionVersion !== 0 || intent.expectedArtifactVersion !== 0 || !intent.commandSha256 || pause.accountId !== intent.accountId || pause.sessionId !== intent.sessionId || pause.pendingFingerprint !== intent.fingerprint || !pause.liveLeaseToken) throw new Error("INITIAL_PENDING_CHECKPOINT_BINDING_REQUIRED");
    await assertProductionPendingCheckpointSchema(this.#pool);
    const client = await this.#pool.connect();
    try {
      const original = (await client.query("SELECT p.intent_json FROM continuation_pauses p JOIN metered_sessions s ON s.account_id=p.account_id AND s.id=p.session_id JOIN admissions a ON a.account_id=p.account_id AND a.reference=p.admission_reference WHERE p.account_id=$1 AND p.session_id=$2 AND p.pause_generation=$3 AND p.live_lease_token=$4 AND p.state='checkpointing' AND p.expected_session_version=0 AND p.grace_deadline_ms <= $5 AND s.version=0 AND s.current_verified_artifact_version=0 AND s.confirmed_spend_sat=0 AND s.state='needs_top_up' AND a.state='accepted' AND NOT EXISTS(SELECT 1 FROM metered_actions m WHERE m.account_id=p.account_id AND m.session_id=p.session_id)", [intent.accountId, intent.sessionId, pause.pauseGeneration, pause.liveLeaseToken, (this.input.now ?? Date.now)()])).rows[0];
      if (!original || canonicalJson(PendingActionIntentSchema.parse(original.intent_json)) !== canonicalJson(intent)) throw new Error("INITIAL_PENDING_CHECKPOINT_SQL_AUTHORITY_REQUIRED");
    } finally { client.release(); }
    let existing;
    try { existing = await this.input.checkpoint.loadExact({ checkpointId: checkpointIdFor(pause), accountId: intent.accountId, sessionId: intent.sessionId }); }
    catch (error) { if (!(error instanceof Error) || error.message !== "CHECKPOINT_RESTORE_DENIED") throw error; }
    if (existing) {
      if (existing.manifest.payloadKind !== "pending_command") throw new Error("INITIAL_PENDING_CHECKPOINT_FORMAT_CONFLICT");
      validatePendingCommandCheckpointArchive(await this.input.checkpoint.restore({ checkpointId: checkpointIdFor(pause), accountId: intent.accountId, sessionId: intent.sessionId }), intent);
      return existing;
    }
    const command = await this.input.commands.open(intent);
    const { protectedCommand: _liveEnvelope, ...retainedIntent } = intent;
    const archive = new TextEncoder().encode(canonicalJson(PendingCommandCheckpointArchiveSchema.parse({ schemaVersion: "pending-command-checkpoint-v1", intent: retainedIntent, command })));
    const identity = sha({ pendingReference: intent.reference, fingerprint: intent.fingerprint });
    try { return await this.input.checkpoint.sealPending({ payloadKind: "pending_command", checkpointId: checkpointIdFor(pause), accountId: intent.accountId, sessionId: intent.sessionId, pauseGeneration: pause.pauseGeneration, sessionVersion: 0, actionVersion: 0, artifactVersion: 0, workspaceVersion: 0, workspaceLineage: `workspace:${intent.sessionId}`, action: { actionId: `pending-action:${identity}`, operationId: `pending-operation:${identity}`, ledgerReference: intent.admissionReference, pendingActionReference: intent.reference, idempotencyKey: intent.idempotencyKey }, archive, inventory: ["pending_action", "admission_state", "compatibility_metadata"], evidenceSha256: sha({ accountId: intent.accountId, sessionId: intent.sessionId, pendingFingerprint: intent.fingerprint, authority: "initial-sql-pause-without-action-v1" }), compatibility: { policyVersion: intent.policyVersion, modelIdentity: intent.profileId, nappletSdkIdentity: intent.priceCardId, toolchainIdentity: intent.toolchainId } }); } finally { archive.fill(0); }
  }

  async release(pause: ContinuationPause): Promise<void> { await this.#release(checkpointIdFor(pause), pause.accountId, pause.sessionId); }

  /** Bounded cleanup of committed work. A lost commit/termination ACK cannot
   * strand the original idle worker; original provider clients own fencing. */
  async reconcileReleases(): Promise<readonly Readonly<{ checkpointId: string; status: "released" | "pending" }>[]> {
    const client = await this.#pool.connect();
    let rows;
    try { rows = (await client.query<{ checkpoint_id: string; account_id: string; session_id: string }>("SELECT e.checkpoint_id,e.account_id,e.session_id FROM checkpoint_envelopes e JOIN continuation_checkpoints c ON c.checkpoint_id=e.checkpoint_id AND c.account_id=e.account_id AND c.session_id=e.session_id WHERE e.manifest_json->>'schemaVersion'='checkpoint-manifest-v2' AND e.manifest_json->>'payloadKind'='pending_command' AND NOT EXISTS(SELECT 1 FROM funding_outbox o WHERE o.aggregate_reference=e.checkpoint_id AND o.event_kind='pending_checkpoint_capacity_released') ORDER BY e.created_at,e.checkpoint_id LIMIT 100")).rows; }
    finally { client.release(); }
    const results = [];
    for (const row of rows) {
      try { await this.#release(row.checkpoint_id, row.account_id, row.session_id); results.push(Object.freeze({ checkpointId: row.checkpoint_id, status: "released" as const })); }
      catch { results.push(Object.freeze({ checkpointId: row.checkpoint_id, status: "pending" as const })); }
    }
    return Object.freeze(results);
  }

  async #release(checkpointId: string, accountId: string, sessionId: string): Promise<void> {
    const client = await this.#pool.connect();
    let original;
    try {
      const matches = (await client.query<{ intent_reference: string; capacity_reference: string }>("SELECT i.intent_reference,i.capacity_reference FROM continuation_checkpoints c JOIN checkpoint_envelopes e ON e.checkpoint_id=c.checkpoint_id AND e.account_id=c.account_id AND e.session_id=c.session_id JOIN continuation_pauses p ON p.account_id=c.account_id AND p.session_id=c.session_id AND p.pause_generation=c.pause_generation JOIN admissions a ON a.account_id=p.account_id AND a.reference=p.admission_reference JOIN capacity_intents i ON i.account_id=a.account_id AND i.capacity_reference=a.reference WHERE c.checkpoint_id=$1 AND c.account_id=$2 AND c.session_id=$3 AND e.manifest_json->>'schemaVersion'='checkpoint-manifest-v2' AND e.manifest_json->>'payloadKind'='pending_command' AND i.state='available' AND p.grace_deadline_ms <= $4 AND c.object_key=e.object_key AND c.object_generation=e.object_generation::text AND c.object_checksum=e.object_checksum AND c.key_reference=e.key_reference LIMIT 2", [checkpointId, accountId, sessionId, (this.input.now ?? Date.now)()])).rows;
      if (matches.length !== 1) throw new Error("PENDING_CAPACITY_RELEASE_BINDING_REQUIRED");
      original = matches[0];
      if (!original) throw new Error("PENDING_CAPACITY_RELEASE_BINDING_REQUIRED");
    } finally { client.release(); }
    await this.input.capacity.release({ intentReference: original.intent_reference, reference: original.capacity_reference });
    const payload = { accountId, sessionId, checkpointId, intentReference: original.intent_reference, capacityReference: original.capacity_reference };
    const writer = await this.#pool.connect();
    try {
      const id = `pending-capacity-release:${sha(payload)}`;
      await writer.query("INSERT INTO funding_outbox(outbox_id,aggregate_reference,event_kind,payload_json) VALUES($1,$2,'pending_checkpoint_capacity_released',$3::jsonb) ON CONFLICT(outbox_id) DO NOTHING", [id, checkpointId, JSON.stringify(payload)]);
      const observed = (await writer.query("SELECT payload_json FROM funding_outbox WHERE outbox_id=$1 AND aggregate_reference=$2 AND event_kind='pending_checkpoint_capacity_released'", [id, checkpointId])).rows[0];
      if (!observed || canonicalJson(observed.payload_json) !== canonicalJson(payload)) throw new Error("PENDING_CAPACITY_RELEASE_EVIDENCE_CONFLICT");
    } finally { writer.release(); }
  }
}
