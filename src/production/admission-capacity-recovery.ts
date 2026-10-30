import { createHash } from "node:crypto";
import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { PostgresSqlFundingStore, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { PRODUCTION_WORKER_POLICY } from "../worker-adapters/production-worker-policy";
import { assertProductionReadyCapacity, type ProductionReadyCapacityPort } from "./worker-capacity";
import { assertProductionWorkerJobRouter, type ProductionWorkerJobRouter } from "./worker-job-router";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u), Intent = z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u);
const Reference = z.string().regex(/^capacity:[a-f0-9]{64}$/u), Image = z.string().regex(/^.+@sha256:[a-f0-9]{64}$/u);
const Row = z.object({ account_id: z.string().regex(/^account:[a-f0-9]{64}$/u), idempotency_key: z.string().min(1).max(256),
  fingerprint_sha256: Digest, intent_reference: Intent, capacity_reference: Reference.nullable(),
  state: z.enum(["created", "dispatching", "available", "refused", "reconciliation_pending", "released"]), nostr_pubkey: Digest }).strict();
const Capacity = z.object({ intentReference: Intent, reference: Reference, workerOperationId: z.string().regex(/^capacity-[a-f0-9]{40}$/u),
  provider: z.enum(["modal", "fly"]), expectedSessionBindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), deadlineEpochMs: z.number().int().positive(),
  execution: z.object({ image: Image, toolchainSha256: Digest, policyVersion: z.literal(PRODUCTION_WORKER_POLICY.version), flyRegion: z.string().optional() }).strict().optional() });
const Worker = z.object({ operationId: Capacity.shape.workerOperationId, provider: Capacity.shape.provider, appName: z.string().min(1).max(63),
  resourceName: z.string().min(1).max(128), requestSha256: Digest, image: Image, policyVersion: z.literal(PRODUCTION_WORKER_POLICY.version),
  sessionLeaseSha256: Digest, toolchainSha256: Digest, providerDeadlineEpochMs: z.number().int().positive(), region: z.string().optional(),
  resourceId: z.string().regex(/^[A-Za-z0-9_-]{3,128}$/u).optional(), providerCreatedAtMs: z.number().int().positive().optional() });
const Cursor = z.object({ version: z.literal(1), after: z.union([z.literal(""), Intent]) }).strict();
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const ordinaryIntent = (accountId: string, key: string) => `capacity-intent:${createHash("sha256").update(`${accountId}:${key}`).digest("hex")}`;
const cursorKey = "admission-capacity-recovery-cursor:v1", cursorIdentity = hash({ version: 1, purpose: "observe-original-admission-capacity" });
const columns = "c.account_id,c.idempotency_key,c.fingerprint_sha256,c.intent_reference,c.capacity_reference,c.state,trim(f.nostr_pubkey) AS nostr_pubkey";

/** Ordinary unaccepted admissions only. This service has no CREATE, terminate,
 * generation, signer or balance mutation capability. */
export class ProductionAdmissionCapacityRecovery {
  readonly #pool: PostgresSqlPool;
  readonly #funding: PostgresSqlFundingStore;
  #active: Promise<Readonly<{ examined: number; finalized: number; pending: number }>> | undefined;
  #stopped = false;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; capacity: ProductionReadyCapacityPort; router: ProductionWorkerJobRouter;
    workerJournal: PostgresOperationJournal; journal: PostgresOperationJournal; now?: () => number }>) {
    assertProductionReadyCapacity(input.capacity); assertProductionWorkerJobRouter(input.router);
    assertPostgresOperationJournal(input.workerJournal); assertPostgresOperationJournal(input.journal);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#funding = new PostgresSqlFundingStore(this.#pool, { deadlineMs: 5000, maxAttempts: 4 });
  }
  async assertReady(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query(`SELECT ${columns} FROM production_real.capacity_intents c JOIN production_real.funding_accounts f ON f.account_id=c.account_id LIMIT 0`);
      await client.query("SELECT account_id,reference FROM production_real.admissions LIMIT 0");
      await client.query("SELECT account_id,reference FROM production_real.session_cap_holds LIMIT 0");
      await client.query("SELECT account_id,admission_reference FROM production_real.action_budget_reservations LIMIT 0");
      await client.query("SELECT account_id,admission_reference FROM production_real.metered_actions LIMIT 0");
      await client.query("SELECT account_id,idempotency_key FROM production_real.funding_commands LIMIT 0");
      await client.query("SELECT outbox_id,payload_json FROM production_real.funding_outbox LIMIT 0");
      const permissions = (await client.query<{ usable: boolean }>(`SELECT
        has_table_privilege(current_user,'production_real.capacity_intents','SELECT')
        AND has_table_privilege(current_user,'production_real.capacity_intents','UPDATE')
        AND has_table_privilege(current_user,'production_real.funding_outbox','SELECT')
        AND has_table_privilege(current_user,'production_real.funding_outbox','INSERT')
        AND has_table_privilege(current_user,'production_real.release_operation_journal','SELECT')
        AND has_table_privilege(current_user,'production_real.release_operation_journal','INSERT')
        AND has_column_privilege(current_user,'production_real.release_operation_journal','value_json','UPDATE')
        AND has_column_privilege(current_user,'production_real.release_operation_journal','revision','UPDATE')
        AND has_column_privilege(current_user,'production_real.release_operation_journal','updated_at','UPDATE') AS usable`)).rows[0];
      if (permissions?.usable !== true) throw new Error("ADMISSION_CAPACITY_RECOVERY_SCHEMA_REQUIRED");
    } finally { client.release(); }
  }
  scan(): Promise<Readonly<{ examined: number; finalized: number; pending: number }>> {
    if (this.#stopped) return Promise.resolve({ examined: 0, finalized: 0, pending: 0 });
    if (this.#active) return this.#active;
    const run = this.#scan().finally(() => { this.#active = undefined; }); this.#active = run; return run;
  }
  async close(): Promise<void> { this.#stopped = true; await this.#active; }
  async #unused(sql: Awaited<ReturnType<PostgresSqlPool["connect"]>>, row: z.infer<typeof Row>, reference: string): Promise<boolean> {
    const used = await sql.query<{ used: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM production_real.funding_commands WHERE account_id=$1 AND idempotency_key=$2)
      OR EXISTS(SELECT 1 FROM production_real.admissions WHERE account_id=$1 AND (reference=$3 OR capacity_reference=$3))
      OR EXISTS(SELECT 1 FROM production_real.session_cap_holds WHERE account_id=$1 AND reference=$3)
      OR EXISTS(SELECT 1 FROM production_real.action_budget_reservations WHERE account_id=$1 AND admission_reference=$3)
      OR EXISTS(SELECT 1 FROM production_real.metered_actions WHERE account_id=$1 AND admission_reference=$3) AS used`, [row.account_id, row.idempotency_key, reference]);
    return used.rows[0]?.used === false;
  }
  async #finalize(row: z.infer<typeof Row>, capacity: z.infer<typeof Capacity>, worker: z.infer<typeof Worker> & { resourceId: string }) {
    const proof = { version: "admission-capacity-termination-v1", accountId: row.account_id, idempotencyKey: row.idempotency_key,
      intentFingerprint: row.fingerprint_sha256, intentReference: row.intent_reference, capacityReference: capacity.reference,
      sessionBindingDigest: capacity.expectedSessionBindingDigest, deadlineEpochMs: capacity.deadlineEpochMs, native: worker, status: "terminated" };
    const identity = hash(proof), key = `admission-capacity-termination:v1:${hash({ accountId: row.account_id, intentReference: row.intent_reference })}`;
    try { await this.input.journal.claim(key, identity, proof); }
    catch (error) {
      const prior = await this.input.journal.read(key);
      if (!prior || prior.identitySha256 !== identity || canonicalJson(prior.value) !== canonicalJson(proof)) throw error;
    }
    const prior = await this.input.journal.read(key);
    if (!prior || prior.revision !== 1 || prior.identitySha256 !== identity || canonicalJson(prior.value) !== canonicalJson(proof)) throw new Error("ADMISSION_CAPACITY_PROOF_REQUIRED");
    return this.#funding.transactWithSql(row.account_id, async (_tx, sql) => {
      const result = await sql.query(`SELECT ${columns} FROM production_real.capacity_intents c JOIN production_real.funding_accounts f ON f.account_id=c.account_id
        WHERE c.account_id=$1 AND c.idempotency_key=$2 FOR UPDATE OF c`, [row.account_id, row.idempotency_key]);
      const current = Row.safeParse(result.rows[0]);
      if (!current.success || current.data.state === "released" || current.data.intent_reference !== row.intent_reference || current.data.fingerprint_sha256 !== row.fingerprint_sha256
        || current.data.nostr_pubkey !== row.nostr_pubkey || (current.data.capacity_reference !== null && current.data.capacity_reference !== capacity.reference)
        || !await this.#unused(sql, current.data, capacity.reference)) return false;
      await sql.query("UPDATE production_real.capacity_intents SET state='released',capacity_reference=COALESCE(capacity_reference,$3) WHERE account_id=$1 AND intent_reference=$2", [row.account_id, row.intent_reference, capacity.reference]);
      const outboxId = `outbox:${key}`, payload = { proofReference: key, proofSha256: identity, ...proof };
      await sql.query("INSERT INTO production_real.funding_outbox(outbox_id,aggregate_reference,event_kind,payload_json) VALUES($1,$2,'admission_capacity_observed_terminated',$3::jsonb) ON CONFLICT(outbox_id) DO NOTHING", [outboxId, row.intent_reference, canonicalJson(payload)]);
      const outbox = (await sql.query("SELECT aggregate_reference,event_kind,payload_json FROM production_real.funding_outbox WHERE outbox_id=$1", [outboxId])).rows[0];
      if (!outbox || outbox.aggregate_reference !== row.intent_reference || outbox.event_kind !== "admission_capacity_observed_terminated" || canonicalJson(outbox.payload_json) !== canonicalJson(payload)) throw new Error("ADMISSION_CAPACITY_OUTBOX_REQUIRED");
      return true;
    });
  }
  async #observe(row: z.infer<typeof Row>): Promise<boolean> {
    if (ordinaryIntent(row.account_id, row.idempotency_key) !== row.intent_reference || await accountIdForPrincipal({ pubkey: row.nostr_pubkey }) !== row.account_id) return false;
    const capacity = Capacity.safeParse(await this.input.capacity.inspect({ intentReference: row.intent_reference }));
    if (!capacity.success || capacity.data.intentReference !== row.intent_reference || (row.capacity_reference !== null && row.capacity_reference !== capacity.data.reference)) return false;
    const value = capacity.data, original = Worker.parse((await this.input.workerJournal.read(value.workerOperationId))?.value);
    if (original.operationId !== value.workerOperationId || original.provider !== value.provider || original.sessionLeaseSha256 !== value.expectedSessionBindingDigest.slice(7)
      || original.providerDeadlineEpochMs !== value.deadlineEpochMs || (value.execution && (original.image !== value.execution.image || original.toolchainSha256 !== value.execution.toolchainSha256
        || original.policyVersion !== value.execution.policyVersion || (value.provider === "fly" && original.region !== value.execution.flyRegion)))) return false;
    const client = await this.#pool.connect();
    try { if (!await this.#unused(client, row, value.reference)) return false; } finally { client.release(); }
    const observed = await this.input.router.observeTermination({ provider: value.provider, workerOperationId: value.workerOperationId });
    if (observed.status !== "terminated") return false;
    const final = Worker.parse((await this.input.workerJournal.read(value.workerOperationId))?.value);
    const { resourceId: beforeId, providerCreatedAtMs: beforeCreated, ...before } = original;
    const { resourceId: afterId, providerCreatedAtMs: afterCreated, ...after } = final;
    if (!afterId || (beforeId !== undefined && beforeId !== afterId) || (beforeCreated !== undefined && beforeCreated !== afterCreated) || canonicalJson(before) !== canonicalJson(after)) return false;
    return this.#finalize(row, value, { ...final, resourceId: afterId });
  }
  async #scan() {
    const claimed = await this.input.journal.claim(cursorKey, cursorIdentity, Cursor.parse({ version: 1, after: "" }));
    const cursor = Cursor.parse(claimed.record.value);
    if (claimed.record.identitySha256 !== cursorIdentity) throw new Error("ADMISSION_CAPACITY_CURSOR_REQUIRED");
    const client = await this.#pool.connect(); let rows;
    try {
      rows = (await client.query(`SELECT ${columns} FROM production_real.capacity_intents c JOIN production_real.funding_accounts f ON f.account_id=c.account_id
        WHERE f.accounting_realm='production-real' AND f.nostr_pubkey IS NOT NULL AND c.state<>'released' AND c.intent_reference>$1
          AND c.intent_reference ~ '^capacity-intent:[a-f0-9]{64}$'
          AND NOT EXISTS(SELECT 1 FROM production_real.funding_commands x WHERE x.account_id=c.account_id AND x.idempotency_key=c.idempotency_key)
          AND NOT EXISTS(SELECT 1 FROM production_real.admissions a WHERE a.account_id=c.account_id AND (a.reference=c.capacity_reference OR a.capacity_reference=c.capacity_reference))
          AND NOT EXISTS(SELECT 1 FROM production_real.session_cap_holds h WHERE h.account_id=c.account_id AND h.reference=c.capacity_reference)
          AND NOT EXISTS(SELECT 1 FROM production_real.action_budget_reservations b WHERE b.account_id=c.account_id AND b.admission_reference=c.capacity_reference)
          AND NOT EXISTS(SELECT 1 FROM production_real.metered_actions m WHERE m.account_id=c.account_id AND m.admission_reference=c.capacity_reference)
        ORDER BY c.intent_reference LIMIT 32`, [cursor.after])).rows;
    } finally { client.release(); }
    let examined = 0, finalized = 0, pending = 0, after = cursor.after;
    const now = this.input.now ?? Date.now, deadline = now() + 30_000;
    for (const raw of rows) {
      if (this.#stopped || now() >= deadline) break;
      const row = Row.safeParse(raw);
      // SQL owns the keyset order; malformed content is skipped without effects.
      const key = Intent.safeParse(raw.intent_reference);
      if (!key.success) continue;
      after = key.data; examined++;
      try { if (row.success && await this.#observe(row.data)) finalized++; else pending++; } catch { pending++; }
    }
    if (examined === rows.length && rows.length < 32) after = "";
    if (after !== cursor.after) await this.input.journal.compareAndSet(cursorKey, cursorIdentity, claimed.record.revision, Cursor.parse({ version: 1, after }));
    return Object.freeze({ examined, finalized, pending });
  }
}
