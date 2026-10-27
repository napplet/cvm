import { RemixReferenceSchema } from "../remix/reference";
import { z } from "zod";
import { FundingService } from "../funding/funding-service";
import type { AccountStatusService } from "../funding/account-status";
import type { FundedAdmissionService } from "../funding/funded-admission";
import type { AdmissionReceiptAuthority } from "../funding/admission-receipt";
import { accountIdForPrincipal } from "../domain/account-command";
import { ResumeSessionCommandSchema, ResumeSessionResultSchema } from "../continuity/contracts";
import { PrincipalSchema } from "../phase-03/contracts";
import { SessionActionResultSchema } from "../phase-04/metered-generation-service";
import { SessionStatusQuerySchema, SessionStatusSchema } from "../phase-04/session-status";
import { CapabilityReviewSchema, PreviewDescriptorSchema, SignedOwnerManifestEventSchema, SignedPublicationCommandSchema } from "../publication/contracts";
import { validatedAvailablePromotedCliSourceContract, type AvailablePromotedCliSourceContract } from "../publication/napplet-cli-source-contract";
import { AdmissionLifecycleContextSchema, protectedLifecycleCorrelation, type AdmissionLifecycleContext } from "../telemetry/contracts";
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
    name: z.enum(["account_status", "top_up", "funded_admission", "start_session", "revise_session", "resume_session", "session_status", "preview", "publication", "service_info", "development_faucet", "development_publication", "cvm_admin", "operation_diagnostic", "projects", "remix_import"]),
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

export const AccountStatusArgumentsSchema = z.object({}).strict();
export const TopUpArgumentsSchema = z.object({
  idempotencyKey: z.string().min(1),
  pmi: SupportedPmiSchema,
  mode: InteractionModeSchema,
  amount: z.string().regex(/^[1-9][0-9]*$/u).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
  maxFee: z.string().regex(/^[0-9]+$/u).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)).optional(),
  topUpId: z.string().min(1).optional(),
}).strict();
export const FundedAdmissionArgumentsSchema = z.object({
  idempotencyKey: z.string().min(1),
  requestedCap: z.string().regex(/^[1-9][0-9]*$/u),
  unit: z.literal("sat"),
}).strict();
// SDK canonical invocations retain SDK-owned metadata; the adapter consumes
// only its validated hash and never re-serializes the SDK object.
const CanonicalInvocationSchema = z.object({ invocationHash: z.string().regex(/^[a-f0-9]{64}$/iu) }).passthrough();
const FundedAdmissionPortResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), accountId: z.string().min(1), reference: z.string().min(1), approvedCap: z.string().regex(/^[1-9][0-9]*$/u), heldAmount: z.string().regex(/^[1-9][0-9]*$/u), unit: z.literal("sat") }).strict(),
  z.object({ status: z.enum(["refused", "reconciliation_pending"]), accountId: z.string().min(1), intentReference: z.string().min(1), retryable: z.boolean(), unit: z.literal("sat") }).strict(),
]);
const FundedStartSessionArgumentsSchema = z.object({
  remixReference: RemixReferenceSchema.optional(),
  admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), maximum: z.string().regex(/^[1-9][0-9]*$/u), idea: z.string().min(1).max(4_000),
}).strict();
const PreAdmissionStartSessionArgumentsSchema = z.object({
  remixReference: RemixReferenceSchema.optional(),
  mode: z.literal("pre_admission"), idempotencyKey: z.string().min(1), maximum: z.string().regex(/^[1-9][0-9]*$/u), idea: z.string().min(1).max(4_000),
}).strict();
export const StartSessionArgumentsSchema = z.union([FundedStartSessionArgumentsSchema, PreAdmissionStartSessionArgumentsSchema]);
export const ReviseSessionArgumentsSchema = z.object({
  sessionId: z.string().min(1), admissionReference: z.string().min(1), idempotencyKey: z.string().min(1), expectedVersion: z.number().int().nonnegative(), maximum: z.string().regex(/^[1-9][0-9]*$/u), revision: z.string().min(1).max(4_000),
}).strict();
const LegacyResumeSessionArgumentsSchema = ResumeSessionCommandSchema.omit({ principal: true });
const PendingActionResumeArgumentsSchema = z.object({
  kind: z.literal("pending_action"), checkpointId: z.string().min(1), expectedCheckpointVersion: z.literal(1), expectedSessionVersion: z.literal(0),
  idempotencyKey: z.string().min(1), approvePendingAction: z.literal(true), admissionReference: z.string().min(1),
  pendingAction: z.object({ reference: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), kind: z.literal("start_session"), maximum: z.string().regex(/^[1-9][0-9]*$/u) }).strict(),
}).strict();
export const ResumeSessionArgumentsSchema = z.union([LegacyResumeSessionArgumentsSchema, PendingActionResumeArgumentsSchema]);
const MeteredSessionStatusArgumentsSchema = z.object({
  sessionId: z.string().min(1), billing: z.object({ limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).optional() }).strict().optional(),
}).strict();
const PendingActionStatusArgumentsSchema = z.object({ kind: z.literal("pending_action"), checkpointId: z.string().min(1) }).strict();
export const SessionStatusArgumentsSchema = z.union([MeteredSessionStatusArgumentsSchema, PendingActionStatusArgumentsSchema]);
const PendingActionStatusProjectionSchema = z.union([
  z.object({ status: z.literal("funded_admission_required"), maximum: z.string().regex(/^[1-9][0-9]*$/u) }).strict(),
  z.object({ status: z.literal("saved"), checkpointId: z.string().min(1), reference: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), maximum: z.string().regex(/^[1-9][0-9]*$/u), shortfall: z.string().regex(/^[0-9]+$/u), version: z.literal(1), expiresAtMs: z.number().int().positive(), nextAction: z.literal("funded_admission") }).strict(),
  z.object({ status: z.enum(["bound", "completed", "failed"]), checkpointId: z.string().min(1), reference: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), maximum: z.string().regex(/^[1-9][0-9]*$/u), version: z.literal(1), expiresAtMs: z.number().int().positive(), nextAction: z.enum(["wait_for_current_action", "revise_session", "retry_resume"]) }).strict(),
  z.object({ status: z.literal("not_found_or_denied") }).strict(),
]);
export const PreviewArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("descriptor"), sessionId: z.string().min(1), artifactId: z.string().min(1), runtimeVariant: z.string().min(1) }).strict(),
  z.object({ action: z.literal("review_capabilities"), sessionId: z.string().min(1), artifactId: z.string().min(1), runtimeVariant: z.string().min(1) }).strict(),
]);
export const PublicationArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_intent"), sessionId: z.string().min(1), artifactId: z.string().min(1), runtimeVariant: z.string().min(1), idempotencyKey: z.string().min(1), purpose: z.string().min(1).max(512), consent: z.literal("approved") }).strict(),
  z.object({ action: z.literal("submit_signed_manifest"), intentId: z.string().min(1), command: SignedPublicationCommandSchema, event: SignedOwnerManifestEventSchema }).strict(),
  z.object({ action: z.literal("status"), intentId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("reconcile"), intentId: z.string().min(1) }).strict(),
]);
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
  /** Explicit composition-owned tools. Each validates input and projects its result;
   * admin authority is checked against the verified envelope, never an argument. */
  extensions?: Partial<Record<"service_info" | "development_faucet" | "development_publication" | "cvm_admin" | "operation_diagnostic" | "projects" | "remix_import", (input: unknown, verifiedPubkey: string) => Promise<unknown>>>;
  service: FundingService;
  transport: ContextVmTransportPort;
  /** Server-owned facades. Their absence makes their public tool unavailable. */
  admissions?: FundedAdmissionService;
  /** Server-held issuer for receipt-before-capacity admission authority. */
  admissionReceipts?: AdmissionReceiptAuthority;
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
  /** Development-only pre-admission authority. Absent in the normal product composition. */
  preAdmission?: Readonly<{
    saveStart(input: unknown): Promise<unknown>;
    status(input: unknown): Promise<unknown>;
    resume(input: unknown): Promise<unknown>;
  }>;
  /** Explicit post-grace continuation only; rails and status cannot call this facade. */
  continuation?: Readonly<{ resumeSession(input: unknown): Promise<unknown> }>;
  sessionStatus?: Readonly<{ read(input: unknown): Promise<unknown> }>;
  /** Optional composition-owned HTTPS origin for remote opaque-grant previews. */
  publicPreviewOrigin?: string;
  /** Preview remains a read-only, owner-scoped facade and never gains publication authority. */
  preview?: Readonly<{
    previewVerifiedArtifact(input: unknown): Promise<unknown>;
    reviewCapabilities(input: unknown): Promise<unknown>;
  }>;
  /** Transport-neutral publication authority; the adapter only passes verified owner and correlation facts. */
  publication?: Readonly<{
    createIntent(input: unknown): Promise<unknown>;
    submitSignedManifest(input: unknown): Promise<unknown>;
    status(input: unknown): Promise<unknown>;
    reconcile(input: unknown): Promise<unknown>;
  }>;
  /** Result of the Plan 05 exact promoted-source probe. Absence always fails closed. */
  publicationSourceContract?: unknown;
  policyVersion?: string;
  protocolVersion?: string;
  /** Monotonic clock for the trusted receipt-to-ready admission measurement. */
  monotonicNow?: () => number;
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
  private readonly publicPreviewOrigin?: string;
  private readonly policyVersion: string;
  private readonly protocolVersion: string;
  private readonly publicationSourceContract?: AvailablePromotedCliSourceContract;

  constructor(private readonly options: ContextVmFundingAdapterOptions) {
    if (options.publicPreviewOrigin) {
      const origin = new URL(options.publicPreviewOrigin);
      if (origin.protocol !== "https:" || origin.origin !== options.publicPreviewOrigin) throw new Error("PUBLIC_PREVIEW_ORIGIN_INVALID");
      this.publicPreviewOrigin = origin.origin;
    }
    this.policyVersion = options.policyVersion ?? "funding-policy-v1";
    this.protocolVersion = options.protocolVersion ?? "funding-contract-v1";
    // Do not preserve a caller-supplied availability shape as a capability.
    // It must have passed the full Plan 05 source-contract validator before
    // construction and still pass again immediately before dispatch.
    this.publicationSourceContract = validatedAvailablePromotedCliSourceContract(options.publicationSourceContract);
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
    if (["service_info", "development_faucet", "development_publication", "cvm_admin", "operation_diagnostic", "projects", "remix_import"].includes(name)) {
      const handler = this.options.extensions?.[name as keyof NonNullable<ContextVmFundingAdapterOptions["extensions"]>];
      if (!handler) throw new Error("CONTEXTVM_TOOL_UNAVAILABLE");
      return freeze({ jsonrpc: "2.0" as const, id: request.id, result: await handler(argumentsInput, verifiedPubkey) });
    }
    if (name === "start_session") {
      const args = StartSessionArgumentsSchema.parse(argumentsInput);
      if ("mode" in args) {
        if (!this.options.preAdmission) throw new Error("PRE_ADMISSION_UNAVAILABLE");
        const accountId = await accountIdForPrincipal({ pubkey: verifiedPubkey });
        const result = PendingActionStatusProjectionSchema.parse(await this.options.preAdmission.saveStart({ owner: { ownerId: verifiedPubkey, accountId }, command: { idempotencyKey: args.idempotencyKey, maximum: args.maximum, idea: args.idea, ...(args.remixReference ? { remixReference: args.remixReference } : {}), policyVersion: this.policyVersion } }));
        return freeze({ jsonrpc: "2.0" as const, id: request.id, result });
      }
      if (!this.options.generation) throw new Error("METERED_GENERATION_UNAVAILABLE");
      const result = SessionActionResultSchema.parse(await this.options.generation.startSession({ principal: { pubkey: verifiedPubkey }, admissionReference: args.admissionReference, idempotencyKey: args.idempotencyKey, expectedVersion: 0, maximum: args.maximum, policyVersion: this.policyVersion, idea: args.idea, ...(args.remixReference ? { remixReference: args.remixReference } : {}) }));
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
      if ("kind" in args && args.kind === "pending_action") {
        if (!this.options.preAdmission) throw new Error("PRE_ADMISSION_UNAVAILABLE");
        const accountId = await accountIdForPrincipal({ pubkey: verifiedPubkey });
        const result = SessionActionResultSchema.parse(await this.options.preAdmission.resume({ owner: { ownerId: verifiedPubkey, accountId }, command: args }));
        return this.generationResponse("resume_session", verifiedPubkey, requestEventId, request.id, result);
      }
      if (!this.options.continuation) throw new Error("CONTINUATION_UNAVAILABLE");
      const accountId = await accountIdForPrincipal({ pubkey: verifiedPubkey });
      const result = ResumeSessionResultSchema.parse(await this.options.continuation.resumeSession({ ...args, principal: { id: accountId } }));
      return this.resumeResponse(verifiedPubkey, requestEventId, request.id, result);
    }
    if (name === "session_status") {
      const args = SessionStatusArgumentsSchema.parse(argumentsInput);
      if ("kind" in args && args.kind === "pending_action") {
        if (!this.options.preAdmission) throw new Error("PRE_ADMISSION_UNAVAILABLE");
        const accountId = await accountIdForPrincipal({ pubkey: verifiedPubkey });
        const result = PendingActionStatusProjectionSchema.parse(await this.options.preAdmission.status({ owner: { ownerId: verifiedPubkey, accountId }, checkpointId: args.checkpointId }));
        await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/session_status", params: result }), requestEventId);
        return freeze({ jsonrpc: "2.0" as const, id: request.id, result });
      }
      if (!this.options.sessionStatus) throw new Error("SESSION_STATUS_UNAVAILABLE");
      const query = SessionStatusQuerySchema.parse({ principal: { pubkey: verifiedPubkey }, sessionId: args.sessionId, ...(args.billing ? { billing: args.billing } : {}) });
      const result = SessionStatusSchema.parse(await this.options.sessionStatus.read(query));
      await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/session_status", params: result }), requestEventId);
      return freeze({ jsonrpc: "2.0" as const, id: request.id, result });
    }
    if (name === "preview") {
      const args = PreviewArgumentsSchema.parse(argumentsInput);
      if (!this.options.preview) throw new Error("PREVIEW_UNAVAILABLE");
      const accountId = await accountIdForPrincipal({ pubkey: verifiedPubkey });
      const canonical = this.options.transport.canonicalInvocation(verifiedPubkey, request.method, request.params);
      const result = args.action === "descriptor"
        ? await this.options.preview.previewVerifiedArtifact({ principal: { pubkey: verifiedPubkey }, accountId, sessionId: args.sessionId, artifactId: args.artifactId, runtimeVariant: args.runtimeVariant, requestEventId, invocationHash: canonical.invocationHash })
        : await this.options.preview.reviewCapabilities({ principal: { pubkey: verifiedPubkey }, accountId, sessionId: args.sessionId, artifactId: args.artifactId, runtimeVariant: args.runtimeVariant, requestEventId, invocationHash: canonical.invocationHash });
      return this.previewResponse(verifiedPubkey, requestEventId, request.id, args.action, result);
    }
    if (name === "publication") {
      const args = PublicationArgumentsSchema.parse(argumentsInput);
      if (!this.publicationAvailable()) return this.publicationUnavailableResponse(verifiedPubkey, requestEventId, request.id);
      if (!this.options.publication) return this.publicationUnavailableResponse(verifiedPubkey, requestEventId, request.id);
      const accountId = await accountIdForPrincipal({ pubkey: verifiedPubkey });
      const canonical = this.options.transport.canonicalInvocation(verifiedPubkey, request.method, request.params);
      const common = { principal: { pubkey: verifiedPubkey }, accountId, requestEventId, invocationHash: canonical.invocationHash };
      const result = args.action === "create_intent"
        ? await this.options.publication.createIntent({ ...common, sessionId: args.sessionId, artifactId: args.artifactId, runtimeVariant: args.runtimeVariant, idempotencyKey: args.idempotencyKey, purpose: args.purpose, consent: args.consent })
        : args.action === "submit_signed_manifest"
          ? await this.options.publication.submitSignedManifest({ ...common, intentId: args.intentId, command: args.command, event: args.event })
          : args.action === "status"
            ? await this.options.publication.status({ ...common, intentId: args.intentId })
            : await this.options.publication.reconcile({ ...common, intentId: args.intentId });
      return this.publicationResponse(verifiedPubkey, requestEventId, request.id, result);
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
      if (!this.options.admissions || !this.options.admissionReceipts) throw new Error("FUNDED_ADMISSION_UNAVAILABLE");
      // Canonical identity is established only after the signed envelope and
      // event correlation are verified, and before receipt/lifecycle authority.
      const canonical = CanonicalInvocationSchema.parse(this.options.transport.canonicalInvocation(verifiedPubkey, request.method, request.params));
      const lifecycle = await this.lifecycleFor(canonical.invocationHash, requestEventId, verifiedPubkey, request.id);
      const command = {
        principal: { pubkey: verifiedPubkey }, idempotencyKey: args.idempotencyKey,
        policyVersion: this.policyVersion, protocolVersion: this.protocolVersion,
        payload: { requestedCap: args.requestedCap, unit: args.unit },
      };
      const receipt = await this.options.admissionReceipts.issue({
        command,
        correlationDigest: lifecycle?.correlationDigest ?? (await this.digest(`contextvm:${requestEventId}:${verifiedPubkey}`)),
        // Bind the worker session to the normalized approved command, not raw
        // transport metadata. Exact redelivery therefore keeps the binding,
        // while any owner or admission-command change cannot reuse it.
        expectedSessionBindingDigest: await this.digest(`admission-session-binding:${JSON.stringify(command)}`),
      });
      const result = FundedAdmissionPortResultSchema.parse(await this.options.admissions.admit(command, receipt, lifecycle));
      // This finite projection is shared by notifications and RPC responses.
      // Account, provider, path, credential, and correlation facts never cross
      // the ContextVM wire even if an internal port changes its result shape.
      const wireResult = freeze(result.status === "accepted"
        ? { status: "accepted" as const, admissionReference: result.reference, approvedCap: result.approvedCap, heldAmount: result.heldAmount, unit: result.unit, payment: { generationPriceWaivedForAdmission: true } }
        : { status: result.status === "refused" ? "capacity_unavailable" as const : "reconciliation_pending" as const, retryAfterSeconds: 5, admissionReference: result.intentReference, unit: result.unit, payment: { generationPriceWaivedForAdmission: true } });
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
      if (args.maxFee === undefined) throw new Error("CASHU_FEE_CEILING_REQUIRED");
    } else if (tags.directPayment) {
      throw new Error("LIGHTNING_DIRECT_PAYMENT_DENIED");
    }
    const canonical = this.options.transport.canonicalInvocation(verifiedPubkey, request.method, request.params);
    const result = args.pmi === "bitcoin-lightning-bolt11"
      ? await this.options.topUps?.lightning.begin({ principal: { pubkey: verifiedPubkey }, idempotencyKey: args.idempotencyKey, amount: args.amount, unit: "sat", policyVersion: this.policyVersion, protocolVersion: this.protocolVersion })
      : await this.options.topUps?.cashu.submit({ principal: { pubkey: verifiedPubkey }, idempotencyKey: args.idempotencyKey, topUpId: args.topUpId ?? `cashu:${canonical.invocationHash}`, amount: args.amount, maxFee: args.maxFee!, unit: "sat", pmi: args.pmi, token: new TextEncoder().encode(tags.directPayment!.payload) });
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

  private async lifecycleFor(invocationHash: string, requestEventId: string, verifiedPubkey: string, requestId: string | number | null): Promise<AdmissionLifecycleContext> {
    const correlationDigest = await protectedLifecycleCorrelation([invocationHash, verifiedPubkey, requestEventId, String(requestId)]);
    const receiptMonotonicMs = Math.floor(this.options.monotonicNow?.() ?? performance.now());
    return AdmissionLifecycleContextSchema.parse({ version: "admission-lifecycle-v1", receiptMonotonicMs, correlationDigest });
  }

  private async digest(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  private async generationResponse(name: "start_session" | "revise_session", verifiedPubkey: string, requestEventId: string, id: string | number | null, result: z.infer<typeof SessionActionResultSchema>): Promise<ContextVmWireResponse> {
    const wireResult = result.status === "completed" || result.status === "failed"
      ? freeze({ status: result.status, code: result.code, sessionId: result.sessionId, sessionVersion: result.sessionVersion, artifactVersion: result.artifactVersion, ...(result.status === "completed" && result.artifactId ? { artifactId: result.artifactId } : {}), ...(result.status === "completed" && result.generation ? { generation: result.generation } : {}), confirmedSpend: result.confirmedSpend, remainingCap: result.remainingCap, remainingBalance: result.remainingBalance, nextAction: result.nextAction, operationId: result.operationId })
      : result.status === "billing_invariant_failed" || result.status === "usage_unknown"
        ? freeze({ status: result.status, code: result.code, sessionId: result.sessionId, nextAction: result.nextAction, operationId: result.operationId })
        : freeze({ status: result.status, code: result.code });
    await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: `notifications/${name}`, params: wireResult }), requestEventId);
    return freeze({ jsonrpc: "2.0" as const, id, result: wireResult });
  }

  private publicationAvailable(): boolean {
    return Boolean(this.publicationSourceContract && validatedAvailablePromotedCliSourceContract(this.options.publicationSourceContract));
  }

  private async previewResponse(verifiedPubkey: string, requestEventId: string, id: string | number | null, action: "descriptor" | "review_capabilities", input: unknown): Promise<ContextVmWireResponse> {
    const descriptor = PreviewDescriptorSchema.safeParse(input);
    const review = CapabilityReviewSchema.safeParse(input);
    const projected = z.object({ state: z.enum(["ready", "incompatible", "expired", "denied"]), artifactId: z.string().min(1).optional(), aggregateSha256: z.string().regex(/^[a-f0-9]{64}$/iu).optional(), previewGrantId: z.string().min(1).optional(), expiresAtMs: z.number().int().positive().optional(), previewUrl: z.string().url().refine((value) => { const url = new URL(value); return !url.username && !url.password && ((url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) || (url.origin === this.publicPreviewOrigin && /^\/cvm-preview\/[a-f0-9-]{36}\/$/u.test(url.pathname) && !url.search && !url.hash)); }, "TRUSTED_PREVIEW_URL_REQUIRED").optional(), capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/iu).optional(), runtimeVariant: z.string().min(1).optional(), required: z.array(z.object({ capability: z.string().min(1), requirement: z.enum(["required", "optional"]), purpose: z.string().min(1).max(512), consent: z.enum(["required", "optional"]), available: z.boolean() }).strict()).optional(), optional: z.array(z.object({ capability: z.string().min(1), requirement: z.enum(["required", "optional"]), purpose: z.string().min(1).max(512), consent: z.enum(["required", "optional"]), available: z.boolean() }).strict()).optional(), nextAction: z.enum(["preview", "review_capabilities", "sign_manifest"]), safeReasonCode: z.enum(["preview_not_available", "runtime_incompatible", "preview_expired", "runtime_denied"]).optional() }).passthrough().safeParse(input);
    const value = projected.success
      ? freeze({ status: projected.data.state, ...(projected.data.artifactId ? { artifactId: projected.data.artifactId } : {}), ...(projected.data.aggregateSha256 ? { aggregateSha256: projected.data.aggregateSha256 } : {}), ...(projected.data.previewGrantId ? { previewGrantId: projected.data.previewGrantId } : {}), ...(projected.data.expiresAtMs ? { expiresAtMs: projected.data.expiresAtMs } : {}), ...(projected.data.previewUrl ? { previewUrl: projected.data.previewUrl } : {}), ...(projected.data.capabilityDigest ? { capabilityDigest: projected.data.capabilityDigest } : {}), ...(projected.data.runtimeVariant ? { runtimeVariant: projected.data.runtimeVariant } : {}), ...(projected.data.required ? { required: projected.data.required } : {}), ...(projected.data.optional ? { optional: projected.data.optional } : {}), ...(projected.data.safeReasonCode ? { safeReasonCode: projected.data.safeReasonCode } : {}), nextAction: projected.data.nextAction })
      : descriptor.success
      ? freeze({ status: "ready" as const, artifactId: descriptor.data.artifact.artifactId, aggregateSha256: descriptor.data.artifact.aggregateSha256, previewGrantId: descriptor.data.previewGrantId, expiresAtMs: descriptor.data.expiresAtMs, capabilityDigest: descriptor.data.review.capabilityDigest, runtimeVariant: descriptor.data.review.runtimeVariant, nextAction: "review_capabilities" as const })
      : review.success
        ? freeze({ status: "ready" as const, artifactId: review.data.artifactId, aggregateSha256: review.data.aggregateSha256, capabilityDigest: review.data.capabilityDigest, runtimeVariant: review.data.runtimeVariant, required: review.data.required.map((item) => ({ capability: item.capability, requirement: item.requirement ?? "required", purpose: item.purpose, consent: item.consent, available: item.available })), optional: review.data.optional.map((item) => ({ capability: item.capability, requirement: item.requirement ?? "optional", purpose: item.purpose, consent: item.consent, available: item.available })), nextAction: "sign_manifest" as const })
        : freeze({ status: "denied" as const, nextAction: "preview" as const });
    await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/preview", params: value }), requestEventId);
    return freeze({ jsonrpc: "2.0" as const, id, result: value });
  }

  private async publicationUnavailableResponse(verifiedPubkey: string, requestEventId: string, id: string | number | null): Promise<ContextVmWireResponse> {
    const result = freeze({ status: "publication_unavailable" as const, nextAction: "preview" as const });
    await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/publication", params: result }), requestEventId);
    return freeze({ jsonrpc: "2.0" as const, id, result });
  }

  private async publicationResponse(verifiedPubkey: string, requestEventId: string, id: string | number | null, input: unknown): Promise<ContextVmWireResponse> {
    const candidate = z.object({ state: z.enum(["intent_ready", "publication_reconciliation_pending", "partial", "complete"]), intentId: z.string().min(1), artifactId: z.string().min(1).optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/iu).optional(), normalizedDTag: z.string().min(1).optional(), capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/iu).optional(), expiresAtMs: z.number().int().positive().optional(), nextAction: z.enum(["sign_manifest", "publish", "reconcile_publication", "none"]), ownerEventId: z.string().regex(/^[a-f0-9]{64}$/iu).optional(), attestationId: z.string().min(1).optional(), deploymentId: z.string().min(1).optional(), fullServerUploadId: z.string().min(1).optional(), safeServerEvidenceCount: z.number().int().nonnegative().optional(), safeRelayEvidenceCount: z.number().int().nonnegative().optional() }).passthrough().safeParse(input);
    if (!candidate.success) throw new Error("PUBLICATION_RESULT_INVALID");
    const result = freeze({ status: candidate.data.state, intentId: candidate.data.intentId, ...(candidate.data.artifactId ? { artifactId: candidate.data.artifactId } : {}), ...(candidate.data.fingerprint ? { fingerprint: candidate.data.fingerprint } : {}), ...(candidate.data.normalizedDTag ? { normalizedDTag: candidate.data.normalizedDTag } : {}), ...(candidate.data.capabilityDigest ? { capabilityDigest: candidate.data.capabilityDigest } : {}), ...(candidate.data.expiresAtMs ? { expiresAtMs: candidate.data.expiresAtMs } : {}), ...(candidate.data.ownerEventId ? { ownerEventId: candidate.data.ownerEventId } : {}), ...(candidate.data.attestationId ? { attestationId: candidate.data.attestationId } : {}), ...(candidate.data.deploymentId ? { deploymentId: candidate.data.deploymentId } : {}), ...(candidate.data.fullServerUploadId ? { fullServerUploadId: candidate.data.fullServerUploadId } : {}), ...(candidate.data.safeServerEvidenceCount !== undefined ? { safeServerEvidenceCount: candidate.data.safeServerEvidenceCount } : {}), ...(candidate.data.safeRelayEvidenceCount !== undefined ? { safeRelayEvidenceCount: candidate.data.safeRelayEvidenceCount } : {}), nextAction: candidate.data.nextAction });
    await this.options.transport.sendNotification(verifiedPubkey, freeze<ContextVmWireNotification>({ jsonrpc: "2.0", method: "notifications/publication", params: result }), requestEventId);
    return freeze({ jsonrpc: "2.0" as const, id, result });
  }

  private async resumeResponse(verifiedPubkey: string, requestEventId: string, id: string | number | null, result: z.infer<typeof ResumeSessionResultSchema>): Promise<ContextVmWireResponse> {
    const wireResult = result.status === "restored"
      ? freeze({ status: result.status, code: result.code, sessionId: result.sessionId, checkpointId: result.checkpointId, pendingActionReference: result.pendingActionReference })
      : result.status === "reconciliation_pending"
        ? freeze({ status: result.status, code: result.code, sessionId: result.sessionId, checkpointId: result.checkpointId, pendingActionReference: result.pendingActionReference })
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
