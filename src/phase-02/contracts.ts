import { z } from "zod";

export const PrincipalSchema = z.object({ id: z.string().min(1) }).strict();
export const PolicyVersionSchema = z.string().min(1);
export const AdmissionRequestSchema = z.object({ idea: z.string() }).strict();
export const SessionActionSchema = z.object({
  principal: PrincipalSchema,
  sessionId: z.string().min(1),
  actionId: z.string().min(1),
  kind: z.literal("design"),
  idempotencyKey: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  policyVersion: PolicyVersionSchema,
  idea: z.string(),
}).strict();
export const ActionEnvelopeSchema = SessionActionSchema;

export const WorkerRunRequestSchema = z.object({
  sessionId: z.string().min(1),
  actionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  policyVersion: PolicyVersionSchema,
  capabilityGrant: z.string().min(1),
  workspaceId: z.string().min(1),
  idea: z.string(),
}).strict();

export const WorkerEvidenceSchema = z.object({
  type: z.string().min(1),
  detail: z.string(),
}).strict();

export const WorkerToolRequestSchema = z.object({
  tool: z.string().min(1),
  sessionId: z.string().min(1),
  actionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  policyVersion: PolicyVersionSchema,
  capabilityGrant: z.string().min(1),
  workspaceId: z.string().min(1),
  path: z.string(),
  content: z.string(),
}).strict();

export const WorkerProposalSchema = z.object({
  status: z.literal("proposed"),
  toolRequests: z.array(WorkerToolRequestSchema).max(1),
  evidence: z.array(WorkerEvidenceSchema).max(16),
}).strict();
export const WorkerEventSchema = WorkerProposalSchema;
export const ToolRequestSchema = WorkerToolRequestSchema;

const EvidenceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
export const EvidenceSchema = z.object({
  principalId: z.string().min(1),
  sessionId: z.string().min(1),
  actionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  policyVersion: PolicyVersionSchema,
  capabilityGrant: z.string().min(1),
  outcomeCode: z.string().min(1),
  fingerprint: EvidenceDigestSchema,
  evidenceDigest: EvidenceDigestSchema,
}).strict();

export const ResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), code: z.literal("ACTION_COMMITTED"), version: z.number().int().positive(), evidenceDigest: EvidenceDigestSchema }).strict(),
  z.object({ status: z.literal("denied"), code: z.enum(["ADMISSION_DENIED", "IDEMPOTENCY_KEY_CONFLICT", "STALE_SESSION_VERSION", "TOOL_AUTHORIZATION_DENIED"]), currentVersion: z.number().int().nonnegative().optional(), evidenceDigest: EvidenceDigestSchema.optional() }).strict(),
  z.object({ status: z.literal("recoverable_failure"), code: z.literal("WORKER_UNCERTAIN"), evidenceDigest: EvidenceDigestSchema }).strict(),
]);

export type Principal = z.infer<typeof PrincipalSchema>;
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
export type WorkerRunRequest = z.infer<typeof WorkerRunRequestSchema>;
export type WorkerToolRequest = z.infer<typeof WorkerToolRequestSchema>;
export type WorkerProposal = z.infer<typeof WorkerProposalSchema>;

/** The worker can only return a proposal; it has no authoritative mutation API. */
export interface WorkerPort {
  run(request: WorkerRunRequest, signal: AbortSignal): Promise<unknown>;
}

export type StoredResult = Readonly<Record<string, unknown>>;
export type SessionEvidence = z.infer<typeof EvidenceSchema>;

export interface SessionTransaction {
  getVersion(): number;
  getReplay(idempotencyKey: string): Readonly<{ fingerprint: string; result: StoredResult }> | undefined;
  recordResult(idempotencyKey: string, fingerprint: string, result: StoredResult, nextVersion: number): void;
  appendEvidence(evidence: SessionEvidence): void;
}

/** Implementations must provide a serialized, all-or-nothing session transaction. */
export interface SessionStore {
  transact<T>(sessionId: string, operation: (transaction: SessionTransaction) => Promise<T> | T): Promise<T>;
  getSessionVersion(sessionId: string): number;
  readonly evidence: readonly SessionEvidence[];
}
