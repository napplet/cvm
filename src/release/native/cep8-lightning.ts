import { z } from "zod";
import type { LightningReceiptPort } from "../../funding/lightning-provider";
import { type BeginLightningTopUpInput, type LightningTopUpCoordinator, type LightningTopUpResult } from "../../funding/lightning-top-up";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const ReceiptSchema = z.object({ originalOperationId: z.string().min(1).max(256), requestSha256: DigestSchema }).strict();
const ConfigSchema = z.object({
  endpointReference: z.string().min(1).max(256), endpointSha256: DigestSchema,
  accountReference: z.string().min(1).max(256), accountSha256: DigestSchema,
}).strict();
const BeginIdentitySchema = z.object({ idempotencyKey: z.string().min(1).max(256) }).passthrough();

export type NativeCep8LightningConfig = Readonly<z.infer<typeof ConfigSchema>>;
export type NativeCep8PaymentReceipt = Readonly<z.infer<typeof ReceiptSchema>>;
export type NativeCep8LightningProvider = Readonly<{
  discovery(): NativeCep8LightningConfig;
  beginAfterReceipt(input: Readonly<{ receipt: NativeCep8PaymentReceipt; input: BeginLightningTopUpInput }>): Promise<LightningTopUpResult>;
  reconcileOriginal(input: Readonly<{ principal: BeginLightningTopUpInput["principal"]; topUpId: string }>): Promise<LightningTopUpResult>;
  verifiedSettlementCount(): number;
}>;

function freeze<T>(value: T): T { return Object.freeze(value); }

/**
 * CEP-8 BOLT11 composition only accepts references/hashes for its receiver
 * configuration. The injected coordinator remains the sole intent, receipt,
 * vault, and ledger authority; this wrapper never sees a preimage or invoice.
 */
class NativeCep8LightningProviderImpl implements NativeCep8LightningProvider {
  readonly #config: NativeCep8LightningConfig;
  readonly #coordinator: LightningTopUpCoordinator;
  readonly #inFlight = new Map<string, Promise<LightningTopUpResult>>();
  readonly #topUpOperations = new Map<string, string>();
  readonly #credited = new Set<string>();

  constructor(input: Readonly<{ config: unknown; receiver: LightningReceiptPort; coordinator: LightningTopUpCoordinator }>) {
    this.#config = freeze(ConfigSchema.parse(input.config));
    // Requiring the observer as a separate seam prevents a native constructor
    // from substituting an unreviewed HTTP client for the vetted coordinator.
    if (!input.receiver || typeof input.receiver.createInvoice !== "function" || typeof input.receiver.queryInvoice !== "function") throw new Error("LIGHTNING_RECEIPT_PORT_REQUIRED");
    this.#coordinator = input.coordinator;
  }

  discovery(): NativeCep8LightningConfig { return this.#config; }

  async beginAfterReceipt(input: Readonly<{ receipt: NativeCep8PaymentReceipt; input: BeginLightningTopUpInput }>): Promise<LightningTopUpResult> {
    const receipt = ReceiptSchema.parse(input.receipt);
    const command = BeginIdentitySchema.parse(input.input);
    if (receipt.originalOperationId !== command.idempotencyKey) throw new Error("LIGHTNING_RECEIPT_MISMATCH");
    const prior = this.#inFlight.get(receipt.originalOperationId);
    if (prior) return prior;
    const operation = this.#coordinator.begin(input.input).then((result) => {
      this.#topUpOperations.set(result.topUpId, receipt.originalOperationId);
      if (result.status === "credited") this.#credited.add(receipt.originalOperationId);
      return result;
    });
    this.#inFlight.set(receipt.originalOperationId, operation);
    try { return await operation; } finally { this.#inFlight.delete(receipt.originalOperationId); }
  }

  async reconcileOriginal(input: Readonly<{ principal: BeginLightningTopUpInput["principal"]; topUpId: string }>): Promise<LightningTopUpResult> {
    const result = await this.#coordinator.reconcile(input);
    const operationId = this.#topUpOperations.get(input.topUpId);
    if (result.status === "credited" && operationId) this.#credited.add(operationId);
    return result;
  }

  verifiedSettlementCount(): number { return this.#credited.size; }
}

export function createNativeCep8LightningProvider(input: Readonly<{ config: unknown; receiver: LightningReceiptPort; coordinator: LightningTopUpCoordinator }>): NativeCep8LightningProvider {
  return new NativeCep8LightningProviderImpl(input);
}
