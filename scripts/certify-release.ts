import { ReleaseCertificationController, RELEASE_WORKSPACE_ENV, releaseCandidateSha256, runReleaseCertification } from "../src/release/controller";
import { createNativeReleaseDiscoveryRegistry } from "../src/release/native-discovery";
import { loadCertifierConfig } from "../src/certification/config";
import { loadReleaseExecutionReadiness, loadReleaseExecutionSession } from "../src/release/production-execution";
import { preparePendingConsentLaunchDescriptors } from "../src/release/deployment/consent";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const defaultWorkspace = join(repositoryRoot, ".runtime", "release-certification", "native-discovery-v1");
const canonicalCandidatePath = join(repositoryRoot, "toolchains", "candidates", "initial.json");
const requireStatePrefix = "--require-state=";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function containedBy(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function controllerWorkspace(): string {
  const override = process.env[RELEASE_WORKSPACE_ENV];
  if (!override) return defaultWorkspace;
  if (!isAbsolute(override)) throw new Error("RELEASE_CERTIFICATION_WORKSPACE_REJECTED");
  const resolved = resolve(override);
  if (!containedBy(defaultWorkspace, resolved)) throw new Error("RELEASE_CERTIFICATION_WORKSPACE_REJECTED");
  return resolved;
}

/** Closed, finite review projection for the human approval boundary. Raw
 * config paths, native payloads, provider responses, tokens, and secrets are
 * intentionally never admitted to stdout. */
function reviewProjection(request: Awaited<ReturnType<ReleaseCertificationController["dryRun"]>>["authorizationRequest"]) {
  return Object.freeze({
    currency: request.currency,
    maximumAuthorizedCostMicros: request.maximumAuthorizedCostMicros,
    maximumRunDurationMs: request.maximumRunDurationMs,
    cleanupByMs: request.cleanupByMs,
    evidenceRetentionDays: request.evidenceRetentionDays,
    artifactRetentionDays: request.artifactRetentionDays,
    gcpEffects: request.gcpEffects,
    candidateSha256: request.candidateSha256,
    topologySha256: request.topologySha256,
    controllerStateSha256: request.controllerStateSha256,
    effectPlanSha256: request.effectPlanSha256,
    estimateSourceSha256: request.estimateSourceSha256 ?? null,
    expiresAtMs: request.expiresAtMs,
    scopes: request.providerScopes.map(({ provider, accountScopeSha256, projectScopeSha256 }) => ({ provider, accountScopeSha256, projectScopeSha256 })),
    priceLines: (request.priceLines ?? []).map(({ provider, sourceId, sourceDocumentSha256, quoteSha256, unit, quantityNanos, baseMicros, headroomBasisPoints, headroomMicros, maximumMicros, observedAtMs, freshUntilMs }) => ({ provider, sourceId, sourceDocumentSha256, quoteSha256, unit, quantityNanos, baseMicros, headroomBasisPoints, headroomMicros, maximumMicros, observedAtMs, freshUntilMs })),
  });
}

async function main(): Promise<number> {
  const allowed = new Set(["--candidate", "--resume", "--dry-run", "--status", "--request", "--receipt"]);
  const supplied = process.argv.slice(2);
  const requiredStateArguments = supplied.filter((value) => value.startsWith(requireStatePrefix));
  if (supplied.some((value) => value.startsWith("--") && !allowed.has(value) && !value.startsWith(requireStatePrefix)) || requiredStateArguments.length > 1 || requiredStateArguments.some((value) => value.length === requireStatePrefix.length)) {
    console.error("RELEASE_CERTIFICATION_ARGUMENT_REJECTED");
    return 1;
  }
  const candidatePath = option("--candidate");
  const requiredState = requiredStateArguments[0]?.slice(requireStatePrefix.length);
  const request = process.argv.includes("--request");
  const receipt = option("--receipt");
  const dryRun = process.argv.includes("--dry-run") || request || receipt !== undefined;
  const status = process.argv.includes("--status");
  const resume = option("--resume");
  if ((!status && !candidatePath) || (dryRun && status) || (requiredState !== undefined && !status) || (receipt !== undefined && !/^[a-f0-9]{64}$/iu.test(receipt)) || (resume !== undefined && !/^[a-f0-9]{64}$/iu.test(resume))) {
    console.error("RELEASE_CERTIFICATION_USAGE");
    return 1;
  }
  try {
    const workspace = controllerWorkspace();
    if (!status && !dryRun) {
      const config = await loadCertifierConfig();
      const session = await loadReleaseExecutionSession({ config, candidateSha256: await releaseCandidateSha256(candidatePath!), workspace });
      const result = await runReleaseCertification({ candidatePath: candidatePath!, workspace, dryRun: false, session });
      console.log(JSON.stringify({ status: result.state.status, candidateSha256: result.state.candidate.candidateSha256, topologySha256: result.state.topologySha256, stateSha256: result.state.stateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256 }));
      return result.state.status === "completed" ? 0 : 1;
    }
    const result = status
      ? await new ReleaseCertificationController({ candidatePath: candidatePath ?? canonicalCandidatePath, workspace }).status()
      : await runReleaseCertification({
        candidatePath,
        workspace,
        dryRun: true,
        providers: createNativeReleaseDiscoveryRegistry({ candidateSha256: await releaseCandidateSha256(candidatePath!) }),
      });
    if (!result) {
      console.error("RELEASE_CONTROLLER_STATUS_UNAVAILABLE");
      return 1;
    }
    if (requiredState !== undefined && requiredState !== result.state.status) throw new Error("RELEASE_CERTIFICATION_STATE_MISMATCH");
    if (resume && resume.toLowerCase() !== result.state.stateSha256 && resume.toLowerCase() !== result.authorizationRequest.resumeStateSha256) throw new Error("RELEASE_CERTIFICATION_RESUME_MISMATCH");
    if (receipt && receipt.toLowerCase() !== result.authorizationRequest.expectedReceiptSha256) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
    const config = await loadCertifierConfig();
    const candidateSha256 = result.state.candidate.candidateSha256;
    const executionReadiness = config.mode === "protected" && config.credentials === "configured"
      ? await loadReleaseExecutionReadiness({ config, candidateSha256, workspace })
      : null;
    console.log(JSON.stringify(request || receipt ? {
      progress: result.state.status,
      authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256,
      expectedReceiptSha256: result.authorizationRequest.expectedReceiptSha256,
      receiptValidated: receipt === undefined ? false : true,
      consentStatus: "consent_pending",
      consentLaunches: preparePendingConsentLaunchDescriptors({ authorizationRequest: result.authorizationRequest }),
      review: reviewProjection(result.authorizationRequest),
      executionReadiness,
    } : { status: result.state.status, candidateSha256: result.state.candidate.candidateSha256, topologySha256: result.state.topologySha256, stateSha256: result.state.stateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256, expectedReceiptSha256: result.authorizationRequest.expectedReceiptSha256, controllerStateSha256: result.authorizationRequest.controllerStateSha256, resumeStateSha256: result.authorizationRequest.controllerStateSha256 }));
    return status && requiredState !== undefined ? 0 : result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "RELEASE_CONTROLLER_FAILED");
    return 1;
  }
}

process.exitCode = await main();
