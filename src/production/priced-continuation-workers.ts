import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { ExactReadyProofSchema, type CapacityObservation, type ReadyCapacityPort } from "../funding/funded-admission";
import { PostgresSqlFundingStore, type PostgresSqlClient, type PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { ProductionResumeAcceptance, type PricedContinuationWorkerIntent } from "./resume-acceptance";

const Allocation = z.object({
  claimReference: z.string().min(1), accountId: z.string().min(1), capacityIntentReference: z.string().regex(/^capacity-intent:[a-f0-9]{64}$/u),
  capacityReference: z.string().regex(/^capacity:[a-f0-9]{64}$/u), ready: ExactReadyProofSchema,
  expiresAt: z.preprocess(value => value instanceof Date ? value.toISOString() : value, z.iso.datetime()),
}).strict();
export type PricedContinuationWorkerAllocation = z.infer<typeof Allocation>;
const Reservation = z.object({ status: z.literal("available"), reference: Allocation.shape.capacityReference, expiresAt: z.iso.datetime(),
  usable: z.literal(true).optional(), ready: ExactReadyProofSchema }).strict();
const instances = new WeakSet<object>();

/** Immediate explicit-resume capacity. One committed capacity dispatch claim
 * permits one reserve call. Every uncertain/replayed dispatch observes that
 * same original, never another reservation or an admission queue. */
export class ProductionPricedContinuationWorkers {
  readonly #pool: PostgresSqlPool;
  readonly #funding: PostgresSqlFundingStore;
  readonly #now: () => number;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; acceptance: ProductionResumeAcceptance; capacity: ReadyCapacityPort; now?: () => number; timeoutMs?: number }>) {
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#funding = new PostgresSqlFundingStore(this.#pool, { deadlineMs: 5000, maxAttempts: 4 });
    this.#now = input.now ?? Date.now;
    if (!Number.isSafeInteger(input.timeoutMs ?? 5000) || (input.timeoutMs ?? 5000) < 1 || (input.timeoutMs ?? 5000) > 5000) throw new Error("PRICED_WORKER_TIMEOUT_INVALID");
    instances.add(this);
  }

  async assertReady(): Promise<void> {
    await this.input.acceptance.assertReady();
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<{ permitted: boolean; guarded: number }>(`SELECT
        (has_table_privilege(current_user,'production_real.priced_continuation_worker_intents','SELECT')
          AND has_table_privilege(current_user,'production_real.priced_continuation_worker_intents','INSERT')
          AND has_table_privilege(current_user,'production_real.priced_continuation_worker_allocations','SELECT')
          AND has_table_privilege(current_user,'production_real.priced_continuation_worker_allocations','INSERT')
          AND NOT has_table_privilege(current_user,'production_real.priced_continuation_worker_intents','UPDATE,DELETE,TRUNCATE')
          AND NOT has_table_privilege(current_user,'production_real.priced_continuation_worker_allocations','UPDATE,DELETE,TRUNCATE')) AS permitted,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
          JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='production_real' AND pn.nspname=n.nspname
            AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND
            ((c.relname='priced_continuation_worker_intents' AND t.tgname='priced_worker_intent_guard' AND p.proname='guard_priced_worker_record') OR
             (c.relname='priced_continuation_worker_allocations' AND t.tgname='priced_worker_allocation_guard' AND p.proname='guard_priced_worker_record') OR
             (c.relname='capacity_intents' AND t.tgname='priced_capacity_dispatch_fence' AND p.proname='fence_priced_capacity_dispatch'))) AS guarded`)).rows[0];
      if (!row?.permitted || row.guarded !== 3) throw new Error("PRODUCTION_PRICED_WORKER_SCHEMA_REQUIRED");
    } finally { client.release(); }
  }

  async read(accountId: string, claimReference: string): Promise<PricedContinuationWorkerAllocation | undefined> {
    const client = await this.#pool.connect();
    try { return await this.#read(client, accountId, claimReference); }
    finally { client.release(); }
  }

  async allocate(accountId: string, idempotencyKey: string): Promise<Readonly<{ status: "available"; allocation: PricedContinuationWorkerAllocation }> | Readonly<{ status: "refused" | "reconciliation_pending" }>> {
    const { workerIntent } = await this.input.acceptance.claimWorker(accountId, idempotencyKey);
    const dispatch = await this.#funding.transactWithSql(accountId, async (tx) => {
      const original = await tx.findCapacityIntent(workerIntent.allocationIntentReference);
      if (!original || original.intentReference !== workerIntent.capacityIntentReference || original.fingerprint !== workerIntent.fingerprint) throw new Error("PRICED_WORKER_INTENT_BINDING_DENIED");
      if (original.state === "created") return tx.claimCapacityDispatch(original.intentReference);
      return { intent: original, claimed: false };
    });
    if (dispatch.intent.state === "refused" || dispatch.intent.state === "released") return { status: "refused" };
    const observe = async (): Promise<CapacityObservation> => {
      try { return await this.#bounded(this.input.capacity.observe({ intentReference: workerIntent.capacityIntentReference,
        expectedSessionBindingDigest: workerIntent.sessionBindingDigest, ...(dispatch.intent.capacityReference ? { reference: dispatch.intent.capacityReference } : {}) })); }
      catch { return { status: "unknown" }; }
    };
    let observation: CapacityObservation;
    if (dispatch.claimed) {
      try { observation = await this.#bounded(this.input.capacity.reserveNow({ intentReference: workerIntent.capacityIntentReference, expectedSessionBindingDigest: workerIntent.sessionBindingDigest })); }
      catch { observation = await observe(); }
    } else observation = await observe();
    const parsed = Reservation.safeParse(observation);
    if (!parsed.success || parsed.data.ready.intentReference !== workerIntent.capacityIntentReference
      || parsed.data.ready.leaseReference !== parsed.data.reference || parsed.data.ready.sessionBindingDigest !== workerIntent.sessionBindingDigest
      || Date.parse(parsed.data.expiresAt) - this.#now() < 5000
      || (dispatch.intent.capacityReference !== undefined && dispatch.intent.capacityReference !== parsed.data.reference)) {
      await this.#funding.transactWithSql(accountId, tx => tx.recordCapacityObservation({ intentReference: workerIntent.capacityIntentReference,
        state: observation.status === "refused" ? "refused" : "reconciliation_pending" }));
      return { status: observation.status === "refused" ? "refused" : "reconciliation_pending" };
    }
    const ready = parsed.data;
    const allocation = await this.#funding.transactWithSql(accountId, async (tx, client) => {
      const prior = await this.#read(client, accountId, workerIntent.claimReference);
      if (prior) this.#matches(prior, workerIntent, ready);
      await tx.recordCapacityObservation({ intentReference: workerIntent.capacityIntentReference, state: "available", capacityReference: ready.reference, expiresAt: ready.expiresAt });
      if (prior) return prior;
      await client.query(`INSERT INTO production_real.priced_continuation_worker_allocations
        (claim_reference,account_id,capacity_intent_reference,capacity_reference,ready_proof_json,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [workerIntent.claimReference, accountId, workerIntent.capacityIntentReference, ready.reference, canonicalJson(ready.ready), ready.expiresAt]);
      const saved = await this.#read(client, accountId, workerIntent.claimReference);
      if (!saved) throw new Error("PRICED_WORKER_READBACK_REQUIRED");
      this.#matches(saved, workerIntent, ready);
      return saved;
    });
    return { status: "available", allocation };
  }

  async #read(client: PostgresSqlClient, accountId: string, claimReference: string): Promise<PricedContinuationWorkerAllocation | undefined> {
    const row = (await client.query(`SELECT a.claim_reference AS "claimReference",a.account_id AS "accountId",a.capacity_intent_reference AS "capacityIntentReference",
      a.capacity_reference AS "capacityReference",a.ready_proof_json AS ready,a.expires_at AS "expiresAt",w.session_binding_digest AS "expectedBinding"
      FROM production_real.priced_continuation_worker_allocations a JOIN production_real.priced_continuation_worker_intents w ON w.claim_reference=a.claim_reference
      WHERE a.account_id=$1 AND a.claim_reference=$2`, [accountId, claimReference])).rows[0];
    if (!row) return undefined;
    const { expectedBinding, ...value } = row, allocation = Allocation.parse(value);
    if (allocation.accountId !== accountId || allocation.claimReference !== claimReference || allocation.ready.sessionBindingDigest !== expectedBinding
      || allocation.ready.intentReference !== allocation.capacityIntentReference || allocation.ready.leaseReference !== allocation.capacityReference) throw new Error("PRICED_WORKER_ALLOCATION_BINDING_DENIED");
    return allocation;
  }
  #matches(allocation: PricedContinuationWorkerAllocation, intent: PricedContinuationWorkerIntent, ready: z.infer<typeof Reservation>): void {
    if (allocation.capacityIntentReference !== intent.capacityIntentReference || allocation.capacityReference !== ready.reference
      || allocation.expiresAt !== ready.expiresAt || canonicalJson(allocation.ready) !== canonicalJson(ready.ready)) throw new Error("PRICED_WORKER_ALLOCATION_BINDING_DENIED");
  }
  async #bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("PRICED_WORKER_DEADLINE_EXCEEDED")), this.input.timeoutMs ?? 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}

export function assertProductionPricedContinuationWorkers(value: unknown): asserts value is ProductionPricedContinuationWorkers {
  if (!value || typeof value !== "object" || !instances.has(value)) throw new Error("PRODUCTION_PRICED_CONTINUATION_WORKERS_REQUIRED");
}
