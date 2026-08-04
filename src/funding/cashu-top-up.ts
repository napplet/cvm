import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { type Principal, VerifiedSettlementSchema } from "../phase-03/contracts";
import { FundingService } from "./funding-service";
import { CashuMintPolicyRegistry, type CashuMintPolicy } from "./cashu-mint-policy";
import { type CashuObserveRequest, type CashuSettlementObservation, type CashuSettlementPort, type CashuTreasuryState } from "./cashu-provider";

const CashuPmi = "bitcoin-cashu-v4-direct";
const SubmitSchema = z.object({
  principal: z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(), idempotencyKey: z.string().min(1), topUpId: z.string().min(1),
  amount: z.string().regex(/^[1-9][0-9]*$/u), unit: z.literal("sat"), pmi: z.literal(CashuPmi), token: z.instanceof(Uint8Array),
}).strict();
type Submit = z.infer<typeof SubmitSchema>;
export type CashuTopUpState = "verifying" | "credited" | "failed" | "reconciliation_pending";
export type CashuTopUpResult = Readonly<{ topUpId: string; state: CashuTopUpState; policyVersion: string; commitment: string; settlementReference?: string; treasuryState?: CashuTreasuryState }>;
type Vault = Readonly<{ seal(metadata: { accountId: string; topUpId: string; rail: "cashu" }, plaintext: Uint8Array): Promise<{ id: string; payloadDigest: string }>; expire(id: string): Promise<void>; open?(request: { id: string; accountId: string; topUpId: string; rail: "cashu" }): Promise<Uint8Array> }>;
type Record = { result: CashuTopUpResult; accountId: string; policy: CashuMintPolicy; protectedId: string; idempotencyKey: string; principal: Principal; amount: string; token?: Uint8Array };
type Journal = { records: Map<string, Record>; commitments: Set<string>; treasury: Map<string, CashuTopUpResult> };
const journals = new WeakMap<FundingService, Journal>();
function journalFor(funding: FundingService): Journal {
  const existing = journals.get(funding); if (existing) return existing;
  const journal = { records: new Map(), commitments: new Set(), treasury: new Map() }; journals.set(funding, journal); return journal;
}
async function sha256(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function frozen<T>(value: T): T { return Object.freeze(structuredClone(value)); }
function asError(code: string): Error { return new Error(code); }

/** Coordinates protected bearer material, adapter observations, and the sole credit authority. */
export class CashuTopUpCoordinator {
  readonly #journal: Journal;
  constructor(private readonly options: Readonly<{ policies: CashuMintPolicyRegistry; provider: CashuSettlementPort; vault: Vault; funding: FundingService }>) { this.#journal = journalFor(options.funding); }

  async prepare(input: unknown): Promise<CashuTopUpResult> { return this.submit(input); }

  async submit(input: unknown): Promise<CashuTopUpResult> {
    if (input && typeof input === "object" && "pmi" in input && (input as { pmi?: unknown }).pmi !== CashuPmi) throw asError("CASHU_PMI_UNSUPPORTED");
    let submitted: Submit;
    try { submitted = SubmitSchema.parse(input); } catch { throw asError("CASHU_INPUT_INVALID"); }
    if (submitted.token.byteLength > 8_192) throw asError("CASHU_TOKEN_TOO_LARGE");
    const existing = this.#journal.records.get(submitted.topUpId);
    if (existing) {
      if (existing.idempotencyKey !== submitted.idempotencyKey) throw asError("CASHU_TOP_UP_CONFLICT");
      return existing.result;
    }
    const policy = this.options.policies.pinActive();
    const accountId = await accountIdForPrincipal(submitted.principal as Principal);
    const commitment = await sha256(submitted.token);
    if (this.#journal.commitments.has(commitment)) throw asError("CASHU_PROOF_ALREADY_CLAIMED");
    this.#journal.commitments.add(commitment);
    const protectedReference = await this.options.vault.seal({ accountId, topUpId: submitted.topUpId, rail: "cashu" }, submitted.token);
    const result = frozen({ topUpId: submitted.topUpId, state: "verifying" as const, policyVersion: policy.version, commitment });
    const record: Record = { result, accountId, policy, protectedId: protectedReference.id, idempotencyKey: submitted.idempotencyKey, principal: submitted.principal as Principal, amount: submitted.amount, token: new Uint8Array(submitted.token) };
    this.#journal.records.set(submitted.topUpId, record);
    let observed: CashuSettlementObservation;
    try { observed = await this.options.provider.settle({ topUpId: submitted.topUpId, policy, amount: submitted.amount, commitment, token: submitted.token }); }
    catch { observed = { status: "unknown", operationReference: `cashu:${commitment}` }; }
    return this.#recordObservation(record, submitted, observed);
  }

  async reconcile(topUpId: string): Promise<CashuTopUpResult> {
    const record = this.#journal.records.get(topUpId); if (!record) throw asError("CASHU_TOP_UP_UNKNOWN");
    if (record.result.state !== "reconciliation_pending") return record.result;
    const request: CashuObserveRequest = { topUpId, policy: record.policy, commitment: record.result.commitment };
    if (this.options.vault.open) request.token = await this.options.vault.open({ id: record.protectedId, accountId: record.accountId, topUpId, rail: "cashu" });
    const observed = await this.options.provider.observe(request);
    return this.#recordObservation(record, { principal: record.principal, idempotencyKey: record.idempotencyKey, topUpId, amount: record.amount, unit: "sat", pmi: CashuPmi, token: record.token ?? new Uint8Array() }, observed);
  }

  async reconcileTreasury(topUpId: string): Promise<CashuTopUpResult> {
    const prior = this.#journal.treasury.get(topUpId); if (prior) return prior;
    const record = this.#journal.records.get(topUpId); if (!record || record.result.state !== "credited") throw asError("CASHU_TREASURY_REQUIRES_CREDITED_TOP_UP");
    const treasury = await this.options.provider.reconcileTreasury({ topUpId, commitment: record.result.commitment });
    const result = frozen({ ...record.result, treasuryState: treasury.state });
    record.result = result; this.#journal.treasury.set(topUpId, result);
    return result;
  }

  async #recordObservation(record: Record, submitted: Submit, observed: CashuSettlementObservation): Promise<CashuTopUpResult> {
    if (observed.status === "unknown") {
      record.result = frozen({ ...record.result, state: "reconciliation_pending" as const });
      return record.result;
    }
    if (observed.status === "failed") {
      record.result = frozen({ ...record.result, state: "failed" as const });
      await this.options.vault.expire(record.protectedId); record.token = undefined;
      throw asError(`CASHU_${observed.code.toUpperCase()}`);
    }
    const settlement = VerifiedSettlementSchema.parse({ topUpId: submitted.topUpId, rail: "cashu", unit: "sat", amount: submitted.amount, externalReference: observed.externalReference, settlementReference: observed.settlementReference, verifiedAt: observed.verifiedAt });
    const credited = await this.options.funding.execute({ principal: submitted.principal, idempotencyKey: `cashu-credit:${submitted.topUpId}`, policyVersion: record.policy.version, protocolVersion: CashuPmi, kind: "credit_settlement", payload: { settlement } });
    record.result = frozen({ ...record.result, state: "credited" as const, settlementReference: credited.settlementReference });
    await this.options.vault.expire(record.protectedId); record.token = undefined;
    return record.result;
  }
}
