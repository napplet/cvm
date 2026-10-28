import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { canonicalJson } from "../promotion/schema";
import { DecimalSatSchema, PrincipalSchema } from "../phase-03/contracts";

const Reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u);
export const ApproveSessionCapArgumentsSchema = z.object({
  sessionId: Reference, admissionReference: Reference,
  idempotencyKey: z.string().min(1).max(160),
  expectedApprovedCap: DecimalSatSchema,
  maximum: DecimalSatSchema,
  unit: z.literal("sat"),
}).strict();
const Command = ApproveSessionCapArgumentsSchema.extend({ principal: PrincipalSchema, policyVersion: z.string().min(1).max(160), protocolVersion: z.string().min(1).max(160) }).strict();
export const SessionCapDeniedCodeSchema = z.enum(["SESSION_CAP_NOT_FOUND_OR_DENIED", "SESSION_CAP_STALE_APPROVAL", "SESSION_CAP_INSUFFICIENT_BALANCE", "SESSION_CAP_INCREASE_REQUIRED", "SESSION_CAP_IDEMPOTENCY_CONFLICT"]);
export const SessionCapApprovalResultSchema = z.object({
  status: z.literal("approved"), accountId: Reference, sessionId: Reference,
  admissionReference: Reference, approvalReference: Reference,
  previousApprovedCap: DecimalSatSchema, approvedCap: DecimalSatSchema,
  heldAmount: z.string().regex(/^(0|[1-9][0-9]*)$/u), unit: z.literal("sat"),
}).strict();
export type SessionCapApprovalResult = z.infer<typeof SessionCapApprovalResultSchema>;
export type SessionCapApprovalInput = Readonly<{
  accountId: string; sessionId: string; admissionReference: string;
  idempotencyKey: string; fingerprint: string; approvalReference: string;
  expectedApprovedCap: bigint; maximum: bigint; consentReference: string;
  policyVersion: string; protocolVersion: string;
}>;
export interface SessionCapTransaction { approveSessionCap(input: SessionCapApprovalInput): Promise<SessionCapApprovalResult>; }
export interface SessionCapFundingStore { transact<T>(accountId: string, operation: (transaction: SessionCapTransaction) => Promise<T> | T): Promise<T>; }

/** Reserves only the increase in an existing owner's total session maximum.
 * No rail, worker, model, signing or transport authority enters this service. */
export class SessionCapApprovalService {
  constructor(private readonly store: SessionCapFundingStore) {}
  async approve(raw: unknown, authority: Readonly<{ consentReference: string }>): Promise<SessionCapApprovalResult> {
    const command = Command.parse(raw);
    const consentReference = z.string().regex(/^nostr:[a-f0-9]{64}$/u).parse(authority.consentReference);
    if (BigInt(command.maximum) <= BigInt(command.expectedApprovedCap)) throw new Error("SESSION_CAP_INCREASE_REQUIRED");
    const accountId = await accountIdForPrincipal(command.principal);
    const fingerprint = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson({ kind: "approve_session_cap", accountId, command })))).toString("hex");
    // Delivery/event IDs are provenance, not semantic command identity. A new
    // signed delivery replays the first immutable approval rather than adding.
    return SessionCapApprovalResultSchema.parse(await this.store.transact(accountId, tx => tx.approveSessionCap({
      accountId, sessionId: command.sessionId, admissionReference: command.admissionReference,
      idempotencyKey: command.idempotencyKey, fingerprint, approvalReference: `cap-approval:${fingerprint}`,
      expectedApprovedCap: BigInt(command.expectedApprovedCap), maximum: BigInt(command.maximum), consentReference,
      policyVersion: command.policyVersion, protocolVersion: command.protocolVersion,
    })));
  }
}
