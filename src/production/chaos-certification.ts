import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { D122_FAULT_MATRIX, FaultExecutionSchema, NO_EFFECTS_ORACLE } from "../resilience/fault-harness";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationReceipt, validateAuthorizationRequest } from "../release/authorization";
import { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { CoreControlPayloadSchemas, type ProductionCertificationServices } from "../release/deployment/production-core-suite-protocol";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { ProductionConfig } from "./config";
import type { ProductionGenerationRuntime } from "./generation-runtime";
import type { ContextVmCertificationClient } from "../release/deployment/contextvm-client";
import { ProductionRelayChaosCertification } from "./chaos-relay";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const Namespace = "production-chaos-sql";
const SqlState = z.object({ version: z.literal(1), writers: z.number().int().min(0).max(1) }).strict();
const Recorded = z.object({
  operationId: z.string(), sessionId: z.string(), controlOperationId: z.string(),
  state: z.enum(["prepared", "observed"]),
  oracle: z.object({ activeWriters: z.literal(1), effects: z.object({ credit: z.literal(0), debit: z.literal(0), worker: z.literal(0), session: z.literal(0), artifact: z.literal(0), checkpoint: z.literal(0), deploy: z.literal(0), ownerEvent: z.literal(0), attestation: z.literal(0) }).strict() }).strict(),
  sqlState: z.literal("40001").optional(),
}).strict();

/** A real serialization conflict on one run-owned operation-journal row.
 * Both transactions take their snapshot before either writes. PostgreSQL,
 * not a thrown fixture error, must reject the stale writer with SQLSTATE
 * 40001. No money, session, worker, or artifact table is mutated here. */
export async function executeSqlSerializationFault(input: Readonly<{ pool: PostgresSqlPool; scopeSha256: string; operationId: string }>): Promise<"40001"> {
  const pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
  const target = new PostgresOperationJournal(pool, { namespace: Namespace, scopeSha256: input.scopeSha256 });
  const identity = hash({ scope: input.scopeSha256, operationId: input.operationId });
  const created = await target.claim(input.operationId, identity, { version: 1, writers: 0 });
  // A lost dispatch response cannot license another conflict attempt.
  if (!created.claimed) throw new Error("PRODUCTION_CHAOS_SQL_ORIGINAL_ALREADY_DISPATCHED");
  const first = await pool.connect();
  let second: Awaited<ReturnType<PostgresSqlPool["connect"]>> | undefined;
  try {
    second = await pool.connect();
    for (const client of [first, second]) {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      const row = (await client.query("SELECT revision,value_json FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2 AND operation_id=$3 AND identity_sha256=$4", [Namespace, input.scopeSha256, input.operationId, identity])).rows[0];
      if (!row || Number(row.revision) !== 1 || SqlState.parse(row.value_json).writers !== 0) throw new Error("PRODUCTION_CHAOS_SQL_ORIGINAL_CHANGED");
    }
    const update = "UPDATE production_real.release_operation_journal SET value_json=$5::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE namespace=$1 AND scope_sha256=$2 AND operation_id=$3 AND identity_sha256=$4 AND revision=1 RETURNING revision";
    const values = [Namespace, input.scopeSha256, input.operationId, identity, JSON.stringify({ version: 1, writers: 1 })];
    const committed = await first.query(update, values);
    if (committed.rows.length !== 1) throw new Error("PRODUCTION_CHAOS_SQL_WRITER_NOT_COMMITTED");
    await first.query("COMMIT");
    try { await second.query(update, values); }
    catch (error) {
      if (String((error as { code?: string }).code) === "40001") return "40001";
      throw error;
    }
    throw new Error("PRODUCTION_CHAOS_SQL_SERIALIZATION_NOT_OBSERVED");
  } finally {
    await first.query("ROLLBACK").catch(() => undefined); first.release();
    if (second) { await second.query("ROLLBACK").catch(() => undefined); second.release(); }
  }
}

/** Fixed server control. Each implemented seam uses the mounted authority;
 * unsupported families remain non-pass and cannot return invented evidence.
 * Construction opens no resources and injects no faults. */
export class ProductionChaosCertificationService implements Pick<ProductionCertificationServices, "injectFault" | "observeFault" | "reconcile"> {
  readonly #scope: string;
  readonly #journal: PostgresOperationJournal;
  readonly #pool: PostgresSqlPool;
  readonly #relay?: ProductionRelayChaosCertification;
  constructor(private readonly input: Readonly<{ config: ProductionConfig; generation: ProductionGenerationRuntime; contextvm?: ContextVmCertificationClient }>) {
    if (input.config.candidateSha256 !== input.generation.config.candidateSha256 || input.config.topologySha256 !== input.generation.config.topologySha256 || input.config.realm !== "production-real") throw new Error("PRODUCTION_CHAOS_BINDING_REQUIRED");
    this.#scope = hash({ candidateSha256: input.config.candidateSha256, topologySha256: input.config.topologySha256, authorizationRequestSha256: input.generation.authorization.authorizationRequestSha256 });
    this.#pool = bindAccountingRealmPool(input.generation.dependencies.pool, createAccountingRealm("production-real"));
    this.#journal = new PostgresOperationJournal(this.#pool, { namespace: "production-chaos", scopeSha256: this.#scope });
    if (input.contextvm) this.#relay = new ProductionRelayChaosCertification({ config: input.config, generation: input.generation, contextvm: input.contextvm, core: input.generation.admissionObserver });
  }
  async #authorize(readOnly: boolean) {
    const request = await validateAuthorizationRequest(this.input.generation.authorization.request);
    const receipt = ReleaseAuthorizationReceiptSchema.parse(this.input.generation.authorization.receipt);
    await validateAuthorizationReceipt({ request, receipt, nowMs: readOnly ? Math.min(Date.now(), receipt.expiresAtMs - 1) : Date.now() });
    if (request.candidateSha256 !== this.input.config.candidateSha256 || request.topologySha256 !== this.input.config.topologySha256 || request.authorizationRequestSha256 !== this.input.generation.authorization.authorizationRequestSha256 || !request.providerScopes.some(value => value.provider === "cloud_sql_postgres") || !request.orderedEffects.some(value => value.provider === "cloud_sql_postgres")) throw new Error("PRODUCTION_CHAOS_SCOPE_INVALID");
  }
  async injectFault(input: Parameters<ProductionCertificationServices["injectFault"]>[0]) {
    const parsed = CoreControlPayloadSchemas["fault.inject"].parse({ schedule: input.schedule });
    const schedule = D122_FAULT_MATRIX.find(value => canonicalJson(value) === canonicalJson(parsed.schedule))!;
    if (schedule.faultClass === "duplicate_relay" || schedule.faultClass === "out_of_order_relay") {
      if (!this.#relay) throw new Error("PRODUCTION_CHAOS_RELAY_REQUIRED");
      return this.#relay.inject({ controlOperationId: input.operationId, schedule });
    }
    await this.#authorize(false);
    if (schedule.faultClass !== "sql_serialization") throw new Error(`PRODUCTION_CHAOS_BOUNDARY_REQUIRED:${schedule.faultClass}`);
    const operationId = schedule.input.operationId!; const sessionId = schedule.initialState.sessionId!;
    const prepared = Recorded.parse({ operationId, sessionId, controlOperationId: input.operationId, state: "prepared", oracle: { activeWriters: 1, effects: NO_EFFECTS_ORACLE } });
    const identity = hash({ schedule, controlOperationId: input.operationId });
    const claim = await this.#journal.claimBounded(operationId, identity, prepared, D122_FAULT_MATRIX.length);
    if (!claim.claimed) {
      await this.observeFault({ operationId, sessionId });
      return Object.freeze({ operationId, sessionId, oracle: prepared.oracle });
    }
    await this.#authorize(false);
    const sqlState = await executeSqlSerializationFault({ pool: this.#pool, scopeSha256: this.#scope, operationId });
    if (!await this.#journal.compareAndSet(operationId, identity, claim.record.revision, { ...prepared, state: "observed", sqlState })) throw new Error("PRODUCTION_CHAOS_OBSERVATION_COMMIT_UNCERTAIN");
    return Object.freeze({ operationId, sessionId, oracle: prepared.oracle });
  }
  async observeFault(input: Parameters<ProductionCertificationServices["observeFault"]>[0]) {
    const schedule = D122_FAULT_MATRIX.find(value => value.input.operationId === input.operationId && value.initialState.sessionId === input.sessionId);
    if (schedule?.faultClass === "duplicate_relay" || schedule?.faultClass === "out_of_order_relay") {
      if (!this.#relay) throw new Error("PRODUCTION_CHAOS_RELAY_REQUIRED");
      return this.#relay.observe(input);
    }
    await this.#authorize(true);
    if (!schedule || schedule.faultClass !== "sql_serialization") throw new Error("PRODUCTION_CHAOS_ORIGINAL_REQUIRED");
    const record = await this.#journal.read(input.operationId);
    const state = Recorded.parse(record?.value);
    if (state.state !== "observed" || state.sqlState !== "40001" || state.sessionId !== input.sessionId) throw new Error("PRODUCTION_CHAOS_ORIGINAL_UNRESOLVED");
    const original = await new PostgresOperationJournal(this.#pool, { namespace: Namespace, scopeSha256: this.#scope }).read(input.operationId);
    if (!original || original.identitySha256 !== hash({ scope: this.#scope, operationId: input.operationId }) || original.revision !== 2) throw new Error("PRODUCTION_CHAOS_SQL_ORIGINAL_CHANGED");
    const sql = SqlState.parse(original.value);
    // This seam writes only its journal row. Domain effect counts are zero by
    // its fixed SQL inventory; writer count is read from the committed row.
    return FaultExecutionSchema.parse({ operationId: input.operationId, sessionId: input.sessionId, observed: "serialization_failure", activeWriters: sql.writers, effects: NO_EFFECTS_ORACLE });
  }
  async reconcile(input: Parameters<ProductionCertificationServices["reconcile"]>[0]) {
    if (input.kind === "fault.observe") return this.observeFault(CoreControlPayloadSchemas["fault.observe"].parse(input.payload));
    if (input.kind !== "fault.inject") throw new Error("PRODUCTION_CHAOS_KIND_INVALID");
    const payload = CoreControlPayloadSchemas["fault.inject"].parse(input.payload);
    const schedule = D122_FAULT_MATRIX.find(value => canonicalJson(value) === canonicalJson(payload.schedule))!;
    if (schedule.faultClass === "duplicate_relay" || schedule.faultClass === "out_of_order_relay") {
      if (!this.#relay) throw new Error("PRODUCTION_CHAOS_RELAY_REQUIRED");
      return this.#relay.reconcile({ controlOperationId: input.operationId, schedule });
    }
    const operationId = schedule.input.operationId!; const sessionId = schedule.initialState.sessionId!;
    await this.observeFault({ operationId, sessionId });
    const state = Recorded.parse((await this.#journal.read(operationId))?.value);
    if (state.controlOperationId !== input.operationId) throw new Error("PRODUCTION_CHAOS_CONTROL_ORIGINAL_MISMATCH");
    return Object.freeze({ operationId, sessionId, oracle: state.oracle });
  }
}
