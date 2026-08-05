import { z } from "zod";
import { FundingService } from "../funding/funding-service";
import type { AccountStatusService } from "../funding/account-status";
import type { FundedAdmissionService } from "../funding/funded-admission";
import { accountIdForPrincipal } from "../domain/account-command";
import { ResumeSessionCommandSchema, ResumeSessionResultSchema } from "../continuity/contracts";
import { PrincipalSchema } from "../phase-03/contracts";
import { SessionActionResultSchema } from "../phase-04/metered-generation-service";
import { SessionStatusQuerySchema, SessionStatusSchema } from "../phase-04/session-status";
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
    name: z.enum(["account_status", "top_up", "funded_admission", "start_session", "revise_session", "resume_session", "session_status"]),
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
  amount: z.string().regex(/^[1-9][0-9]*$/u).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
  topUpId: z.string().min(1).optional(),
}).strict();
const FundedAdmissionArgumentsSchema = z.object({
  idempotencyKey: z.string().min(1),
  requestedCap: z.string().regex(/^[1-9][0-9]*$/u),
  unit: z.literal("sat"),
}).strict();
const StartSessionArgumentsSchema = z.object({
  admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), maximum: z.string().regex(/^[1-9][0-9]*$/u), idea: z.string().min(1).max(4_000),
}).strict();
const ReviseSessionArgumentsSchema = z.object({
  sessionId: z.string().min(1), admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), expectedVersion: z.number().int().nonnegative(), maximum: z.string().regex(/^[1-9][0-9]*$/u), revision: z.string().min(1).max(4_000),
}).strict();
const ResumeSessionArgumentsSchema = ResumeSessionCommandSchema.omit({ principal: true });
const SessionStatusArgumentsSchema = z.object({
  sessionId: z.string().min(1), billing: z.object({ limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).optional() }).strict().optional(),
}).strict();
const RailTopUpResultSchema = z.object({
  topUpId: z.string().min(1),
  state: z.enum(["pending", "settled", "credited", "failed", "reconciliation_pending", "verifying"]),
  status: z.enum(["payment_required", "reconciliation_pending", "failed", "credited"]).optional(),
  rail: z.enum(["lightning", "cashu"]).optional(),
  amount: z.string().regex(/^[1-9][0-9]*$/u).optional(),
  unit: z.literal("sat").optional(),
  safeDisplayReference: z.string().min(1).optional(),
  expiresAt: z.iso.datetime().optional(),
  settlementReference: z.string().min(1).optional(),
}).passthrough();

export interface ProtectedMaterialPort {
  protect(input: Readonly<{ pmi: "bitcoin-cashu-v4-direct"; payload: string }>): Promise<Readonly<{ reference: string }>>;
}

export interface ContextVmFundingAdapterOptions {
  service: FundingService;
  transport: ContextVmTransportPort;
  /** Server-owned facades. Their absence makes their public tool unavailable. */
  admissions?: FundedAdmissionService;
  accountStatus?: AccountStatusService;
  topUps?: Readonly<{
    lightning: Readonly<{ begin(input: unknown): Promise<unknown> }>;
    cashu: Readonly<{ submit(input: unknown): Promise<unknown> }>;
  }>;
  /** Narrow transport-neutral generation facades; repair is deliberately absent. */
  generation?: Readonly<{
    startSession(input: unknown): Promise<unknown>;
    reviseSession(input: unknown): Promise<unknown>;
  }>;
  /** Explicit post-grace continuation only; rails and status cannot call this facade. */
  continuation?: Readonly<{ resumeSession(input: unknown): Promise<unknown> }>;
  sessionStatus?: Readonly<{ read(input: unknown): Promise<unknown> }>;
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
    if (name === "start_session") {
      const args = StartSessionArgumentsSchema.parse(argumentsInput);
      if (!this.options.generation) throw new Error("METERED_GENERATION_UNAVAILABLE");
      const result = SessionActionResultSchema.parse(await this.options.generation.startSession({ principal: { pubkey: verifiedPubkey }, admissionReference: args.admissionReference, idempotencyKey: args.idempotencyKey, expectedVersion: 0, maximum: args.maximum, policyVersion: this.policyVersion, idea: args.idea }));
      return this.generationResponse("start_session", verifiedPubkey, requestEventId, request.id, result);
    }
    if (name === "revise_session") {
      const args = ReviseSessionArgumentsSchema.parse(argumentsInput);
      if (!this.options.generation) throw new Error("METERED_GENERATION_UNAVAILABLE");
      const result = SessionActionResultSchema.parse(await this.options.generation.reviseSession({ principal: { pubkey: verifiedPubkey }, sessionId: args.sessionId, admissionReference: args.admissionReference, idempotencyKey: args.idempotencyKey, expectedVersion: args.expectedVersion, maximum: args.maximum, policyVersion: this.policyVersion, revision: args.revision }));
      return this.generationResponse("revise_session", verifiedPubkey, requestEventId, request.id, result);
    }
    if (name === "resume_session") {
      const args = ResumeSessionArgumentsSchema.parse(argumentsInput);
      if (!this.options.continuation) throw new Error("CONTINUATION_UNAVAILABLE");
      const accountId = await accountIdForPrincipal({ pubkey: verifiedPubkey });
      const result = ResumeSessionResultSchema.parse(await this.options.continuation.resumeSession({ ...args, principal: { id: accountId } }));
      return this.resumeResponse(verifiedPubkey, requestEventId, request.id, result);
    }
    if (name === "session_status") {
      const args = SessionStatusArgumentsSchema.parse(argumentsInput);
      if (!this.options.sessionStatus) throw new Error("SESSION_STATUS_UNAVAILABLE");
      const query = SessionStatusQuerySchema.parse({ principal: { pubkey: verifiedPubkey }, sessionId: args.sessionId, ...(args.billing ? { billing: args.billing } : {}) });
      const result = SessionStatusSchema.parse(await this.options.sessionStatus.read(query));
      await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/session_status", params: result }), requestEventId);
      return freeze({ jsonrpc: "2.0" as const, id: request.id, result });
    }
    if (name === "account_status") {
      AccountStatusArgumentsSchema.parse(argumentsInput);
      const status = this.options.accountStatus
        ? await this.options.accountStatus.status({ pubkey: verifiedPubkey })
        : await this.options.service.status({ pubkey: verifiedPubkey });
      const notification = freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/account_status", params: status });
      await this.options.transport.sendNotification(verifiedPubkey, notification, requestEventId);
      return freeze({ jsonrpc: "2.0" as const, id: request.id, result: status });
    }
    if (name === "funded_admission") {
      const args = FundedAdmissionArgumentsSchema.parse(argumentsInput);
      if (!this.options.admissions) throw new Error("FUNDED_ADMISSION_UNAVAILABLE");
      const result = await this.options.admissions.admit({
        principal: { pubkey: verifiedPubkey }, idempotencyKey: args.idempotencyKey,
        policyVersion: this.policyVersion, protocolVersion: this.protocolVersion,
        payload: { requestedCap: args.requestedCap, unit: args.unit },
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
      if (!tags.directPayment || !this.options.topUps) throw new Error("CASHU_DIRECT_PAYMENT_DENIED");
    } else if (tags.directPayment) {
      throw new Error("LIGHTNING_DIRECT_PAYMENT_DENIED");
    }
    const canonical = this.options.transport.canonicalInvocation(verifiedPubkey, request.method, request.params);
    const result = args.pmi === "bitcoin-lightning-bolt11"
      ? await this.options.topUps?.lightning.begin({ principal: { pubkey: verifiedPubkey }, idempotencyKey: args.idempotencyKey, amount: args.amount, unit: "sat", policyVersion: this.policyVersion, protocolVersion: this.protocolVersion })
      : await this.options.topUps?.cashu.submit({ principal: { pubkey: verifiedPubkey }, idempotencyKey: args.idempotencyKey, topUpId: args.topUpId ?? `cashu:${canonical.invocationHash}`, amount: args.amount, unit: "sat", pmi: args.pmi, token: new TextEncoder().encode(tags.directPayment!.payload) });
    if (!result) throw new Error("TOP_UP_UNAVAILABLE");
    const railResult = RailTopUpResultSchema.parse(result);
    // This is an explicit response allowlist: coordinator/provider additions do
    // not become ContextVM wire fields by accident (bearers, proofs, invoices,
    // tokens, and protected material references are never serialized here).
    const wireResult = freeze({ topUpId: railResult.topUpId, state: railResult.state,
      ...(railResult.status ? { status: railResult.status } : {}), ...(railResult.rail ? { rail: railResult.rail } : {}),
      ...(railResult.amount ? { amount: railResult.amount } : {}), ...(railResult.unit ? { unit: railResult.unit } : {}),
      ...(railResult.safeDisplayReference ? { safeDisplayReference: railResult.safeDisplayReference } : {}),
      ...(railResult.expiresAt ? { expiresAt: railResult.expiresAt } : {}), ...(railResult.settlementReference ? { settlementReference: railResult.settlementReference } : {}),
      paymentInteraction: args.mode, ...(args.mode === "explicit_gating" ? { explicitGatingIdentity: canonical.invocationHash } : {}) });
    await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({
      jsonrpc: "2.0", method: "notifications/top_up", params: wireResult,
    }), requestEventId);
    return freeze({
      jsonrpc: "2.0" as const,
      id: request.id,
      result: wireResult,
    });
  }

  private async generationResponse(name: "start_session" | "revise_session", verifiedPubkey: string, requestEventId: string, id: string | number | null, result: z.infer<typeof SessionActionResultSchema>): Promise<ContextVmWireResponse> {
    const wireResult = result.status === "completed" || result.status === "failed"
      ? freeze({ status: result.status, code: result.code, sessionId: result.sessionId, sessionVersion: result.sessionVersion, artifactVersion: result.artifactVersion, confirmedSpend: result.confirmedSpend, remainingCap: result.remainingCap, remainingBalance: result.remainingBalance, nextAction: result.nextAction, operationId: result.operationId })
      : result.status === "billing_invariant_failed" || result.status === "usage_unknown"
        ? freeze({ status: result.status, code: result.code, sessionId: result.sessionId, nextAction: result.nextAction, operationId: result.operationId })
        : freeze({ status: result.status, code: result.code });
    await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: `notifications/${name}`, params: wireResult }), requestEventId);
    return freeze({ jsonrpc: "2.0" as const, id, result: wireResult });
  }

  private async resumeResponse(verifiedPubkey: string, requestEventId: string, id: string | number | null, result: z.infer<typeof ResumeSessionResultSchema>): Promise<ContextVmWireResponse> {
    const wireResult = result.status === "restored"
      ? freeze({ status: result.status, code: result.code, sessionId: result.sessionId, checkpointId: result.checkpointId, pendingActionReference: result.pendingActionReference, actionBudgetReference: result.actionBudgetReference, allocationIntentReference: result.allocationIntentReference })
      : result.status === "reconciliation_pending"
        ? freeze({ status: result.status, code: result.code, sessionId: result.sessionId, checkpointId: result.checkpointId, pendingActionReference: result.pendingActionReference, allocationIntentReference: result.allocationIntentReference })
        : freeze({ status: result.status, code: result.code });
    await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/resume_session", params: wireResult }), requestEventId);
    return freeze({ jsonrpc: "2.0" as const, id, result: wireResult });
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
