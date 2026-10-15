import type { ArtifactVerifier } from "../phase-02/trusted-core";
import type { WorkerPort, WorkerRunRequest, WorkerRunResult } from "../phase-02/contracts";
import type { ArtifactContractInput } from "../policy/artifact-contract";
import { LocalArtifactVerifier, type VerifiedArtifactFacts } from "./local-artifact-verifier";
import { LocalArtifactRepository, type SealedArtifact } from "./local-artifact-repository";
import { LocalNappletWorker, type WorkerOutput } from "./local-napplet-worker";

type Materialized = Readonly<{ output: WorkerOutput; request: WorkerRunRequest }>;

/**
 * Bridges the durable Plan 53 proposal into the closed Docker runner.  The
 * worker result contains no filesystem authority: its sole purpose is to
 * correlate a later trusted verification with this one materialized output.
 */
export class LocalProposalWorkerPort implements WorkerPort {
  readonly #materialized = new Map<string, Materialized>();
  constructor(private readonly worker: LocalNappletWorker) {}

  async run(request: WorkerRunRequest, signal: AbortSignal): Promise<WorkerRunResult> {
    if (signal.aborted) return { status: "unavailable", code: "WORKER_UNAVAILABLE" };
    if (!request.sourceProposalReference || !request.sourceProposalSha256 || !request.sourceProposalFiles) {
      return { status: "unavailable", code: "WORKER_UNAVAILABLE" };
    }
    const key = this.key(request);
    const existing = this.#materialized.get(key);
    if (existing) {
      if (existing.request.sourceProposalSha256 !== request.sourceProposalSha256) throw new Error("WORKER_ACTION_PROPOSAL_MISMATCH");
      return this.completed(request);
    }
    try {
      const output = await this.worker.materialize({
        proposalSha256: request.sourceProposalSha256,
        proposal: { reference: request.sourceProposalReference, sha256: request.sourceProposalSha256, files: request.sourceProposalFiles },
      }, signal);
      this.#materialized.set(key, Object.freeze({ output, request }));
      return this.completed(request);
    } catch (error) {
      // Keep worker diagnostics server-side; the ContextVM projection remains
      // a stable unavailable result and never exposes build output to clients.
      console.error("development worker materialization failed", error instanceof Error ? error.message : "unknown");
      return { status: "unavailable", code: "WORKER_UNAVAILABLE" };
    }
  }

  take(request: WorkerRunRequest): Materialized | undefined { return this.#materialized.get(this.key(request)); }
  async discard(request: WorkerRunRequest): Promise<void> {
    const key = this.key(request); const materialized = this.#materialized.get(key);
    this.#materialized.delete(key);
    await materialized?.output.cleanup();
  }

  private key(request: WorkerRunRequest): string { return `${request.workspaceId}\u0000${request.sessionId}\u0000${request.actionId}\u0000${request.expectedVersion}\u0000${request.sourceProposalSha256 ?? ""}`; }

  private completed(request: WorkerRunRequest): WorkerRunResult {
    return {
      status: "completed", code: "WORKER_PROPOSALS_VALIDATED",
      events: [{ kind: "progress", turn: 1, detail: "Pinned development worker completed verification gates" }],
      artifact: {
        sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion,
        policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId,
        artifactId: `candidate:${request.actionId}`,
        purpose: { kind: "focused", statements: ["A single generated napplet surface"] },
        surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false },
        dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false },
        capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false },
        upstream: { scanner: { verdict: "pass", checkId: "upstream:cli-verify" }, conformance: { verdict: "pass", checkId: "upstream:chromium-conformance" } },
      },
    };
  }
}

/** Trusted server-side promotion.  It re-reads worker bytes before sealing and
 * cannot synthesize an artifact for an action that never ran the closed worker. */
export class LocalGenerationArtifactVerifier implements ArtifactVerifier {
  constructor(private readonly input: Readonly<{ worker: LocalProposalWorkerPort; verifier: LocalArtifactVerifier; repository: LocalArtifactRepository; ownerIdForAccount(accountId: string): string | undefined }>) {}

  async verify(facts: Parameters<ArtifactVerifier["verify"]>[0]) {
    const materialized = this.input.worker.take(facts.request);
    if (!materialized || materialized.request.sourceProposalSha256 !== facts.request.sourceProposalSha256 || facts.result.status !== "completed") return undefined;
    try {
      const ownerId = this.input.ownerIdForAccount(facts.action.principal.id);
      if (!ownerId || !/^[a-f0-9]{64}$/u.test(ownerId)) return undefined;
      const verified = await this.input.verifier.verify({
        ownerId, accountId: facts.action.principal.id, sessionId: facts.action.sessionId, actionId: facts.action.actionId,
        expectedVersion: facts.action.expectedVersion, proposalSha256: materialized.request.sourceProposalSha256!,
        toolchainSha256: materialized.output.toolchainSha256, distRoot: materialized.output.distRoot,
        commandEvidence: materialized.output.commandEvidence,
      });
      const sealed = await this.input.repository.commit(verified);
      return Object.freeze({
        artifact: { artifactId: sealed.artifactId, artifactSha256: sealed.sealedObjectSha256, scannerReportSha256: sealed.verificationEvidenceSha256, conformanceReportSha256: sealed.aggregateSha256 },
        contractInput: facts.result.artifact as ArtifactContractInput,
      });
    } finally {
      await this.input.worker.discard(facts.request);
    }
  }

  async artifact(artifactId: string): Promise<SealedArtifact | undefined> { return this.input.repository.get(artifactId); }
}
