import { z } from "zod";
import { type WorkerEvent, type WorkerPort, WorkerRunRequestSchema, WorkerRunResultSchema } from "../phase-02/contracts";
import { type ArtifactVerifier } from "../phase-02/trusted-core";
import { evaluateArtifactContract } from "../policy/artifact-contract";
import { canonicalToolchainId, parsePromotionManifest } from "../promotion/schema";
import { emitLifecycleObservation, type LifecycleTelemetryPort } from "../telemetry/contracts";
import { SourceProposalSchema } from "../model/model-gateway";

const WORKFLOW = ["make-napplet", "design-napplet", "build-napplet", "test-napplet"] as const;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const RelativeSurfaceSchema = z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("\0") && !value.split("/").some((part) => part === "" || part === "." || part === ".."), "application surface must be contained");

export const NappletWorkflowStepSchema = z.enum(WORKFLOW);
export const PromotedToolchainEvidenceSchema = z.object({
  toolchainId: DigestSchema,
  manifest: z.unknown(),
  evidence: z.object({ build: z.string().min(1), forbiddenAuthority: z.string().min(1), verify: z.string().min(1), conformance: z.string().min(1) }).strict(),
}).strict();
export const NappletHarnessRequestSchema = z.object({
  principalId: z.string().min(1), sessionId: z.string().min(1), actionId: z.string().min(1), expectedVersion: z.number().int().nonnegative(), policyVersion: z.string().min(1), capabilityGrant: z.string().min(1), workspaceId: z.string().min(1), idea: z.string().min(1).optional(), sourceProposal: SourceProposalSchema.optional(),
  actionKind: z.enum(["generation", "revision", "repair"]), workspaceLineage: z.string().min(1), snapshotReference: z.string().min(1), priorArtifactId: z.string().min(1), failedArtifactId: z.string().min(1).optional(), validationReportReference: z.string().min(1).optional(),
  approvedApplicationSurfaces: z.array(RelativeSurfaceSchema).min(1).max(1_000), toolchain: PromotedToolchainEvidenceSchema,
}).strict();
const SafeDiagnosticSchema = z.object({ code: z.string().min(1), summary: z.string().min(1), evidenceIds: z.array(z.string().min(1)).min(1).max(8) }).strict();
export const NappletHarnessResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("verified"), code: z.literal("ARTIFACT_VERIFIED"), artifactId: z.string().min(1), workflow: z.tuple([NappletWorkflowStepSchema, NappletWorkflowStepSchema, NappletWorkflowStepSchema, NappletWorkflowStepSchema]), evidenceIds: z.array(z.string().min(1)).min(4).max(8) }).strict(),
  z.object({ status: z.literal("failed"), code: z.literal("HARNESS_BOUNDARY_FAILED"), priorArtifactId: z.string().min(1), diagnostic: SafeDiagnosticSchema }).strict(),
  z.object({ status: z.literal("incomplete"), code: z.literal("WORKER_INCOMPLETE"), priorArtifactId: z.string().min(1), diagnostic: SafeDiagnosticSchema }).strict(),
  z.object({ status: z.literal("blocked"), code: z.literal("HARNESS_BLOCKED"), priorArtifactId: z.string().min(1), diagnostic: SafeDiagnosticSchema }).strict(),
  z.object({ status: z.literal("validation_failed"), code: z.literal("ARTIFACT_CONTRACT_BLOCKED"), priorArtifactId: z.string().min(1), diagnostic: SafeDiagnosticSchema }).strict(),
]);

export type NappletHarnessRequest = z.infer<typeof NappletHarnessRequestSchema>;
export type NappletHarnessResult = z.infer<typeof NappletHarnessResultSchema>;
export interface NappletHarness { run(input: unknown, signal?: AbortSignal): Promise<NappletHarnessResult>; }

function safeDiagnostic(code: string, summary: string, evidenceIds: readonly string[]): z.infer<typeof SafeDiagnosticSchema> {
  return SafeDiagnosticSchema.parse({ code, summary, evidenceIds: [...new Set(evidenceIds)] });
}

function fixedWorkflow(manifest: unknown): readonly [typeof WORKFLOW[0], typeof WORKFLOW[1], typeof WORKFLOW[2], typeof WORKFLOW[3]] | undefined {
  try {
    const parsed = parsePromotionManifest(manifest);
    const steps = parsed.stages.map((stage) => stage.id);
    if (steps.length !== WORKFLOW.length || steps.some((step, index) => step !== WORKFLOW[index])) return undefined;
    return [...WORKFLOW];
  } catch { return undefined; }
}

function eventsStayOnApprovedSurfaces(events: readonly WorkerEvent[], allowed: readonly string[]): boolean {
  return events.every((event) => {
    if (!("kind" in event) || event.kind !== "tool_proposal") return true;
    const request = event.request;
    if (request.tool !== "workspace_read" && request.tool !== "workspace_write") return true;
    return allowed.includes(request.path);
  });
}

/**
 * Project-owned composition only: this class neither executes package text nor
 * grants credentials, billing, publication, or manifest authority to a worker.
 */
export class ProjectNappletHarness implements NappletHarness {
  constructor(private readonly options: Readonly<{ worker: WorkerPort; artifactVerifier: ArtifactVerifier; telemetry?: LifecycleTelemetryPort }>) {}

  async run(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<NappletHarnessResult> {
    const request = NappletHarnessRequestSchema.parse(input);
    const result = await this.#run(request, signal);
    await emitLifecycleObservation(this.options.telemetry, [request.principalId, request.sessionId, request.actionId], "validation", result.status === "verified" ? "succeeded" : result.status === "blocked" ? "blocked" : "failed");
    return result;
  }

  /** Emits only the final finite conformance decision; worker payloads stay local. */
  async #run(request: NappletHarnessRequest, signal: AbortSignal): Promise<NappletHarnessResult> {
    const workflow = fixedWorkflow(request.toolchain.manifest);
    if (!workflow || await canonicalToolchainId(parsePromotionManifest(request.toolchain.manifest)) !== request.toolchain.toolchainId) {
      return NappletHarnessResultSchema.parse({ status: "blocked", code: "HARNESS_BLOCKED", priorArtifactId: request.priorArtifactId, diagnostic: safeDiagnostic("TOOLCHAIN_IDENTITY_INVALID", "promoted toolchain identity could not be verified", [request.toolchain.evidence.verify]) });
    }
    if (request.sourceProposal && (!request.sourceProposal.files.every((file) => request.approvedApplicationSurfaces.includes(file.path)) || request.sourceProposal.files.some((file) => file.path.startsWith("/")))) return NappletHarnessResultSchema.parse({ status: "blocked", code: "HARNESS_BLOCKED", priorArtifactId: request.priorArtifactId, diagnostic: safeDiagnostic("SOURCE_PROPOSAL_SURFACE_REJECTED", "charged source proposal exceeded its approved application surfaces", [request.toolchain.evidence.forbiddenAuthority]) });
    const workerRequest = WorkerRunRequestSchema.parse({ sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, ...(request.idea ? { idea: request.idea } : {}), ...(request.sourceProposal ? { sourceProposalReference: request.sourceProposal.reference, sourceProposalSha256: request.sourceProposal.sha256, sourceProposalFiles: request.sourceProposal.files } : {}) });
    let workerResult;
    try { workerResult = WorkerRunResultSchema.parse(await this.options.worker.run(workerRequest, signal)); }
    catch { return NappletHarnessResultSchema.parse({ status: "failed", code: "HARNESS_BOUNDARY_FAILED", priorArtifactId: request.priorArtifactId, diagnostic: safeDiagnostic("WORKER_BOUNDARY_FAILURE", "worker result could not be safely processed", [request.toolchain.evidence.verify]) }); }
    if (workerResult.status !== "completed") {
      const status = workerResult.status === "blocked" ? "blocked" : "incomplete";
      return NappletHarnessResultSchema.parse({ status, code: status === "blocked" ? "HARNESS_BLOCKED" : "WORKER_INCOMPLETE", priorArtifactId: request.priorArtifactId, diagnostic: safeDiagnostic(workerResult.code, "worker did not produce a complete verified candidate", [request.toolchain.evidence.build, request.toolchain.evidence.verify]) });
    }
    const artifact = workerResult.artifact;
    if (artifact.sessionId !== request.sessionId || artifact.actionId !== request.actionId || artifact.expectedVersion !== request.expectedVersion || artifact.policyVersion !== request.policyVersion || artifact.capabilityGrant !== request.capabilityGrant || artifact.workspaceId !== request.workspaceId || !eventsStayOnApprovedSurfaces(workerResult.events, request.approvedApplicationSurfaces)) {
      return NappletHarnessResultSchema.parse({ status: "validation_failed", code: "ARTIFACT_CONTRACT_BLOCKED", priorArtifactId: request.priorArtifactId, diagnostic: safeDiagnostic("WORKER_BINDING_INVALID", "candidate failed coordinator ownership or surface checks", [request.toolchain.evidence.forbiddenAuthority]) });
    }
    try {
      const verified = await this.options.artifactVerifier.verify({ action: { principal: { id: request.principalId }, sessionId: request.sessionId, actionId: request.actionId, kind: "design", idempotencyKey: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, idea: request.idea ?? "Charged source proposal" }, request: workerRequest, result: workerResult, events: workerResult.events });
      const contract = verified && await evaluateArtifactContract(verified.contractInput);
      if (!verified || !contract || contract.verdict !== "pass") {
        return NappletHarnessResultSchema.parse({ status: "validation_failed", code: "ARTIFACT_CONTRACT_BLOCKED", priorArtifactId: request.priorArtifactId, diagnostic: safeDiagnostic("ARTIFACT_CONTRACT_BLOCKED", "candidate did not pass all server-owned verification gates", [request.toolchain.evidence.forbiddenAuthority, request.toolchain.evidence.conformance]) });
      }
      return NappletHarnessResultSchema.parse({ status: "verified", code: "ARTIFACT_VERIFIED", artifactId: verified.artifact.artifactId, workflow, evidenceIds: [request.toolchain.evidence.build, request.toolchain.evidence.forbiddenAuthority, request.toolchain.evidence.verify, request.toolchain.evidence.conformance] });
    } catch {
      return NappletHarnessResultSchema.parse({ status: "validation_failed", code: "ARTIFACT_CONTRACT_BLOCKED", priorArtifactId: request.priorArtifactId, diagnostic: safeDiagnostic("ARTIFACT_VERIFIER_UNAVAILABLE", "server verification could not establish a usable candidate", [request.toolchain.evidence.verify]) });
    }
  }
}
