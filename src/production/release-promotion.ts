import { createHash } from "node:crypto";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { validateAuthorizationReceipt } from "../release/authorization";
import { FinalVerificationAuthoritySchema, type FinalVerificationAuthority } from "./release-verification-authority";
import type { ReleaseFinalizationPromotionPort } from "../release/finalize";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const valid = (value: string) => /^[a-f0-9]{64}$/u.test(value);
type Binding = Readonly<{ candidateId: string; topologySha256: string; authorizationReceiptSha256: string }>;

/** The certified release pointer is SQL authority, separate from traffic
 * cutover. Pointer advancement and its immutable operation result commit in
 * one transaction, with the existing append-only journal trigger auditing both. */
export class PostgresReleasePromotion implements ReleaseFinalizationPromotionPort {
  readonly #pool: PostgresSqlPool;
  readonly #authorization: Readonly<{ request: unknown; receipt: unknown }>;
  readonly #binding: Binding;
  readonly #scope: string;
  readonly #previous: string | null;
  constructor(input: Readonly<{
    pool: PostgresSqlPool; deploymentScopeSha256: string; binding: Binding;
    expectedPreviousBundleSha256: string | null; authorization: Readonly<{ request: unknown; receipt: unknown }>;
    now?: () => number;
  }>) {
    if (![input.deploymentScopeSha256, ...Object.values(input.binding)].every(valid)
      || (input.expectedPreviousBundleSha256 !== null && !valid(input.expectedPreviousBundleSha256))) throw new Error("PRODUCTION_RELEASE_PROMOTION_BINDING_INVALID");
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#scope = input.deploymentScopeSha256;
    this.#binding = Object.freeze(structuredClone(input.binding));
    this.#authorization = Object.freeze(structuredClone(input.authorization));
    this.#previous = input.expectedPreviousBundleSha256;
    this.now = input.now ?? Date.now;
  }
  private readonly now: () => number;
  async #authorize() {
    const receipt = await validateAuthorizationReceipt({ ...this.#authorization, nowMs: this.now() });
    if (receipt.candidateSha256 !== this.#binding.candidateId || receipt.topologySha256 !== this.#binding.topologySha256 || receipt.authorizationReceiptSha256 !== this.#binding.authorizationReceiptSha256) throw new Error("PRODUCTION_RELEASE_PROMOTION_AUTHORITY_REJECTED");
  }
  #identity(input: Readonly<{ operationId: string; bundleSha256: string }>, verificationAuthority?: unknown) {
    if (!valid(input.bundleSha256) || input.operationId !== `promotion-${digest({ candidateId: this.#binding.candidateId, bundleSha256: input.bundleSha256, authorizationReceiptSha256: this.#binding.authorizationReceiptSha256 })}`) throw new Error("PRODUCTION_RELEASE_PROMOTION_OPERATION_REJECTED");
    return { version: 1, ...this.#binding, ...input, expectedPreviousBundleSha256: this.#previous, ...(verificationAuthority === undefined ? {} : { verificationAuthority: FinalVerificationAuthoritySchema.parse(verificationAuthority) }) };
  }
  async #transaction<T>(action: (client: PostgresSqlClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("SET LOCAL lock_timeout = '1s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        const result = await action(client); await client.query("COMMIT"); return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (attempt === 4 || !["40001", "40P01", "23505"].includes(String((error as { code?: string }).code))) throw error;
      } finally { client.release(); }
    }
    throw new Error("PRODUCTION_RELEASE_PROMOTION_RETRY_EXHAUSTED");
  }
  async persist(input: Readonly<{ operationId: string; bundleSha256: string; authorizationReceiptSha256: string; verificationAuthority?: FinalVerificationAuthority }>) {
    await this.#authorize();
    if (input.authorizationReceiptSha256 !== this.#binding.authorizationReceiptSha256) throw new Error("PRODUCTION_RELEASE_PROMOTION_AUTHORITY_REJECTED");
    const identity = this.#identity({ operationId: input.operationId, bundleSha256: input.bundleSha256 }, input.verificationAuthority);
    await this.#transaction(async client => {
      await client.query("INSERT INTO production_real.release_operation_journal(namespace,scope_sha256,operation_id,identity_sha256,value_json) VALUES('release-promotion',$1,'current',$2,$3::jsonb) ON CONFLICT DO NOTHING", [this.#scope, digest({ scope: this.#scope, pointer: "current" }), JSON.stringify({ version: 1, status: "empty", bundleSha256: null })]);
      await client.query("INSERT INTO production_real.release_operation_journal(namespace,scope_sha256,operation_id,identity_sha256,value_json) VALUES('release-promotion',$1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING", [this.#scope, input.operationId, digest(identity), JSON.stringify({ ...identity, status: "pending" })]);
      const row = (await client.query("SELECT identity_sha256 FROM production_real.release_operation_journal WHERE namespace='release-promotion' AND scope_sha256=$1 AND operation_id=$2", [this.#scope, input.operationId])).rows[0];
      if (row?.identity_sha256 !== digest(identity)) throw new Error("PRODUCTION_RELEASE_PROMOTION_OPERATION_CONFLICT");
    });
  }
  async promote(input: Readonly<{ operationId: string; bundleSha256: string }>): Promise<"promoted" | "unknown"> {
    await this.#authorize();
    this.#identity(input);
    return this.#transaction(async client => {
      const pointer = (await client.query("SELECT * FROM production_real.release_operation_journal WHERE namespace='release-promotion' AND scope_sha256=$1 AND operation_id='current' FOR UPDATE", [this.#scope])).rows[0];
      const operation = (await client.query("SELECT * FROM production_real.release_operation_journal WHERE namespace='release-promotion' AND scope_sha256=$1 AND operation_id=$2 FOR UPDATE", [this.#scope, input.operationId])).rows[0];
      if (!operation || !pointer) return "unknown";
      const identity = this.#identity(input, (operation.value_json as Record<string, unknown>).verificationAuthority);
      if (operation.identity_sha256 !== digest(identity)) throw new Error("PRODUCTION_RELEASE_PROMOTION_OPERATION_CONFLICT");
      const value = operation.value_json as Record<string, unknown>;
      if (canonicalJson(value) === canonicalJson({ ...identity, status: "promoted" })) return "promoted";
      if (canonicalJson(value) !== canonicalJson({ ...identity, status: "pending" })) throw new Error("PRODUCTION_RELEASE_PROMOTION_STATE_INVALID");
      if (pointer.identity_sha256 !== digest({ scope: this.#scope, pointer: "current" }) || (pointer.value_json as Record<string, unknown>).bundleSha256 !== this.#previous) throw new Error("PRODUCTION_RELEASE_PROMOTION_PREVIOUS_MISMATCH");
      await this.#authorize();
      for (const [operationId, record] of [["current", { ...identity, status: "promoted" }], [input.operationId, { ...identity, status: "promoted" }]] as const) {
        await client.query("UPDATE production_real.release_operation_journal SET value_json=$3::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE namespace='release-promotion' AND scope_sha256=$1 AND operation_id=$2", [this.#scope, operationId, JSON.stringify(record)]);
      }
      return "promoted";
    });
  }
  /** Reads the original operation even if a later release replaced current.
   * Expired authorization can query history but cannot advance the pointer. */
  async observe(input: Readonly<{ operationId: string; bundleSha256: string }>): Promise<"promoted" | "unknown"> {
    this.#identity(input);
    return this.#transaction(async client => {
      const row = (await client.query("SELECT identity_sha256,value_json FROM production_real.release_operation_journal WHERE namespace='release-promotion' AND scope_sha256=$1 AND operation_id=$2", [this.#scope, input.operationId])).rows[0];
      if (!row) return "unknown";
      const identity = this.#identity(input, (row.value_json as Record<string, unknown>).verificationAuthority);
      if (row.identity_sha256 !== digest(identity)) throw new Error("PRODUCTION_RELEASE_PROMOTION_OPERATION_CONFLICT");
      return canonicalJson(row.value_json) === canonicalJson({ ...identity, status: "promoted" }) ? "promoted" : "unknown";
    });
  }
}
