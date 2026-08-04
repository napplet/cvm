import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { type Principal, VerifiedSettlementSchema } from "../phase-03/contracts";
import { FundingService } from "./funding-service";
import { CashuMintPolicyRegistry, type CashuMintPolicy } from "./cashu-mint-policy";
import { type CashuObserveRequest, type CashuSettlementObservation, type CashuSettlementPort, type CashuTreasuryState } from "./cashu-provider";

const CashuPmi = "bitcoin-cashu-v4-direct";
const SubmitSchema = z.object({
  principal: z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(), idempotencyKey: z.string().min(1), topUpId: z.string().min(1),
  amount: z.string().regex(/^[1-9][0-9]*$/u).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)), unit: z.literal("sat"), pmi: z.literal(CashuPmi), token: z.instanceof(Uint8Array),
}).strict();
type Submit = z.infer<typeof SubmitSchema>;
export type CashuTopUpState = "verifying" | "credited" | "failed" | "reconciliation_pending";
export type CashuTopUpResult = Readonly<{ topUpId: string; state: CashuTopUpState; policyVersion: string; commitment: string; settlementReference?: string; treasuryState?: CashuTreasuryState }>;
type Vault = Readonly<{ seal(metadata: { accountId: string; topUpId: string; rail: "cashu" }, plaintext: Uint8Array): Promise<{ id: string; payloadDigest: string }>; expire(id: string): Promise<void>; open?(request: { id: string; accountId: string; topUpId: string; rail: "cashu" }): Promise<Uint8Array> }>;
export type CashuTopUpRecord = Readonly<{ result: CashuTopUpResult; accountId: string; policy: CashuMintPolicy; protectedId: string; idempotencyKey: string; principal: Principal; amount: string; createdAt: string }>;
export interface CashuTopUpRepository {
  /** Durable uniqueness claim before any bearer is sealed or provider effect starts. */
  claim(input: CashuTopUpRecord): Promise<Readonly<{ claimed: boolean; record: CashuTopUpRecord }>>;
  find(topUpId: string): Promise<CashuTopUpRecord | undefined>;
  update(record: CashuTopUpRecord): Promise<void>;
  findTreasury(topUpId: string): Promise<CashuTopUpResult | undefined>;
  recordTreasury(topUpId: string, result: CashuTopUpResult): Promise<void>;
}
/** Test-only repository. Production composition must provide a PostgreSQL-backed implementation. */
export class InMemoryCashuTopUpRepository implements CashuTopUpRepository {
  #records = new Map<string, CashuTopUpRecord>(); #commitments = new Map<string, string>(); #treasury = new Map<string, CashuTopUpResult>(); #tail = Promise.resolve();
  async claim(input: CashuTopUpRecord): Promise<Readonly<{ claimed: boolean; record: CashuTopUpRecord }>> {
    let release!: () => void; const prior = this.#tail; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior;
    try {
      const existing = this.#records.get(input.result.topUpId); if (existing) return frozen({ claimed: false, record: existing });
      const committed = this.#commitments.get(input.result.commitment); if (committed) return frozen({ claimed: false, record: this.#records.get(committed)! });
      const value = frozen(input); this.#records.set(value.result.topUpId, value); this.#commitments.set(value.result.commitment, value.result.topUpId); return frozen({ claimed: true, record: value });
    } finally { release(); }
  }
  async find(topUpId: string): Promise<CashuTopUpRecord | undefined> { const value = this.#records.get(topUpId); return value && frozen(value); }
  async update(record: CashuTopUpRecord): Promise<void> { if (!this.#records.has(record.result.topUpId)) throw asError("CASHU_TOP_UP_UNKNOWN"); this.#records.set(record.result.topUpId, frozen(record)); }
  async findTreasury(topUpId: string): Promise<CashuTopUpResult | undefined> { const value = this.#treasury.get(topUpId); return value && frozen(value); }
  async recordTreasury(topUpId: string, result: CashuTopUpResult): Promise<void> { this.#treasury.set(topUpId, frozen(result)); }
}
async function sha256(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function frozen<T>(value: T): T { return Object.freeze(structuredClone(value)); }
function asError(code: string): Error { return new Error(code); }

/** Coordinates protected bearer material, adapter observations, and the sole credit authority. */
export class CashuTopUpCoordinator {
  readonly #now: () => string;
  readonly #providerTimeoutMs: number;
  constructor(private readonly options: Readonly<{ policies: CashuMintPolicyRegistry; provider: CashuSettlementPort; vault: Vault; funding: FundingService; repository: CashuTopUpRepository; now?: () => string; providerTimeoutMs?: number }>) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#providerTimeoutMs = options.providerTimeoutMs ?? 5_000;
    if (this.#providerTimeoutMs < 1) throw asError("INVALID_PROVIDER_TIMEOUT");
  }

  async prepare(input: unknown): Promise<CashuTopUpResult> { return this.submit(input); }

  async submit(input: unknown): Promise<CashuTopUpResult> {
    if (input && typeof input === "object" && "pmi" in input && (input as { pmi?: unknown }).pmi !== CashuPmi) throw asError("CASHU_PMI_UNSUPPORTED");
    let submitted: Submit;
    try { submitted = SubmitSchema.parse(input); } catch { throw asError("CASHU_INPUT_INVALID"); }
    if (submitted.token.byteLength > 8_192) throw asError("CASHU_TOKEN_TOO_LARGE");
    if (BigInt(submitted.amount) > BigInt(Number.MAX_SAFE_INTEGER)) throw asError("CASHU_AMOUNT_OUT_OF_RANGE");
    // Pin synchronously at accepted-command time, before any await can allow a
    // policy rotation to change the meaning of this bearer.
    const policy = this.options.policies.pinActive();
    const accountId = await accountIdForPrincipal(submitted.principal as Principal);
    const commitment = await sha256(submitted.token);
    const existing = await this.options.repository.find(submitted.topUpId);
    if (existing) {
      if (existing.accountId !== accountId) throw asError("CASHU_TOP_UP_NOT_OWNER");
      if (existing.idempotencyKey !== submitted.idempotencyKey || existing.amount !== submitted.amount || existing.result.commitment !== commitment) throw asError("CASHU_TOP_UP_CONFLICT");
      return existing.result;
    }
    const protectedReference = await this.options.vault.seal({ accountId, topUpId: submitted.topUpId, rail: "cashu" }, submitted.token);
    const result = frozen({ topUpId: submitted.topUpId, state: "verifying" as const, policyVersion: policy.version, commitment });
    const claimed = await this.options.repository.claim({ result, accountId, policy, protectedId: protectedReference.id, idempotencyKey: submitted.idempotencyKey, principal: submitted.principal as Principal, amount: submitted.amount, createdAt: this.#now() });
    if (!claimed.claimed) {
      await this.options.vault.expire(protectedReference.id);
      if (claimed.record.accountId !== accountId) throw asError("CASHU_TOP_UP_NOT_OWNER");
      if (claimed.record.result.topUpId !== submitted.topUpId) throw asError("CASHU_PROOF_ALREADY_CLAIMED");
      if (claimed.record.idempotencyKey !== submitted.idempotencyKey || claimed.record.amount !== submitted.amount || claimed.record.result.commitment !== commitment) throw asError("CASHU_TOP_UP_CONFLICT");
      return claimed.record.result;
    }
    const record = claimed.record;
    let observed: CashuSettlementObservation;
    try { observed = await this.#boundedProvider(this.options.provider.settle({ topUpId: submitted.topUpId, policy, amount: submitted.amount, commitment, token: submitted.token })); }
    catch { observed = { status: "unknown", operationReference: `cashu:${commitment}` }; }
    return this.#recordObservation(record, submitted, observed);
  }

  async reconcile(topUpId: string): Promise<CashuTopUpResult> {
    const record = await this.options.repository.find(topUpId); if (!record) throw asError("CASHU_TOP_UP_UNKNOWN");
    if (record.result.state !== "reconciliation_pending") return record.result;
    const request: CashuObserveRequest = { topUpId, policy: record.policy, commitment: record.result.commitment, amount: record.amount };
    // Reconciliation is query-only.  Bearer material is deliberately not supplied
    // to a provider observation because it could be re-submitted as a swap.
    let observed: CashuSettlementObservation;
    try { observed = await this.#boundedProvider(this.options.provider.observe(request)); }
    catch { observed = { status: "unknown", operationReference: `cashu:${record.result.commitment}` }; }
    return this.#recordObservation(record, { principal: record.principal, idempotencyKey: record.idempotencyKey, topUpId, amount: record.amount, unit: "sat", pmi: CashuPmi, token: new Uint8Array() }, observed);
  }

  async reconcileTreasury(topUpId: string): Promise<CashuTopUpResult> {
    const prior = await this.options.repository.findTreasury(topUpId); if (prior) return prior;
    const record = await this.options.repository.find(topUpId); if (!record || record.result.state !== "credited") throw asError("CASHU_TREASURY_REQUIRES_CREDITED_TOP_UP");
    let treasury: Readonly<{ state: CashuTreasuryState }>;
    try { treasury = await this.#boundedProvider(this.options.provider.reconcileTreasury({ topUpId, commitment: record.result.commitment })); }
    catch { treasury = { state: "unknown" }; }
    const result = frozen({ ...record.result, treasuryState: treasury.state });
    await this.options.repository.update({ ...record, result }); await this.options.repository.recordTreasury(topUpId, result);
    return result;
  }

  async #recordObservation(record: CashuTopUpRecord, submitted: Submit, observed: CashuSettlementObservation): Promise<CashuTopUpResult> {
    if (observed.status === "unknown") {
      const result = frozen({ ...record.result, state: "reconciliation_pending" as const }); await this.options.repository.update({ ...record, result }); return result;
    }
    if (observed.status === "failed") {
      await this.options.repository.update({ ...record, result: frozen({ ...record.result, state: "failed" as const }) });
      await this.options.vault.expire(record.protectedId);
      throw asError(`CASHU_${observed.code.toUpperCase()}`);
    }
    const settlement = VerifiedSettlementSchema.parse({ topUpId: submitted.topUpId, rail: "cashu", unit: "sat", amount: submitted.amount, externalReference: observed.externalReference, settlementReference: observed.settlementReference, verifiedAt: observed.verifiedAt });
    const credited = await this.options.funding.execute({ principal: submitted.principal, idempotencyKey: `cashu-credit:${submitted.topUpId}`, policyVersion: record.policy.version, protocolVersion: CashuPmi, kind: "credit_settlement", payload: { settlement } });
    if (credited.status !== "credited") throw asError("CASHU_CREDIT_RESULT_INVALID");
    const result = frozen({ ...record.result, state: "credited" as const, settlementReference: credited.settlementReference }); await this.options.repository.update({ ...record, result });
    await this.options.vault.expire(record.protectedId);
    return result;
  }

  async #boundedProvider<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(asError("RAIL_PROVIDER_DEADLINE_EXCEEDED")), this.#providerTimeoutMs); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
