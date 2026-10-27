import { CheckStateEnum, getDecodedToken, HttpResponseError, JSONInt, Mint, MintOperationError, NetworkError, OutputData, Wallet, type RequestFn, type RequestOptions } from "@cashu/cashu-ts";
import { z } from "zod";
import { canonicalCashuMintUrl, type CashuMintPolicy } from "./cashu-mint-policy";
import { canonicalCashuProofIdentities } from "./treasury-custody";

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
export type CashuCustodyJournal = Readonly<{ operationId: string; mintUrl: string; keysetId: string; unit: "sat"; amount: string; expectedOutputAmount: string; inputProtectedId: string; outputDataProtectedId: string; state: "prepared" | "dispatching" | "owned_outputs"; ownedOutputsProtectedId?: string }>;
/**
 * Coordinator-provided narrow persistence port.  It intentionally accepts only
 * opaque JSON-safe output data and is the sole bridge from cashu-ts secrets to
 * encrypted durable custody.  The adapter has no SQL/funding authority.
 */
export interface CashuTreasuryCustody {
  prepare(input: Readonly<{ operationId: string; mintUrl: string; keysetId: string; expectedOutputAmount: string; outputData: readonly unknown[] }>): Promise<CashuCustodyJournal>;
  claimDispatch(): Promise<boolean>;
  recordOwnedOutputs(outputs: readonly unknown[]): Promise<void>;
  load(): Promise<Readonly<{ journal: CashuCustodyJournal; outputData?: Uint8Array; outputs?: Uint8Array }> | undefined>;
}
export type CashuSettlementRequest = Readonly<{ topUpId: string; accountId?: string; policy: CashuMintPolicy; amount: string; commitment: string; token: Uint8Array; custody?: CashuTreasuryCustody; signal: AbortSignal }>;
export type CashuObserveRequest = Readonly<{ topUpId: string; accountId?: string; policy: CashuMintPolicy; commitment: string; amount: string; token?: Uint8Array; custody?: CashuTreasuryCustody; signal: AbortSignal }>;
export type CashuProofIdentity = Readonly<{ status: "accepted"; semanticProofIdentities: readonly string[] }> | Extract<CashuSettlementObservation, { status: "failed" }>;
export type CashuTreasuryState = "held_at_trusted_mint" | "melted_settled" | "failed" | "unknown";

/** Adapter-only port. Its normalized observations have no access to funding or ledger authority. */
export interface CashuSettlementPort {
  /** Validates parsed bearer facts before any durable claim or mint effect. */
  identify(request: Omit<CashuSettlementRequest, "topUpId" | "commitment" | "signal">): Promise<CashuProofIdentity>;
  settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation>;
  observe(request: CashuObserveRequest): Promise<CashuSettlementObservation>;
  reconcileTreasury(input: Readonly<{ topUpId: string; commitment: string; signal: AbortSignal }>): Promise<Readonly<{ state: CashuTreasuryState }>>;
  /** True only for the default cashu-ts bridge with persist-before-swap recovery. */
  readonly productionSafe?: boolean;
}

function failed(code: Extract<CashuSettlementObservation, { status: "failed" }>["code"]): Extract<CashuSettlementObservation, { status: "failed" }> { return { status: "failed", code }; }
function mintPolicy(policy: CashuMintPolicy, mintUrl: string) { return policy.mints.find((mint) => mint.url === canonicalCashuMintUrl(mintUrl)); }
function codeOf(error: unknown): Extract<CashuSettlementObservation, { status: "failed" }>["code"] {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("DLEQ")) return "invalid_dleq";
  return "swap_failed";
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", view))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type DecodedToken = ReturnType<typeof getDecodedToken>;
type AllowedMint = CashuMintPolicy["mints"][number];
type CashuWalletOperationInput = Readonly<{ topUpId: string; decoded: DecodedToken; mint: AllowedMint; keysetId: string; amount: string; custody?: CashuTreasuryCustody; signal: AbortSignal }>;
export interface CashuWalletOperations {
  settle(input: CashuWalletOperationInput): Promise<void>;
  observe(input: CashuWalletOperationInput): Promise<"spent" | "pending" | "unspent" | "mixed">;
  /** Optional because deterministic legacy fakes intentionally cannot claim recovery ownership. */
  recover?(input: CashuWalletOperationInput): Promise<boolean>;
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
    const outputData = [...(preview.keepOutputs ?? []), ...(preview.sendOutputs ?? [])];
    const expectedOutputAmount = OutputData.sumOutputAmounts(outputData).toString();
    // Input fees can reduce the owned outputs. Do not silently credit the
    // submitted face value when a pinned mint quotes a different output value.
    if (expectedOutputAmount !== input.amount) throw new Error("CASHU_OUTPUT_AMOUNT_MISMATCH");
    if (input.custody) {
      await input.custody.prepare({ operationId: `cashu-swap:${input.topUpId}`, mintUrl: input.mint.url, keysetId: input.keysetId, expectedOutputAmount, outputData: outputData.map((output) => OutputData.serialize(output)) });
      if (!await input.custody.claimDispatch()) throw new OpaqueCashuSwapError(new Error("CASHU_DISPATCH_ALREADY_CLAIMED"));
    }
    try {
      const completed = await wallet.completeSwap(preview);
      const outputs = [...completed.keep, ...completed.send];
      this.assertOwnedOutputs(outputs, input);
      if (input.custody) await input.custody.recordOwnedOutputs(outputs);
    }
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
  async recover(input: CashuWalletOperationInput): Promise<boolean> {
    if (!input.custody) return false;
    const loaded = await input.custody.load();
    if (!loaded || loaded.journal.mintUrl !== input.mint.url || loaded.journal.keysetId !== input.keysetId || loaded.journal.amount !== input.amount) return false;
    if (loaded.outputs) {
      try {
        const outputs = JSON.parse(new TextDecoder().decode(loaded.outputs));
        this.assertOwnedOutputs(outputs, input, loaded.journal.expectedOutputAmount);
        return true;
      } finally { loaded.outputs.fill(0); }
    }
    if (!loaded.outputData || loaded.journal.state !== "dispatching") return false;
    try {
      const serialized = JSON.parse(new TextDecoder().decode(loaded.outputData));
      if (!Array.isArray(serialized) || serialized.length === 0) return false;
      const outputData = serialized.map((entry) => OutputData.deserialize(entry));
      const wallet = this.wallet(input);
      await wallet.loadMint();
      input.signal.throwIfAborted();
      // NUT-09 only restores the persisted original blinded messages. Never
      // call Wallet.restore(), which derives fresh seed/counter outputs.
      const restored = await wallet.mint.restore({ outputs: outputData.map((output) => output.blindedMessage) });
      const signatures = new Map(restored.outputs.map((output, index) => [output.B_, restored.signatures[index]]));
      if (signatures.size !== outputData.length || restored.outputs.length !== outputData.length) return false;
      const keyset = wallet.getKeyset(input.keysetId);
      const outputs = outputData.map((output) => {
        const signature = signatures.get(output.blindedMessage.B_);
        if (!signature || signature.id !== input.keysetId || signature.amount.toString() !== output.blindedMessage.amount.toString()) throw new Error("CASHU_RESTORE_OUTPUT_BINDING_INVALID");
        return output.toProof(signature, keyset);
      });
      this.assertOwnedOutputs(outputs, input, loaded.journal.expectedOutputAmount);
      await input.custody.recordOwnedOutputs(outputs);
      return true;
    } catch { return false; }
    finally { loaded.outputData.fill(0); }
  }
  private assertOwnedOutputs(outputs: readonly unknown[], input: CashuWalletOperationInput, expectedAmount = input.amount): void {
    if (outputs.length === 0) throw new Error("CASHU_OUTPUT_OWNERSHIP_INVALID");
    let amount = 0n; const seen = new Set<string>();
    for (const raw of outputs) {
      if (!raw || typeof raw !== "object") throw new Error("CASHU_OUTPUT_OWNERSHIP_INVALID");
      const output = raw as { id?: unknown; amount?: unknown; secret?: unknown; C?: unknown; dleq?: unknown };
      if (output.id !== input.keysetId || typeof output.secret !== "string" || typeof output.C !== "string" || !output.secret || !output.C) throw new Error("CASHU_OUTPUT_OWNERSHIP_INVALID");
      if (input.mint.requireDleq && (!output.dleq || typeof output.dleq !== "object")) throw new Error("CASHU_OUTPUT_DLEQ_REQUIRED");
      const individual = BigInt(String(output.amount)); if (individual <= 0n) throw new Error("CASHU_OUTPUT_OWNERSHIP_INVALID");
      const identity = `${output.id}:${output.secret}`; if (seen.has(identity)) throw new Error("CASHU_OUTPUT_DUPLICATE"); seen.add(identity); amount += individual;
    }
    if (amount !== BigInt(expectedAmount)) throw new Error("CASHU_OUTPUT_AMOUNT_MISMATCH");
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
  readonly productionSafe: boolean;
  readonly #operations: CashuWalletOperations;
  readonly #now: () => string;
  constructor(options: Readonly<{ operations?: CashuWalletOperations; request?: RequestFn; now?: () => string }> = {}) {
    this.#operations = options.operations ?? new CashuTsWalletOperations(options.request);
    this.productionSafe = options.operations === undefined;
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  async identify(request: Omit<CashuSettlementRequest, "topUpId" | "commitment" | "signal">): Promise<CashuProofIdentity> {
    try {
      if (request.token.byteLength === 0 || request.token.byteLength > 8_192) return failed("malformed");
      const decoded = getDecodedToken(new TextDecoder().decode(request.token), request.policy.mints.flatMap(({ keysetIds }) => keysetIds));
      const mint = mintPolicy(request.policy, decoded.mint);
      if (!mint) return failed("untrusted_mint");
      if (decoded.unit !== "sat") return failed("wrong_unit");
      const proofIds = new Set<string>(); const proofSecrets = new Set<string>(); let total = 0n;
      for (const proof of decoded.proofs) {
        if (!mint.keysetIds.includes(proof.id)) return failed("inactive_keyset");
        if (proof.witness !== undefined || !mint.proofConditions.includes("none")) return failed("unsupported_condition");
        if (proofSecrets.has(proof.secret)) return failed("duplicate_proof");
        proofSecrets.add(proof.secret); proofIds.add(proof.id); total += BigInt(proof.amount.toString());
      }
      if (proofIds.size !== 1 || total !== BigInt(request.amount)) return failed("wrong_amount");
      return { status: "accepted", semanticProofIdentities: await canonicalCashuProofIdentities(request.token, mint.keysetIds) };
    } catch (error) { return failed(codeOf(error)); }
  }
  async settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation> {
    try {
      request.signal.throwIfAborted();
      const identified = await this.identify(request);
      if (identified.status === "failed") return identified;
      const decoded = getDecodedToken(new TextDecoder().decode(request.token), request.policy.mints.flatMap(({ keysetIds }) => keysetIds));
      const mint = mintPolicy(request.policy, decoded.mint);
      if (!mint) return failed("untrusted_mint");
      const keysetIds = new Set(decoded.proofs.map((proof) => proof.id));
      if (keysetIds.size !== 1) return failed("wrong_amount");
      await this.#operations.settle({ topUpId: request.topUpId, decoded, mint, keysetId: [...keysetIds][0]!, amount: request.amount, custody: request.custody, signal: request.signal });
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
      const operation = { topUpId: request.topUpId, decoded, mint, keysetId: [...keysets][0]!, amount: request.amount, custody: request.custody, signal: request.signal };
      if (await this.#operations.recover?.(operation)) {
        return { status: "verified", externalReference: `cashu:${request.commitment}`, settlementReference: `cashu-swap:${request.topUpId}:${request.commitment}`, verifiedAt: this.#now() };
      }
      const state = await this.#operations.observe(operation);
      // Input SPENT proves only that the bearer is no longer available. It
      // does not prove that this service owns the swap outputs, so it can
      // never manufacture a credit during interrupted-swap reconciliation.
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
  readonly productionSafe = false;
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
  async identify(request: Omit<CashuSettlementRequest, "topUpId" | "commitment" | "signal">): Promise<CashuProofIdentity> { return { status: "accepted", semanticProofIdentities: [await sha256(request.token)] }; }
  async settle(request: CashuSettlementRequest): Promise<CashuSettlementObservation> {
    request.signal.throwIfAborted();
    const { signal: _, custody: _custody, ...recorded } = request;
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
