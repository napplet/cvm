import { getDecodedToken, Wallet } from "@cashu/cashu-ts";
import { z } from "zod";
import { canonicalCashuMintUrl, type CashuMintPolicy } from "./cashu-mint-policy";

const DecimalSatSchema = z.string().regex(/^[1-9][0-9]*$/u);
const IsoTimeSchema = z.iso.datetime();

const VerifiedCashuObservationSchema = z.object({
  status: z.literal("verified"), externalReference: z.string().min(1), settlementReference: z.string().min(1), verifiedAt: IsoTimeSchema,
}).strict();
const FailedCashuObservationSchema = z.object({
  status: z.literal("failed"), code: z.enum(["untrusted_mint", "wrong_unit", "wrong_amount", "inactive_keyset", "invalid_dleq", "unsupported_condition", "duplicate_proof", "malformed", "swap_failed"]),
}).strict();
const UnknownCashuObservationSchema = z.object({ status: z.literal("unknown"), operationReference: z.string().min(1) }).strict();
export const CashuSettlementObservationSchema = z.discriminatedUnion("status", [VerifiedCashuObservationSchema, FailedCashuObservationSchema, UnknownCashuObservationSchema]);
export type CashuSettlementObservation = z.infer<typeof CashuSettlementObservationSchema>;
export type CashuSettlementRequest = Readonly<{ topUpId: string; policy: CashuMintPolicy; amount: string; commitment: string; token: Uint8Array }>;
export type CashuObserveRequest = Readonly<{ topUpId: string; policy: CashuMintPolicy; commitment: string; amount: string; token?: Uint8Array }>;
export type CashuTreasuryState = "held_at_trusted_mint" | "melted_settled" | "failed" | "unknown";

/** Adapter-only port. Its normalized observations have no access to funding or ledger authority. */
export interface CashuSettlementPort {
  settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation>;
  observe(request: CashuObserveRequest): Promise<CashuSettlementObservation>;
  reconcileTreasury(input: Readonly<{ topUpId: string; commitment: string }>): Promise<Readonly<{ state: CashuTreasuryState }>>;
}

function failed(code: Extract<CashuSettlementObservation, { status: "failed" }>["code"]): CashuSettlementObservation { return { status: "failed", code }; }
function mintPolicy(policy: CashuMintPolicy, mintUrl: string) { return policy.mints.find((mint) => mint.url === canonicalCashuMintUrl(mintUrl)); }
function codeOf(error: unknown): Extract<CashuSettlementObservation, { status: "failed" }>["code"] {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("DLEQ")) return "invalid_dleq";
  return "swap_failed";
}

/**
 * The only Cashu library bridge. It validates decoded proof facts against a pinned
 * policy, loads the selected mint, then requires a live receive/swap before value
 * is reported as verified. It intentionally never exposes proofs or cashu-ts DTOs.
 */
export class CashuTsSettlementAdapter implements CashuSettlementPort {
  async settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation> {
    try {
      if (request.token.byteLength === 0 || request.token.byteLength > 8_192) return failed("malformed");
      const decoded = getDecodedToken(new TextDecoder().decode(request.token), []);
      const mint = mintPolicy(request.policy, decoded.mint);
      if (!mint) return failed("untrusted_mint");
      if (decoded.unit !== "sat") return failed("wrong_unit");
      const proofIds = new Set<string>(); const proofSecrets = new Set<string>();
      let total = 0n;
      for (const proof of decoded.proofs) {
        if (!mint.keysetIds.includes(proof.id)) return failed("inactive_keyset");
        if (proof.witness !== undefined || !mint.proofConditions.includes("none")) return failed("unsupported_condition");
        if (proofSecrets.has(proof.secret)) return failed("duplicate_proof");
        proofSecrets.add(proof.secret); proofIds.add(proof.id); total += BigInt(proof.amount.toString());
      }
      if (proofIds.size !== 1 || total !== BigInt(request.amount)) return failed("wrong_amount");
      const keysetId = [...proofIds][0]!;
      const wallet = new Wallet(mint.url, { unit: "sat", keysetId, requireSigDleq: mint.requireDleq });
      await wallet.loadMint();
      const preview = await wallet.ops.receive(decoded).keyset(keysetId).requireDleq(mint.requireDleq).prepare();
      await wallet.completeSwap(preview);
      return { status: "verified", externalReference: `cashu:${request.commitment}`, settlementReference: `cashu-swap:${request.commitment}`, verifiedAt: new Date().toISOString() };
    } catch (error) { return failed(codeOf(error)); }
  }

  async observe(request: CashuObserveRequest): Promise<CashuSettlementObservation> {
    // A mint observation needs original protected proofs. Absence is explicit rather
    // than inferred success; the coordinator supplies them only after vault access.
    if (!request.token) return { status: "unknown", operationReference: `cashu:${request.commitment}` };
    return this.settle({ ...request, token: request.token });
  }

  async reconcileTreasury(): Promise<Readonly<{ state: CashuTreasuryState }>> { return { state: "unknown" }; }
}

/** Deterministic test adapter: it returns observations only and cannot credit accounts. */
export class FakeCashuSettlementPort implements CashuSettlementPort {
  settleCalls = 0; observeCalls = 0; treasuryCalls = 0;
  requests: CashuSettlementRequest[] = [];
  #settlements: CashuSettlementObservation[] = [];
  #observations: CashuSettlementObservation[] = [];
  #treasury: Readonly<{ state: CashuTreasuryState }>[] = [];
  #effectThenThrow?: CashuSettlementObservation;
  nextSettlement(value: CashuSettlementObservation): void { this.#settlements.push(CashuSettlementObservationSchema.parse(value)); }
  nextObservation(value: CashuSettlementObservation): void { this.#observations.push(CashuSettlementObservationSchema.parse(value)); }
  nextTreasury(value: Readonly<{ state: CashuTreasuryState }>): void { this.#treasury.push(value); }
  effectThenThrowOnce(value: CashuSettlementObservation): void { this.#effectThenThrow = CashuSettlementObservationSchema.parse(value); }
  async settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation> {
    this.settleCalls += 1; this.requests.push(structuredClone(request));
    if (this.#effectThenThrow) {
      const observed = this.#effectThenThrow; this.#effectThenThrow = undefined;
      this.#observations.push(observed);
      throw new Error("CASHU_SETTLEMENT_UNKNOWN");
    }
    return this.#settlements.shift() ?? { status: "unknown", operationReference: `cashu:${request.commitment}` };
  }
  async observe(request: CashuObserveRequest): Promise<CashuSettlementObservation> {
    this.observeCalls += 1;
    return this.#observations.shift() ?? { status: "unknown", operationReference: `cashu:${request.commitment}` };
  }
  async reconcileTreasury(): Promise<Readonly<{ state: CashuTreasuryState }>> { this.treasuryCalls += 1; return this.#treasury.shift() ?? { state: "unknown" }; }
}
