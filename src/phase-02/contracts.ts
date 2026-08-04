import { z } from "zod";
import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";

/**
 * This is the only WorkerPort/schema authority.  Adapters and fakes import the
 * parsed values below; they must not restate a worker boundary locally.
 */
export const PrincipalSchema = z.object({ id: z.string().min(1) }).strict();
export const PolicyVersionSchema = z.string().min(1);
export const CorrelationSchema = z.object({
  sessionId: z.string().min(1),
  actionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  policyVersion: PolicyVersionSchema,
  capabilityGrant: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict();

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

export const WorkerRunRequestSchema = CorrelationSchema.extend({ idea: z.string().min(1) }).strict();

const RelativePathSchema = z.string().min(1).max(PHASE_02_POLICY_INITIAL.tools.maxPathCharacters).refine(
  (path) => !path.includes("\0") && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === ".."),
  "path must be a non-empty, relative, component-contained path",
);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
export const ApprovedCommandIdSchema = z.enum(["format_workspace", "verify_workspace"]);

const ToolIdentitySchema = CorrelationSchema.extend({
  callId: z.string().min(1),
  evidenceId: z.string().min(1),
});
export const WorkspaceReadToolRequestSchema = ToolIdentitySchema.extend({ tool: z.literal("workspace_read"), path: RelativePathSchema }).strict();
export const WorkspaceWriteToolRequestSchema = ToolIdentitySchema.extend({ tool: z.literal("workspace_write"), path: RelativePathSchema, content: z.string().max(PHASE_02_POLICY_INITIAL.tools.maxWriteContentCharacters) }).strict();
export const ApprovedCommandToolRequestSchema = ToolIdentitySchema.extend({ tool: z.literal("approved_command"), commandId: ApprovedCommandIdSchema }).strict();
export const CaptureEvidenceToolRequestSchema = ToolIdentitySchema.extend({ tool: z.literal("capture_evidence"), label: z.string().min(1).max(PHASE_02_POLICY_INITIAL.tools.maxPathCharacters) }).strict();
export const CheckpointExportToolRequestSchema = ToolIdentitySchema.extend({ tool: z.literal("export_checkpoint"), checkpointId: z.string().min(1) }).strict();

/** Closed, least-authority union for every new worker capability request. */
export const ToolRequestSchema = z.discriminatedUnion("tool", [
  WorkspaceReadToolRequestSchema,
  WorkspaceWriteToolRequestSchema,
  ApprovedCommandToolRequestSchema,
  CaptureEvidenceToolRequestSchema,
  CheckpointExportToolRequestSchema,
]);
export const ToolResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("allowed"), code: z.literal("TOOL_ALLOWED"), callId: z.string().min(1), evidenceId: z.string().min(1), output: z.unknown().optional() }).strict(),
  z.object({ status: z.literal("denied"), code: z.string().min(1), callId: z.string().optional(), evidenceId: z.string().optional() }).strict(),
]);

/**
 * Plan 01 tracer compatibility only.  It is deliberately not a gateway tool
 * contract: new authority-bearing tool calls must parse ToolRequestSchema.
 */
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
export const WorkerEvidenceSchema = z.object({ type: z.string().min(1), detail: z.string() }).strict();
export const WorkerProposalSchema = z.object({
  status: z.literal("proposed"),
  toolRequests: z.array(WorkerToolRequestSchema).max(1),
  evidence: z.array(WorkerEvidenceSchema).max(16),
}).strict();

export const WorkerEventSchema = z.union([
  WorkerProposalSchema,
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("progress"), turn: z.number().int().positive(), detail: z.string().min(1).max(PHASE_02_POLICY_INITIAL.tools.maxPathCharacters) }).strict(),
    z.object({ kind: z.literal("tool_proposal"), turn: z.number().int().positive(), request: ToolRequestSchema }).strict(),
    z.object({ kind: z.literal("checkpoint_proposal"), turn: z.number().int().positive(), proposal: z.object({ checkpointId: z.string().min(1) }).strict() }).strict(),
  ]),
]);

export const CheckpointProposalSchema = CorrelationSchema.extend({
  formatVersion: z.literal("portable-checkpoint-v1"),
  inventory: z.array(RelativePathSchema).min(1).max(1_000),
  archiveBase64: z.string().min(1),
  archiveSha256: DigestSchema,
  evidenceSha256: DigestSchema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.inventory).size !== value.inventory.length) ctx.addIssue({ code: "custom", message: "inventory entries must be unique" });
});

export const WorkerRunResultSchema = z.discriminatedUnion("status", [
  WorkerProposalSchema,
  z.object({ status: z.literal("completed"), code: z.literal("WORKER_PROPOSALS_VALIDATED"), events: z.array(WorkerEventSchema), checkpoint: CheckpointProposalSchema.optional() }).strict(),
  z.object({ status: z.literal("unavailable"), code: z.literal("WORKER_UNAVAILABLE") }).strict(),
  z.object({ status: z.literal("interrupted"), code: z.literal("WORKER_INTERRUPTED") }).strict(),
  z.object({ status: z.literal("limited"), code: z.literal("WORKER_TURN_LIMIT") }).strict(),
  z.object({ status: z.literal("blocked"), code: z.enum(["WORKER_STALE_EVENT", "WORKER_GATEWAY_DENIED", "CHECKPOINT_BOUNDARY_REQUIRED"]) }).strict(),
]);
export const ResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), code: z.literal("ACTION_COMMITTED"), version: z.number().int().positive(), evidenceDigest: DigestSchema }).strict(),
  z.object({ status: z.literal("denied"), code: z.enum(["ADMISSION_DENIED", "IDEMPOTENCY_KEY_CONFLICT", "STALE_SESSION_VERSION", "TOOL_AUTHORIZATION_DENIED"]), currentVersion: z.number().int().nonnegative().optional(), evidenceDigest: DigestSchema.optional() }).strict(),
  z.object({ status: z.literal("recoverable_failure"), code: z.literal("WORKER_UNCERTAIN"), evidenceDigest: DigestSchema }).strict(),
]);

export const EvidenceSchema = z.object({
  principalId: z.string().min(1), sessionId: z.string().min(1), actionId: z.string().min(1), version: z.number().int().nonnegative(), policyVersion: PolicyVersionSchema,
  capabilityGrant: z.string().min(1), outcomeCode: z.string().min(1), fingerprint: DigestSchema, evidenceDigest: DigestSchema,
}).strict();

export type Principal = z.infer<typeof PrincipalSchema>;
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
export type WorkerRunRequest = z.infer<typeof WorkerRunRequestSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type WorkerToolRequest = z.infer<typeof WorkerToolRequestSchema>;
export type WorkerProposal = z.infer<typeof WorkerProposalSchema>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type WorkerRunResult = z.infer<typeof WorkerRunResultSchema>;
export type CheckpointProposal = z.infer<typeof CheckpointProposalSchema>;

/** The worker can only produce parsed proposals/results; it owns no state API. */
export interface WorkerPort {
  run(request: WorkerRunRequest, signal: AbortSignal): Promise<WorkerRunResult>;
}

export type StoredResult = Readonly<Record<string, unknown>>;
export type SessionEvidence = z.infer<typeof EvidenceSchema>;
export interface SessionTransaction {
  getVersion(): number;
  getReplay(idempotencyKey: string): Readonly<{ fingerprint: string; result: StoredResult }> | undefined;
  recordResult(idempotencyKey: string, fingerprint: string, result: StoredResult, nextVersion: number): void;
  appendEvidence(evidence: SessionEvidence): void;
}
export interface SessionStore {
  transact<T>(sessionId: string, operation: (transaction: SessionTransaction) => Promise<T> | T): Promise<T>;
  getSessionVersion(sessionId: string): number;
  readonly evidence: readonly SessionEvidence[];
}
