import { CheckStateEnum, getDecodedToken, HttpResponseError, JSONInt, Mint, MintOperationError, NetworkError, Wallet, type RequestFn, type RequestOptions } from "@cashu/cashu-ts";
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
export type CashuSettlementRequest = Readonly<{ topUpId: string; policy: CashuMintPolicy; amount: string; commitment: string; token: Uint8Array; signal: AbortSignal }>;
export type CashuObserveRequest = Readonly<{ topUpId: string; policy: CashuMintPolicy; commitment: string; amount: string; token?: Uint8Array; signal: AbortSignal }>;
export type CashuTreasuryState = "held_at_trusted_mint" | "melted_settled" | "failed" | "unknown";

/** Adapter-only port. Its normalized observations have no access to funding or ledger authority. */
export interface CashuSettlementPort {
  settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation>;
  observe(request: CashuObserveRequest): Promise<CashuSettlementObservation>;
  reconcileTreasury(input: Readonly<{ topUpId: string; commitment: string; signal: AbortSignal }>): Promise<Readonly<{ state: CashuTreasuryState }>>;
}

function failed(code: Extract<CashuSettlementObservation, { status: "failed" }>["code"]): CashuSettlementObservation { return { status: "failed", code }; }
function mintPolicy(policy: CashuMintPolicy, mintUrl: string) { return policy.mints.find((mint) => mint.url === canonicalCashuMintUrl(mintUrl)); }
function codeOf(error: unknown): Extract<CashuSettlementObservation, { status: "failed" }>["code"] {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("DLEQ")) return "invalid_dleq";
  return "swap_failed";
}
async function sha256(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

type DecodedToken = ReturnType<typeof getDecodedToken>;
type AllowedMint = CashuMintPolicy["mints"][number];
type CashuWalletOperationInput = Readonly<{ decoded: DecodedToken; mint: AllowedMint; keysetId: string; signal: AbortSignal }>;
export interface CashuWalletOperations {
  settle(input: CashuWalletOperationInput): Promise<void>;
  observe(input: CashuWalletOperationInput): Promise<"spent" | "pending" | "unspent" | "mixed">;
}

class OpaqueCashuSwapError extends Error { constructor(readonly cause: unknown) { super("CASHU_SWAP_OUTCOME_UNKNOWN"); } }

const fetchMintJson: RequestFn = async <T>(options: RequestOptions): Promise<T> => {
  const { endpoint, requestBody, headers = {}, logger: _logger, requestTimeout: _requestTimeout, onResponseMeta: _onResponseMeta, cached_endpoints: _cachedEndpoints, ttl: _ttl, ...init } = options as RequestOptions & { cached_endpoints?: unknown; ttl?: unknown };
  let response: Response;
  try {
    response = await fetch(endpoint, {
      ...init,
      headers: { accept: "application/json", ...(requestBody ? { "content-type": "application/json" } : {}), ...headers },
      ...(requestBody ? { body: JSONInt.stringify(requestBody) } : {}),
    });
  } catch (error) {
    throw new NetworkError("Cashu mint request failed", { cause: error });
  }
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text.length > 0 ? JSONInt.parse(text) : {}; }
  catch (error) { throw new HttpResponseError("Cashu mint returned malformed JSON", response.status, { cause: error }); }
  if (!response.ok) {
    if (parsed && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "number" && "detail" in parsed && typeof parsed.detail === "string") throw new MintOperationError(parsed.code, parsed.detail);
    throw new HttpResponseError(`Cashu mint HTTP ${response.status}`, response.status);
  }
  return parsed as T;
};

/** cashu-ts bridge whose every HTTP request is bound to the coordinator signal. */
class CashuTsWalletOperations implements CashuWalletOperations {
  constructor(private readonly request: RequestFn = fetchMintJson) {}
  async settle(input: CashuWalletOperationInput): Promise<void> {
    const wallet = this.wallet(input);
    input.signal.throwIfAborted();
    await wallet.loadMint();
    input.signal.throwIfAborted();
    const preview = await wallet.ops.receive(input.decoded).keyset(input.keysetId).requireDleq(input.mint.requireDleq).prepare();
    input.signal.throwIfAborted();
    try { await wallet.completeSwap(preview); }
    catch (error) { throw new OpaqueCashuSwapError(error); }
    input.signal.throwIfAborted();
  }
  async observe(input: CashuWalletOperationInput): Promise<"spent" | "pending" | "unspent" | "mixed"> {
    const states = await this.wallet(input).checkProofsStates(input.decoded.proofs);
    input.signal.throwIfAborted();
    if (states.every(({ state }) => state === CheckStateEnum.SPENT)) return "spent";
    if (states.every(({ state }) => state === CheckStateEnum.UNSPENT)) return "unspent";
    if (states.some(({ state }) => state === CheckStateEnum.PENDING)) return "pending";
    return "mixed";
  }
  private wallet(input: CashuWalletOperationInput): Wallet {
    const request: RequestFn = (options) => this.request({ ...options, signal: input.signal });
    const mint = new Mint(input.mint.url, { customRequest: request });
    return new Wallet(mint, { unit: "sat", keysetId: input.keysetId, requireSigDleq: input.mint.requireDleq });
  }
}

/**
 * The only Cashu library bridge. It validates decoded proof facts against a pinned
 * policy, loads the selected mint, then requires a live receive/swap before value
 * is reported as verified. It intentionally never exposes proofs or cashu-ts DTOs.
 */
export class CashuTsSettlementAdapter implements CashuSettlementPort {
  readonly #operations: CashuWalletOperations;
  readonly #now: () => string;
  constructor(options: Readonly<{ operations?: CashuWalletOperations; request?: RequestFn; now?: () => string }> = {}) {
    this.#operations = options.operations ?? new CashuTsWalletOperations(options.request);
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  async settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation> {
    try {
      request.signal.throwIfAborted();
      if (request.token.byteLength === 0 || request.token.byteLength > 8_192) return failed("malformed");
      const decoded = getDecodedToken(new TextDecoder().decode(request.token), request.policy.mints.flatMap(({ keysetIds }) => keysetIds));
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
      await this.#operations.settle({ decoded, mint, keysetId: [...proofIds][0]!, signal: request.signal });
      return { status: "verified", externalReference: `cashu:${request.commitment}`, settlementReference: `cashu-swap:${request.topUpId}:${request.commitment}`, verifiedAt: this.#now() };
    } catch (error) {
      if (request.signal.aborted || error instanceof OpaqueCashuSwapError) return { status: "unknown", operationReference: `cashu:${request.commitment}` };
      return failed(codeOf(error));
    }
  }

  async observe(request: CashuObserveRequest): Promise<CashuSettlementObservation> {
    try {
      request.signal.throwIfAborted();
      if (!request.token || request.token.byteLength === 0 || await sha256(request.token) !== request.commitment) return { status: "unknown", operationReference: `cashu:${request.commitment}` };
      const decoded = getDecodedToken(new TextDecoder().decode(request.token), request.policy.mints.flatMap(({ keysetIds }) => keysetIds));
      const mint = mintPolicy(request.policy, decoded.mint);
      if (!mint || decoded.unit !== "sat") return { status: "unknown", operationReference: `cashu:${request.commitment}` };
      const amount = decoded.proofs.reduce((total, proof) => total + BigInt(proof.amount.toString()), 0n);
      if (amount !== BigInt(request.amount)) return { status: "unknown", operationReference: `cashu:${request.commitment}` };
      const keysets = new Set(decoded.proofs.map((proof) => proof.id));
      if (keysets.size !== 1 || !mint.keysetIds.includes([...keysets][0]!)) return { status: "unknown", operationReference: `cashu:${request.commitment}` };
      const state = await this.#operations.observe({ decoded, mint, keysetId: [...keysets][0]!, signal: request.signal });
      if (state === "spent") return { status: "verified", externalReference: `cashu:${request.commitment}`, settlementReference: `cashu-swap:${request.topUpId}:${request.commitment}`, verifiedAt: this.#now() };
      if (state === "unspent") return failed("swap_failed");
      return { status: "unknown", operationReference: `cashu:${request.commitment}` };
    } catch {
      return { status: "unknown", operationReference: `cashu:${request.commitment}` };
    }
  }

  async reconcileTreasury(): Promise<Readonly<{ state: CashuTreasuryState }>> { return { state: "unknown" }; }
}

/** Deterministic test adapter: it returns observations only and cannot credit accounts. */
export class FakeCashuSettlementPort implements CashuSettlementPort {
  settleCalls = 0; observeCalls = 0; treasuryCalls = 0;
  requests: Omit<CashuSettlementRequest, "signal">[] = [];
  #settlements: CashuSettlementObservation[] = [];
  #observations: CashuSettlementObservation[] = [];
  #treasury: Readonly<{ state: CashuTreasuryState }>[] = [];
  #effectThenThrow?: CashuSettlementObservation;
  nextSettlement(value: CashuSettlementObservation): void { this.#settlements.push(CashuSettlementObservationSchema.parse(value)); }
  nextObservation(value: CashuSettlementObservation): void { this.#observations.push(CashuSettlementObservationSchema.parse(value)); }
  nextTreasury(value: Readonly<{ state: CashuTreasuryState }>): void { this.#treasury.push(value); }
  effectThenThrowOnce(value: CashuSettlementObservation): void { this.#effectThenThrow = CashuSettlementObservationSchema.parse(value); }
  async settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation> {
    request.signal.throwIfAborted();
    const { signal: _, ...recorded } = request;
    this.settleCalls += 1; this.requests.push(structuredClone(recorded));
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
