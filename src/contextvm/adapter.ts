import { z } from "zod";
import { FundingService } from "../funding/funding-service";
import { PrincipalSchema } from "../phase-03/contracts";
import type { ContextVmInboundEnvelope, ContextVmTransportPort, ContextVmWireNotification, ContextVmWireResponse } from "./sdk-bridge";

const SupportedPmiSchema = z.enum(["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"]);
const InteractionModeSchema = z.enum(["transparent", "explicit_gating"]);
const EventSchema = z.object({
  id: z.string().min(1),
  tags: z.array(z.array(z.string())),
}).strict();
const RequestSchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.literal("tools/call"),
  params: z.object({
    name: z.enum(["account_status", "top_up", "funded_admission"]),
    arguments: z.unknown(),
    _meta: z.unknown().optional(),
  }).strict(),
}).strict();
const EnvelopeSchema = z.object({
  verifiedClientPubkey: PrincipalSchema.shape.pubkey,
  requestEventId: z.string().min(1),
  rawEvent: EventSchema,
  request: RequestSchema,
}).strict();

const AccountStatusArgumentsSchema = z.object({}).strict();
const TopUpArgumentsSchema = z.object({
  idempotencyKey: z.string().min(1),
  pmi: SupportedPmiSchema,
  mode: InteractionModeSchema,
}).strict();
const FundedAdmissionArgumentsSchema = z.object({
  idempotencyKey: z.string().min(1),
  requestedCap: z.string().regex(/^[1-9][0-9]*$/u),
  unit: z.literal("sat"),
  capacity: z.object({ reference: z.string().min(1), usable: z.boolean() }).strict(),
}).strict();

export interface ProtectedMaterialPort {
  protect(input: Readonly<{ pmi: "bitcoin-cashu-v4-direct"; payload: string }>): Promise<Readonly<{ reference: string }>>;
}

export interface ContextVmFundingAdapterOptions {
  service: FundingService;
  transport: ContextVmTransportPort;
  protectedMaterial?: ProtectedMaterialPort;
  policyVersion?: string;
  protocolVersion?: string;
}

type PaymentTags = Readonly<{
  clientPmis: readonly z.infer<typeof SupportedPmiSchema>[];
  mode: z.infer<typeof InteractionModeSchema>;
  directPayment?: Readonly<{ pmi: "bitcoin-cashu-v4-direct"; payload: string }>;
}>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Thin transport edge: signed ContextVM facts enter here, are reduced to a
 * normalized principal and project-owned commands, and then leave no ContextVM
 * DTO, event, bearer material, signer, or SDK replay state in the funding core.
 */
export class ContextVmFundingAdapter {
  private readonly policyVersion: string;
  private readonly protocolVersion: string;

  constructor(private readonly options: ContextVmFundingAdapterOptions) {
    this.policyVersion = options.policyVersion ?? "funding-policy-v1";
    this.protocolVersion = options.protocolVersion ?? "funding-contract-v1";
    options.transport.onInbound((input) => this.handle(input));
  }

  async handle(input: unknown): Promise<void> {
    const correlation = this.safeCorrelation(input);
    const responseId = this.safeResponseId(input);
    try {
      const envelope = EnvelopeSchema.parse(input);
      if (envelope.rawEvent.id !== envelope.requestEventId) throw new Error("CONTEXTVM_CORRELATION_MISMATCH");
      const principal = PrincipalSchema.parse({ pubkey: envelope.verifiedClientPubkey });
      const request = envelope.request;
      const response = await this.dispatch(principal.pubkey, envelope.requestEventId, envelope.rawEvent, request);
      await this.options.transport.sendResponse(principal.pubkey, response, envelope.requestEventId);
    } catch {
      if (!correlation) return;
      await this.options.transport.sendResponse(correlation.clientPubkey, freeze({
        jsonrpc: "2.0" as const,
        id: responseId,
        error: { code: -32602, message: "invalid ContextVM funding request" },
      }), correlation.requestEventId);
    }
  }

  private async dispatch(verifiedPubkey: string, requestEventId: string, rawEvent: z.infer<typeof EventSchema>, request: z.infer<typeof RequestSchema>): Promise<ContextVmWireResponse> {
    const { name, arguments: argumentsInput } = request.params;
    if (name === "account_status") {
      AccountStatusArgumentsSchema.parse(argumentsInput);
      const status = await this.options.service.status({ pubkey: verifiedPubkey });
      const notification = freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/account_status", params: status });
      await this.options.transport.sendNotification(verifiedPubkey, notification, requestEventId);
      return freeze({ jsonrpc: "2.0" as const, id: request.id, result: status });
    }
    if (name === "funded_admission") {
      const args = FundedAdmissionArgumentsSchema.parse(argumentsInput);
      const result = await this.options.service.execute({
        principal: { pubkey: verifiedPubkey }, kind: "funded_admission", idempotencyKey: args.idempotencyKey,
        policyVersion: this.policyVersion, protocolVersion: this.protocolVersion,
        payload: { requestedCap: args.requestedCap, unit: args.unit, capacity: args.capacity },
      });
      const wireResult = freeze({ ...result, payment: { generationPriceWaivedForAdmission: true } });
      await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({
        jsonrpc: "2.0", method: "notifications/funded_admission", params: wireResult,
      }), requestEventId);
      return freeze({ jsonrpc: "2.0" as const, id: request.id, result: wireResult });
    }

    const args = TopUpArgumentsSchema.parse(argumentsInput);
    const tags = this.paymentTags(rawEvent, args.pmi);
    if (!tags.clientPmis.includes(args.pmi) || tags.mode !== args.mode) throw new Error("CEP8_NEGOTIATION_DENIED");
    if (args.pmi === "bitcoin-cashu-v4-direct") {
      if (!tags.directPayment || !this.options.protectedMaterial) throw new Error("CASHU_DIRECT_PAYMENT_DENIED");
      z.object({ reference: z.string().min(1) }).strict().parse(await this.options.protectedMaterial.protect(tags.directPayment));
    } else if (tags.directPayment) {
      throw new Error("LIGHTNING_DIRECT_PAYMENT_DENIED");
    }
    const canonical = this.options.transport.canonicalInvocation(verifiedPubkey, request.method, request.params);
    const result = freeze({
      status: "top_up_pending",
      pmi: args.pmi,
      paymentInteraction: args.mode,
      explicitGatingIdentity: args.mode === "explicit_gating" ? canonical.invocationHash : undefined,
    });
    await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({
      jsonrpc: "2.0", method: "notifications/top_up_pending", params: result,
    }), requestEventId);
    return freeze({
      jsonrpc: "2.0" as const,
      id: request.id,
      result,
    });
  }

  private paymentTags(event: z.infer<typeof EventSchema>, pmi: z.infer<typeof SupportedPmiSchema>): PaymentTags {
    const pmiTags: z.infer<typeof SupportedPmiSchema>[] = [];
    let mode: z.infer<typeof InteractionModeSchema> = "transparent";
    let seenMode = false;
    let directPayment: PaymentTags["directPayment"];
    for (const tag of event.tags) {
      if (tag[0] === "pmi") {
        if (tag.length !== 2) throw new Error("INVALID_PMI_TAG");
        pmiTags.push(SupportedPmiSchema.parse(tag[1]));
      } else if (tag[0] === "payment_interaction") {
        if (tag.length !== 2 || seenMode) throw new Error("INVALID_PAYMENT_INTERACTION_TAG");
        mode = InteractionModeSchema.parse(tag[1]); seenMode = true;
      } else if (tag[0] === "direct_payment") {
        if (tag.length !== 3 || directPayment) throw new Error("INVALID_DIRECT_PAYMENT_TAG");
        if (tag[1] !== "bitcoin-cashu-v4-direct" || tag[1] !== pmi || tag[2].length === 0) throw new Error("UNSUPPORTED_DIRECT_PAYMENT_TAG");
        directPayment = { pmi: "bitcoin-cashu-v4-direct", payload: tag[2] };
      }
    }
    if (new Set(pmiTags).size !== pmiTags.length) throw new Error("DUPLICATE_PMI_TAG");
    return freeze({ clientPmis: pmiTags, mode, directPayment });
  }

  private safeCorrelation(input: unknown): Readonly<{ clientPubkey: string; requestEventId: string }> | undefined {
    const candidate = z.object({ verifiedClientPubkey: z.string().min(1), requestEventId: z.string().min(1) }).passthrough().safeParse(input);
    return candidate.success ? { clientPubkey: candidate.data.verifiedClientPubkey, requestEventId: candidate.data.requestEventId } : undefined;
  }

  private safeResponseId(input: unknown): string | number | null {
    const candidate = z.object({ request: z.object({ id: z.union([z.string(), z.number(), z.null()]) }).passthrough() }).passthrough().safeParse(input);
    return candidate.success ? candidate.data.request.id : null;
  }
}
