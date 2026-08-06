import { z } from "zod";
import { ContextVmFundingAdapter, type ContextVmFundingAdapterOptions } from "../../contextvm/adapter";
import type { ContextVmInboundEnvelope, ContextVmTransportPort } from "../../contextvm/sdk-bridge";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const PubkeySchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const ContextVmNativeConfigSchema = z.object({
  relaySetReference: z.string().min(1).max(256),
  relaySetSha256: DigestSchema,
  serverPubkey: PubkeySchema,
  protocolVersion: z.string().min(1).max(128),
  sdkPackageVersion: z.string().regex(/^0\.13\.[0-9]+$/u),
  reconnectPolicy: z.literal("reconcile_original_event"),
}).strict();
const InvocationReceiptSchema = z.object({
  originalEventId: z.string().min(1).max(256),
  invocationSha256: DigestSchema,
}).strict();
const InboundEnvelopeSchema = z.object({
  verifiedClientPubkey: PubkeySchema,
  requestEventId: z.string().min(1).max(256),
  rawEvent: z.object({ id: z.string().min(1).max(256), tags: z.array(z.array(z.string())) }).strict(),
  request: z.object({ id: z.union([z.string(), z.number(), z.null()]), method: z.string().min(1), params: z.unknown() }).strict(),
}).strict();

export type NativeContextVmConfig = Readonly<z.infer<typeof ContextVmNativeConfigSchema>>;
export type NativeContextVmInvocationReceipt = Readonly<z.infer<typeof InvocationReceiptSchema>>;
export type NativeContextVmProvider = Readonly<{
  discovery(): NativeContextVmConfig;
  invokeAfterReceipt(input: Readonly<{ receipt: NativeContextVmInvocationReceipt; invocation: ContextVmInboundEnvelope }>): Promise<Readonly<{ originalEventId: string; replayed: boolean }>>;
}>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The production composition has only reference/hash relay configuration and a
 * public server key.  The injected ContextVmSdkBridge remains responsible for
 * signed-event verification; this wrapper binds every dispatch to the exact
 * original event and canonical invocation identity before the core is called.
 */
class NativeContextVmProviderImpl implements NativeContextVmProvider {
  readonly #config: NativeContextVmConfig;
  readonly #transport: ContextVmTransportPort;
  readonly #adapter: ContextVmFundingAdapter;
  readonly #completed = new Set<string>();
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(input: Readonly<{ config: unknown; transport: ContextVmTransportPort; adapterOptions: Omit<ContextVmFundingAdapterOptions, "transport"> }>) {
    this.#config = freeze(ContextVmNativeConfigSchema.parse(input.config));
    this.#transport = input.transport;
    // Adapter construction only registers the already-authenticated inbound
    // callback; it opens no relay connection and publishes nothing.
    this.#adapter = new ContextVmFundingAdapter({ ...input.adapterOptions, transport: input.transport });
  }

  discovery(): NativeContextVmConfig { return this.#config; }

  async invokeAfterReceipt(input: Readonly<{ receipt: NativeContextVmInvocationReceipt; invocation: ContextVmInboundEnvelope }>): Promise<Readonly<{ originalEventId: string; replayed: boolean }>> {
    const receipt = InvocationReceiptSchema.parse(input.receipt);
    const invocation = InboundEnvelopeSchema.parse(input.invocation);
    if (receipt.originalEventId !== invocation.requestEventId || invocation.rawEvent.id !== invocation.requestEventId) {
      throw new Error("CONTEXTVM_RECEIPT_MISMATCH");
    }
    const canonical = this.#transport.canonicalInvocation(invocation.verifiedClientPubkey, invocation.request.method, invocation.request.params);
    if (canonical.clientPubkey !== invocation.verifiedClientPubkey || canonical.invocationHash !== receipt.invocationSha256) {
      throw new Error("CONTEXTVM_RECEIPT_MISMATCH");
    }

    const existing = this.#inFlight.get(receipt.originalEventId);
    if (existing) {
      await existing;
      return freeze({ originalEventId: receipt.originalEventId, replayed: true });
    }
    if (this.#completed.has(receipt.originalEventId)) return freeze({ originalEventId: receipt.originalEventId, replayed: true });

    const dispatch = this.#adapter.handle(invocation).then(() => { this.#completed.add(receipt.originalEventId); }).finally(() => { this.#inFlight.delete(receipt.originalEventId); });
    this.#inFlight.set(receipt.originalEventId, dispatch);
    await dispatch;
    return freeze({ originalEventId: receipt.originalEventId, replayed: false });
  }
}

/**
 * Composes a real ContextVM transport/SDK bridge with the transport-neutral
 * funding adapter. SDK, relay, and server credentials are injected by the
 * protected runtime; this construction path stores no user private-key bytes.
 */
export function createNativeContextVmProvider(input: Readonly<{ config: unknown; transport: ContextVmTransportPort; adapterOptions: Omit<ContextVmFundingAdapterOptions, "transport"> }>): NativeContextVmProvider {
  return new NativeContextVmProviderImpl(input);
}
