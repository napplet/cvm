import { z } from "zod";

export const PrincipalSchema = z.object({ id: z.string().min(1).max(256) }).strict();
export const PolicyVersionSchema = z.string().min(1).max(128);
export const ActionEnvelopeSchema = z.object({
  principal: PrincipalSchema,
  sessionId: z.string().min(1).max(128),
  actionId: z.string().min(1).max(128),
  kind: z.literal("design"),
  idempotencyKey: z.string().min(1).max(256),
  expectedVersion: z.number().int().nonnegative(),
  policyVersion: PolicyVersionSchema,
  idea: z.string(),
}).strict();

export const WorkerRunRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  actionId: z.string().min(1).max(128),
  expectedVersion: z.number().int().nonnegative(),
  policyVersion: PolicyVersionSchema,
  capabilityGrant: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  idea: z.string(),
}).strict();

export const WorkerEvidenceSchema = z.object({
  type: z.string().min(1).max(128),
  detail: z.string().max(1_024),
}).strict();

export const WorkerToolRequestSchema = z.object({
  tool: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  actionId: z.string().min(1).max(128),
  expectedVersion: z.number().int().nonnegative(),
  policyVersion: PolicyVersionSchema,
  capabilityGrant: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  path: z.string(),
  content: z.string(),
}).strict();

export const WorkerProposalSchema = z.object({
  status: z.literal("proposed"),
  toolRequests: z.array(WorkerToolRequestSchema).max(1),
  evidence: z.array(WorkerEvidenceSchema).max(16),
}).strict();

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
export type SessionEvidence = Readonly<{
  principalId: string;
  sessionId: string;
  actionId: string;
  version: number;
  policyVersion: string;
  capabilityGrant: string;
  outcomeCode: string;
  fingerprint: string;
  evidenceDigest: string;
}>;

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
