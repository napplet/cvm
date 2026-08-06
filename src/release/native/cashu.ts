import { z } from "zod";
import type { CashuSettlementPort, CashuWalletOperations } from "../../funding/cashu-provider";
import { type CashuTopUpCoordinator, type CashuTopUpResult } from "../../funding/cashu-top-up";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const ReceiptSchema = z.object({ originalOperationId: z.string().min(1).max(256), requestSha256: DigestSchema }).strict();
const ConfigSchema = z.object({
  mintPolicyReference: z.string().min(1).max(256), mintPolicySha256: DigestSchema,
  accountReference: z.string().min(1).max(256), accountSha256: DigestSchema,
}).strict();
const SubmitIdentitySchema = z.object({ topUpId: z.string().min(1).max(256) }).passthrough();

export type NativeCashuConfig = Readonly<z.infer<typeof ConfigSchema>>;
export type NativeCashuPaymentReceipt = Readonly<z.infer<typeof ReceiptSchema>>;
export type NativeCashuProvider = Readonly<{
  discovery(): NativeCashuConfig;
  submitAfterReceipt(input: Readonly<{ receipt: NativeCashuPaymentReceipt; input: unknown }>): Promise<CashuTopUpResult>;
  reconcileOriginal(topUpId: string): Promise<CashuTopUpResult>;
  verifiedSettlementCount(): number;
}>;

function freeze<T>(value: T): T { return Object.freeze(value); }

/** Cashu composition keeps token/proof bytes inside the existing vault and
 * coordinator. Native configuration names only approved mint/account refs. */
class NativeCashuProviderImpl implements NativeCashuProvider {
  readonly #config: NativeCashuConfig;
  readonly #coordinator: CashuTopUpCoordinator;
  readonly #inFlight = new Map<string, Promise<CashuTopUpResult>>();
  readonly #credited = new Set<string>();

  constructor(input: Readonly<{ config: unknown; settlement: CashuSettlementPort; walletOperations: CashuWalletOperations; coordinator: CashuTopUpCoordinator }>) {
    this.#config = freeze(ConfigSchema.parse(input.config));
    if (!input.settlement || typeof input.settlement.settle !== "function" || typeof input.settlement.observe !== "function") throw new Error("CASHU_SETTLEMENT_PORT_REQUIRED");
    if (!input.walletOperations || typeof input.walletOperations.settle !== "function" || typeof input.walletOperations.observe !== "function") throw new Error("CASHU_WALLET_OPERATIONS_REQUIRED");
    this.#coordinator = input.coordinator;
  }

  discovery(): NativeCashuConfig { return this.#config; }

  async submitAfterReceipt(input: Readonly<{ receipt: NativeCashuPaymentReceipt; input: unknown }>): Promise<CashuTopUpResult> {
    const receipt = ReceiptSchema.parse(input.receipt);
    const command = SubmitIdentitySchema.parse(input.input);
    if (receipt.originalOperationId !== command.topUpId) throw new Error("CASHU_RECEIPT_MISMATCH");
    const prior = this.#inFlight.get(receipt.originalOperationId);
    if (prior) return prior;
    const operation = this.#coordinator.submit(input.input).then((result) => {
      if (result.state === "credited") this.#credited.add(receipt.originalOperationId);
      return result;
    });
    this.#inFlight.set(receipt.originalOperationId, operation);
    try { return await operation; } finally { this.#inFlight.delete(receipt.originalOperationId); }
  }

  async reconcileOriginal(topUpId: string): Promise<CashuTopUpResult> {
    const result = await this.#coordinator.reconcile(topUpId);
    if (result.state === "credited") this.#credited.add(topUpId);
    return result;
  }

  verifiedSettlementCount(): number { return this.#credited.size; }
}

export function createNativeCashuProvider(input: Readonly<{ config: unknown; settlement: CashuSettlementPort; walletOperations: CashuWalletOperations; coordinator: CashuTopUpCoordinator }>): NativeCashuProvider {
  return new NativeCashuProviderImpl(input);
}
