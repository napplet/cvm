import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { type Principal, VerifiedSettlementSchema } from "../phase-03/contracts";
import { FundingService } from "./funding-service";
import { CashuMintPolicyRegistry, type CashuMintPolicy } from "./cashu-mint-policy";
import { type CashuObserveRequest, type CashuSettlementObservation, type CashuSettlementPort, type CashuTreasuryCustody, type CashuTreasuryState } from "./cashu-provider";
import type { VerifiedCreditWakeDispatcher } from "../continuity/continuation-service";

const CashuPmi = "bitcoin-cashu-v4-direct";
const SubmitSchema = z.object({
  principal: z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(), idempotencyKey: z.string().min(1), topUpId: z.string().min(1),
  amount: z.string().regex(/^[1-9][0-9]*$/u).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)), maxFee: z.string().regex(/^[0-9]+$/u).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)), unit: z.literal("sat"), pmi: z.literal(CashuPmi), token: z.instanceof(Uint8Array),
}).strict();
type Submit = z.infer<typeof SubmitSchema>;
export type CashuTopUpState = "verifying" | "credited" | "failed" | "reconciliation_pending";
export type CashuTopUpResult = Readonly<{ topUpId: string; state: CashuTopUpState; policyVersion: string; commitment: string; amount?: string; grossAmount?: string; feeAmount?: string; settlementReference?: string; treasuryState?: CashuTreasuryState }>;
type Vault = Readonly<{ seal(metadata: { accountId: string; topUpId: string; rail: "cashu" }, plaintext: Uint8Array): Promise<{ id: string; payloadDigest: string }>; expire(id: string): Promise<void>; open?(request: { id: string; accountId: string; topUpId: string; rail: "cashu" }): Promise<Uint8Array> }>;
export type CashuCustodyJournal = Readonly<{
  operationId: string; mintUrl: string; keysetId: string; unit: "sat"; amount: string; maxFee: string; inputFeePpk: number; feeAmount: string; expectedOutputAmount: string;
  inputProtectedId: string; outputDataProtectedId: string; outputDataDigest: string; state: "prepared" | "dispatching" | "owned_outputs";
  ownedOutputsProtectedId?: string; ownedOutputsDigest?: string;
}>;
export type CashuTopUpRecord = Readonly<{ result: CashuTopUpResult; accountId: string; policy: CashuMintPolicy; protectedId: string; semanticProofIdentities: readonly string[]; idempotencyKey: string; principal: Principal; amount: string; maxFee: string; createdAt: string; custody?: CashuCustodyJournal }>;
export interface CashuTopUpRepository {
  /** Durable uniqueness claim before any bearer is sealed or provider effect starts. */
  claim(input: CashuTopUpRecord): Promise<Readonly<{ claimed: boolean; record: CashuTopUpRecord }>>;
  find(topUpId: string): Promise<CashuTopUpRecord | undefined>;
  update(record: CashuTopUpRecord): Promise<void>;
  /** Row-locked, monotonic lifecycle projection update. */
  updateResult(topUpId: string, result: CashuTopUpResult): Promise<CashuTopUpRecord>;
  /** Persist-before-effect custody journal and a durable single-dispatch fence. */
  prepareCustody(topUpId: string, journal: Omit<CashuCustodyJournal, "state">): Promise<CashuCustodyJournal>;
  claimCustodyDispatch(topUpId: string): Promise<boolean>;
  recordOwnedCustodyOutputs(topUpId: string, protectedId: string, payloadDigest: string): Promise<Readonly<{ accepted: boolean; protectedId: string }>>;
  custody(topUpId: string): Promise<CashuCustodyJournal | undefined>;
  findTreasury(topUpId: string): Promise<CashuTopUpResult | undefined>;
  recordTreasury(topUpId: string, result: CashuTopUpResult): Promise<void>;
}
/** Test-only repository. Production composition must provide a PostgreSQL-backed implementation. */
export class InMemoryCashuTopUpRepository implements CashuTopUpRepository {
  #records = new Map<string, CashuTopUpRecord>(); #proofIdentities = new Map<string, string>(); #treasury = new Map<string, CashuTopUpResult>(); #tail = Promise.resolve();
  async claim(input: CashuTopUpRecord): Promise<Readonly<{ claimed: boolean; record: CashuTopUpRecord }>> {
    let release!: () => void; const prior = this.#tail; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior;
    try {
      const existing = this.#records.get(input.result.topUpId); if (existing) return frozen({ claimed: false, record: existing });
      const committed = input.semanticProofIdentities.map((identity) => this.#proofIdentities.get(identity)).find(Boolean); if (committed) return frozen({ claimed: false, record: this.#records.get(committed)! });
      const value = frozen(input); this.#records.set(value.result.topUpId, value); for (const identity of value.semanticProofIdentities) this.#proofIdentities.set(identity, value.result.topUpId); return frozen({ claimed: true, record: value });
    } finally { release(); }
  }
  async find(topUpId: string): Promise<CashuTopUpRecord | undefined> { const value = this.#records.get(topUpId); return value && frozen(value); }
  async update(record: CashuTopUpRecord): Promise<void> { if (!this.#records.has(record.result.topUpId)) throw asError("CASHU_TOP_UP_UNKNOWN"); this.#records.set(record.result.topUpId, frozen(record)); }
  async updateResult(topUpId: string, result: CashuTopUpResult): Promise<CashuTopUpRecord> {
    return this.#mutate(topUpId, (record) => {
      const updated = frozen({ ...record, result: monotonicResult(record.result, result) });
      return [updated, updated] as const;
    });
  }
  async prepareCustody(topUpId: string, journal: Omit<CashuCustodyJournal, "state">): Promise<CashuCustodyJournal> {
    return this.#mutate(topUpId, (record) => {
      if (record.custody) {
        const { state: _state, outputDataProtectedId: _id, ...existing } = record.custody;
        const { outputDataProtectedId: _requestedId, ...requested } = journal;
        if (JSON.stringify(existing) !== JSON.stringify(requested)) throw asError("CASHU_CUSTODY_CONFLICT");
        return [record, record.custody] as const;
      }
      const custody = frozen({ ...journal, state: "prepared" as const });
      return [frozen({ ...record, custody }), custody] as const;
    });
  }
  async claimCustodyDispatch(topUpId: string): Promise<boolean> {
    return this.#mutate(topUpId, (record) => {
      if (!record.custody || record.custody.state !== "prepared") return [record, false] as const;
      return [frozen({ ...record, custody: frozen({ ...record.custody, state: "dispatching" as const }) }), true] as const;
    });
  }
  async recordOwnedCustodyOutputs(topUpId: string, protectedId: string, payloadDigest: string): Promise<Readonly<{ accepted: boolean; protectedId: string }>> {
    return this.#mutate<Readonly<{ accepted: boolean; protectedId: string }>>(topUpId, (record) => {
      if (!record.custody || record.custody.state === "prepared") throw asError("CASHU_CUSTODY_DISPATCH_REQUIRED");
      if (record.custody.ownedOutputsProtectedId) {
        if (record.custody.ownedOutputsDigest !== payloadDigest) throw asError("CASHU_CUSTODY_OUTPUT_CONFLICT");
        return [record, frozen({ accepted: false, protectedId: record.custody.ownedOutputsProtectedId })] as const;
      }
      return [frozen({ ...record, custody: frozen({ ...record.custody, state: "owned_outputs" as const, ownedOutputsProtectedId: protectedId, ownedOutputsDigest: payloadDigest }) }), frozen({ accepted: true, protectedId })] as const;
    });
  }
  async custody(topUpId: string): Promise<CashuCustodyJournal | undefined> { return (await this.find(topUpId))?.custody; }
  async findTreasury(topUpId: string): Promise<CashuTopUpResult | undefined> { const value = this.#treasury.get(topUpId); return value && frozen(value); }
  async recordTreasury(topUpId: string, result: CashuTopUpResult): Promise<void> { this.#treasury.set(topUpId, frozen(result)); }
  async #mutate<T>(topUpId: string, action: (record: CashuTopUpRecord) => readonly [CashuTopUpRecord, T]): Promise<T> {
    let release!: () => void; const prior = this.#tail; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior;
    try { const record = this.#records.get(topUpId); if (!record) throw asError("CASHU_TOP_UP_UNKNOWN"); const [next, result] = action(record); this.#records.set(topUpId, next); return result; } finally { release(); }
  }
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", view))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function frozen<T>(value: T): T { return Object.freeze(structuredClone(value)); }
function asError(code: string): Error { return new Error(code); }
function monotonicResult(current: CashuTopUpResult, proposed: CashuTopUpResult): CashuTopUpResult {
  if (current.topUpId !== proposed.topUpId || current.commitment !== proposed.commitment || current.policyVersion !== proposed.policyVersion) throw asError("CASHU_TOP_UP_RESULT_CONFLICT");
  if (current.state === "credited" || current.state === "failed") return current;
  if (proposed.state === "verifying") return current;
  if (proposed.state === "reconciliation_pending" && current.state === "reconciliation_pending") return current;
  return proposed;
}

/** Coordinates protected bearer material, adapter observations, and the sole credit authority. */
export class CashuTopUpCoordinator {
  readonly #now: () => string;
  readonly #providerTimeoutMs: number;
  constructor(private readonly options: Readonly<{ policies: CashuMintPolicyRegistry; provider: CashuSettlementPort; vault: Vault; funding: FundingService; repository: CashuTopUpRepository; verifiedCreditWake?: VerifiedCreditWakeDispatcher; now?: () => string; providerTimeoutMs?: number }>) {
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
    if (BigInt(submitted.maxFee) >= BigInt(submitted.amount)) throw asError("CASHU_FEE_CEILING_INVALID");
    // Pin synchronously at accepted-command time, before any await can allow a
    // policy rotation to change the meaning of this bearer.
    const policy = this.options.policies.pinActive();
    const accountId = await accountIdForPrincipal(submitted.principal as Principal);
    const commitment = await sha256(submitted.token);
    const identity = await this.options.provider.identify({ policy, amount: submitted.amount, maxFee: submitted.maxFee, token: submitted.token });
    if (identity.status === "failed") throw asError(`CASHU_${identity.code.toUpperCase()}`);
    const existing = await this.options.repository.find(submitted.topUpId);
    if (existing) {
      if (existing.accountId !== accountId) throw asError("CASHU_TOP_UP_NOT_OWNER");
      if (existing.idempotencyKey !== submitted.idempotencyKey || existing.amount !== submitted.amount || existing.maxFee !== submitted.maxFee || existing.result.commitment !== commitment) throw asError("CASHU_TOP_UP_CONFLICT");
      if (existing.result.state === "credited") await this.options.verifiedCreditWake?.dispatchVerifiedCredit(existing.accountId);
      return existing.result;
    }
    const protectedReference = await this.options.vault.seal({ accountId, topUpId: submitted.topUpId, rail: "cashu" }, submitted.token);
    const result = frozen({ topUpId: submitted.topUpId, state: "verifying" as const, policyVersion: policy.version, commitment });
    const claimed = await this.options.repository.claim({ result, accountId, policy, protectedId: protectedReference.id, semanticProofIdentities: identity.semanticProofIdentities, idempotencyKey: submitted.idempotencyKey, principal: submitted.principal as Principal, amount: submitted.amount, maxFee: submitted.maxFee, createdAt: this.#now() });
    if (!claimed.claimed) {
      await this.options.vault.expire(protectedReference.id);
      if (claimed.record.accountId !== accountId) throw asError("CASHU_TOP_UP_NOT_OWNER");
      if (claimed.record.result.topUpId !== submitted.topUpId) throw asError("CASHU_PROOF_ALREADY_CLAIMED");
      if (claimed.record.idempotencyKey !== submitted.idempotencyKey || claimed.record.amount !== submitted.amount || claimed.record.maxFee !== submitted.maxFee || claimed.record.result.commitment !== commitment || JSON.stringify(claimed.record.semanticProofIdentities) !== JSON.stringify(identity.semanticProofIdentities)) throw asError("CASHU_TOP_UP_CONFLICT");
      if (claimed.record.result.state === "credited") await this.options.verifiedCreditWake?.dispatchVerifiedCredit(claimed.record.accountId);
      return claimed.record.result;
    }
    const record = claimed.record;
    let observed: CashuSettlementObservation;
    try { observed = await this.#boundedProvider((signal) => this.options.provider.settle({ topUpId: submitted.topUpId, accountId, policy, amount: submitted.amount, maxFee: submitted.maxFee, commitment, token: submitted.token, custody: this.#custody(record), signal })); }
    catch { observed = { status: "unknown", operationReference: `cashu:${commitment}` }; }
    return this.#recordObservation(record, submitted, observed);
  }

  async reconcile(topUpId: string): Promise<CashuTopUpResult> {
    const record = await this.options.repository.find(topUpId); if (!record) throw asError("CASHU_TOP_UP_UNKNOWN");
    if (record.result.state !== "reconciliation_pending") {
      if (record.result.state === "credited") await this.options.verifiedCreditWake?.dispatchVerifiedCredit(record.accountId);
      return record.result;
    }
    let token: Uint8Array | undefined;
    if (this.options.vault.open) {
      try { token = await this.options.vault.open({ id: record.protectedId, accountId: record.accountId, topUpId, rail: "cashu" }); }
      catch { token = undefined; }
    }
    const request = (signal: AbortSignal): CashuObserveRequest => ({ topUpId, accountId: record.accountId, policy: record.policy, commitment: record.result.commitment, amount: record.amount, maxFee: record.maxFee, custody: this.#custody(record), ...(token ? { token } : {}), signal });
    // Reconciliation opens the original bearer only for local parse/checkstate
    // binding inside `observe`. That adapter path is query-only and may not
    // dispatch a replacement swap.
    let observed: CashuSettlementObservation;
    try { observed = await this.#boundedProvider((signal) => this.options.provider.observe(request(signal))); }
    catch { observed = { status: "unknown", operationReference: `cashu:${record.result.commitment}` }; }
    return this.#recordObservation(record, { principal: record.principal, idempotencyKey: record.idempotencyKey, topUpId, amount: record.amount, maxFee: record.maxFee, unit: "sat", pmi: CashuPmi, token: new Uint8Array() }, observed);
  }

  async reconcileTreasury(topUpId: string): Promise<CashuTopUpResult> {
    const prior = await this.options.repository.findTreasury(topUpId); if (prior) return prior;
    const record = await this.options.repository.find(topUpId); if (!record || record.result.state !== "credited") throw asError("CASHU_TREASURY_REQUIRES_CREDITED_TOP_UP");
    let treasury: Readonly<{ state: CashuTreasuryState }>;
    try { treasury = await this.#boundedProvider((signal) => this.options.provider.reconcileTreasury({ topUpId, commitment: record.result.commitment, signal })); }
    catch { treasury = { state: "unknown" }; }
    const result = frozen({ ...record.result, treasuryState: treasury.state });
    const updated = await this.#updateResult(record, result); await this.options.repository.recordTreasury(topUpId, updated);
    return updated;
  }

  async #recordObservation(record: CashuTopUpRecord, submitted: Submit, observed: CashuSettlementObservation): Promise<CashuTopUpResult> {
    if (observed.status === "unknown") {
      const result = frozen({ ...record.result, state: "reconciliation_pending" as const }); return this.#updateResult(record, result);
    }
    if (observed.status === "failed") {
      await this.#updateResult(record, frozen({ ...record.result, state: "failed" as const }));
      await this.options.vault.expire(record.protectedId);
      throw asError(`CASHU_${observed.code.toUpperCase()}`);
    }
    const amounts = this.#verifiedAmounts(record, observed);
    const settlement = VerifiedSettlementSchema.parse({ topUpId: submitted.topUpId, rail: "cashu", unit: "sat", amount: amounts.netAmount, externalReference: observed.externalReference, settlementReference: observed.settlementReference, verifiedAt: observed.verifiedAt });
    const credited = await this.options.funding.execute({ principal: submitted.principal, idempotencyKey: `cashu-credit:${submitted.topUpId}`, policyVersion: record.policy.version, protocolVersion: CashuPmi, kind: "credit_settlement", payload: { settlement } });
    if (credited.status !== "credited") throw asError("CASHU_CREDIT_RESULT_INVALID");
    const result = frozen({ ...record.result, state: "credited" as const, amount: amounts.netAmount, grossAmount: amounts.grossAmount, feeAmount: amounts.feeAmount, settlementReference: credited.settlementReference }); const updated = await this.#updateResult(record, result);
    await this.options.vault.expire(record.protectedId);
    await this.options.verifiedCreditWake?.dispatchVerifiedCredit(record.accountId);
    return updated;
  }

  async #updateResult(record: CashuTopUpRecord, result: CashuTopUpResult): Promise<CashuTopUpResult> {
    const updated = await this.options.repository.updateResult(record.result.topUpId, result);
    if (updated.accountId !== record.accountId) throw asError("CASHU_TOP_UP_UNKNOWN");
    return updated.result;
  }

  #verifiedAmounts(record: CashuTopUpRecord, observed: Extract<CashuSettlementObservation, { status: "verified" }>): Readonly<{ grossAmount: string; feeAmount: string; netAmount: string }> {
    // Development fakes predate fee accounting and are deliberately not
    // production-safe. Their sole compatible interpretation is zero fee.
    const amounts = observed.amounts ?? { grossAmount: record.amount, feeAmount: "0", netAmount: record.amount };
    if (amounts.grossAmount !== record.amount || !/^[0-9]+$/u.test(amounts.feeAmount) || BigInt(amounts.feeAmount) > BigInt(record.maxFee) || BigInt(amounts.netAmount) <= 0n || BigInt(amounts.netAmount) + BigInt(amounts.feeAmount) !== BigInt(record.amount)) throw asError("CASHU_VERIFIED_FEE_BINDING_INVALID");
    const custody = record.custody;
    if (custody && (custody.amount !== amounts.grossAmount || custody.maxFee !== record.maxFee || custody.feeAmount !== amounts.feeAmount || custody.expectedOutputAmount !== amounts.netAmount)) throw asError("CASHU_VERIFIED_CUSTODY_FEE_MISMATCH");
    return amounts;
  }

  #custody(record: CashuTopUpRecord): CashuTreasuryCustody {
    const metadata = { accountId: record.accountId, topUpId: record.result.topUpId, rail: "cashu" as const };
    return Object.freeze({
      prepare: async (input: Readonly<{ operationId: string; mintUrl: string; keysetId: string; grossAmount: string; maxFee: string; inputFeePpk: number; feeAmount: string; expectedOutputAmount: string; outputData: readonly unknown[] }>) => {
        const mint = record.policy.mints.find((candidate) => candidate.url === input.mintUrl);
        if (!mint || input.grossAmount !== record.amount || input.maxFee !== record.maxFee || !Number.isSafeInteger(input.inputFeePpk) || input.inputFeePpk < 0 || input.inputFeePpk > mint.maxInputFeePpk || !/^[0-9]+$/u.test(input.feeAmount) || BigInt(input.feeAmount) > BigInt(record.maxFee) || BigInt(input.expectedOutputAmount) <= 0n || BigInt(input.expectedOutputAmount) + BigInt(input.feeAmount) !== BigInt(record.amount)) throw asError("CASHU_CUSTODY_FEE_BINDING_INVALID");
        const plaintext = new TextEncoder().encode(JSON.stringify(input.outputData));
        try {
          const outputData = await this.options.vault.seal(metadata, plaintext);
          // A database response can be lost after commit. Keep the ciphertext
          // until a definite competing record proves it is unreferenced.
          const journal = await this.options.repository.prepareCustody(record.result.topUpId, {
          operationId: input.operationId, mintUrl: input.mintUrl, keysetId: input.keysetId, unit: "sat", amount: record.amount, maxFee: record.maxFee, inputFeePpk: input.inputFeePpk, feeAmount: input.feeAmount,
            expectedOutputAmount: input.expectedOutputAmount, inputProtectedId: record.protectedId, outputDataProtectedId: outputData.id, outputDataDigest: outputData.payloadDigest,
          });
          if (journal.outputDataProtectedId !== outputData.id) await this.options.vault.expire(outputData.id);
          return journal;
        } finally { plaintext.fill(0); }
      },
      claimDispatch: () => this.options.repository.claimCustodyDispatch(record.result.topUpId),
      recordOwnedOutputs: async (outputs: readonly unknown[]) => {
        const plaintext = new TextEncoder().encode(JSON.stringify(outputs));
        try {
          const sealed = await this.options.vault.seal(metadata, plaintext);
          const recorded = await this.options.repository.recordOwnedCustodyOutputs(record.result.topUpId, sealed.id, sealed.payloadDigest);
          if (!recorded.accepted) await this.options.vault.expire(sealed.id);
          // Once exact service-owned proofs are durable, the original blind
          // messages cannot aid a later recovery and are removed promptly.
          // The owned-output ciphertext remains the treasury custody record.
          const custody = await this.options.repository.custody(record.result.topUpId);
          if (!custody?.ownedOutputsProtectedId || custody.outputDataProtectedId === custody.ownedOutputsProtectedId) throw asError("CASHU_CUSTODY_OUTPUT_PERSISTENCE_INVALID");
          await this.options.vault.expire(custody.outputDataProtectedId);
        }
        finally { plaintext.fill(0); }
      },
      load: async () => {
        const custody = await this.options.repository.custody(record.result.topUpId);
        if (!custody || !this.options.vault.open) return custody ? { journal: custody } : undefined;
        // Owned proofs are sufficient for recovery after obsolete blind data
        // has expired. Never require the deleted material on this path.
        const outputData = custody.ownedOutputsProtectedId ? undefined : await this.options.vault.open({ ...metadata, id: custody.outputDataProtectedId });
        try {
          let outputs: Uint8Array | undefined;
          if (custody.ownedOutputsProtectedId) outputs = await this.options.vault.open({ ...metadata, id: custody.ownedOutputsProtectedId });
          return { journal: custody, ...(outputData ? { outputData: outputData.slice() } : {}), ...(outputs ? { outputs } : {}) };
        } finally { outputData?.fill(0); }
      },
    });
  }

  async #boundedProvider<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(controller.signal), new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(asError("RAIL_PROVIDER_DEADLINE_EXCEEDED")); }, this.#providerTimeoutMs); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
