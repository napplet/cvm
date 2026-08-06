import { ReleaseCertificationController, RELEASE_WORKSPACE_ENV, releaseCandidateSha256, runReleaseCertification } from "../src/release/controller";
import { createNativeReleaseDiscoveryRegistry } from "../src/release/native-discovery";
import { createReleaseControllerProviderRegistry } from "../src/release/native-registry";
import { loadCertifierConfig } from "../src/certification/config";
import { loadReleaseExecutionReadiness, loadReleaseExecutionSession } from "../src/release/production-execution";
import { preparePreApprovalPrerequisites } from "../src/release/deployment/consent";
import { pendingOperatorFundingReadiness, validateOperatorFundingReadiness } from "../src/release/deployment/operator-funding";
import {
  createBunLocalFundingLoopbackPort,
  createFileOperatorFundingReadinessStore,
  createLocalOperatorFundingSetup,
  createMacOsBrowserPort,
  createMacOsKeychainSecretStore,
} from "../src/release/deployment/local-setup";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCertificationBudgetCatalog } from "../src/release/costs/production-catalog";
import { RELEASE_TOPOLOGY_QUANTITY_CONTRACT } from "../src/release/topology";

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

function reasonCode(error: unknown, fallback: "RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED" | "RELEASE_PRODUCTION_EXECUTION_READINESS_INVALID"): string {
  return error instanceof Error && /^(?:RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED|RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID|RELEASE_PRODUCTION_EXECUTION_FACTORY_INVALID|RELEASE_PRODUCTION_EXECUTION_READINESS_INVALID)$/u.test(error.message)
    ? error.message
    : fallback;
}

async function executionReadinessProjection(input: Readonly<{ candidateSha256: string; workspace: string }>) {
  try {
    const config = await loadCertifierConfig();
    const readiness = await loadReleaseExecutionReadiness({ config, candidateSha256: input.candidateSha256, workspace: input.workspace });
    return Object.freeze({ status: readiness.blockers?.length ? "blocked" as const : "ready" as const, ...readiness });
  } catch (error) {
    return Object.freeze({ status: "blocked" as const, reasonCode: reasonCode(error, "RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED") });
  }
}

/** Plan 07-20 owns writing this local, mode-0700 workspace record after a
 * macOS loopback/keychain flow completes. It contains locators and hashes
 * only. Absence is a genuine setup prerequisite, never an invitation to put
 * NWC/Cashu material in the CLI, environment, or request output. */
async function operatorFundingReadinessProjection(workspace: string) {
  try {
    return await validateOperatorFundingReadiness(JSON.parse(await readFile(join(workspace, "operator-funding-readiness.json"), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return pendingOperatorFundingReadiness();
    throw new Error("OPERATOR_FUNDING_READINESS_INVALID");
  }
}

function localFundingSetupDescriptor(input: Readonly<{ candidateSha256: string; authorizationRequestSha256?: string }>) {
  return Object.freeze({
    kind: "local_operator_funding_setup" as const,
    status: "action_required" as const,
    plan: "07-20" as const,
    candidateSha256: input.candidateSha256,
    ...(input.authorizationRequestSha256 ? { authorizationRequestSha256: input.authorizationRequestSha256 } : {}),
    rails: ["nwc_lightning", "cashu"] as const,
  });
}

/** Counter-only proof of the preapproval boundary. These counters describe
 * effect-capable families, not credentials or provider responses. Every one
 * remains zero until the separate receipt-bound Plan 07-26 executor runs. */
function zeroEffectCounters() {
  return Object.freeze({
    providerPlan: 0, providerApply: 0, providerObserve: 0, providerCleanup: 0,
    workers: 0, model: 0, wallet: 0, signer: 0, host: 0, cliUpload: 0,
    relays: 0, suites: 0, finalizer: 0, evaluator: 0, bundle: 0,
    promotion: 0, destructiveCleanup: 0,
  });
}

/** Prefer the precise pinned execution session for read-only preapproval
 * discovery. A missing protected config remains a bounded blocker and falls
 * back to the existing no-credential registry; neither branch can plan,
 * apply, observe, clean up, launch a worker, or request a signature. */
async function preapprovalDiscoveryRegistry(input: Readonly<{ candidateSha256: string; workspace: string }>) {
  try {
    const config = await loadCertifierConfig();
    const session = await loadReleaseExecutionSession({ config, candidateSha256: input.candidateSha256, workspace: input.workspace });
    return createReleaseControllerProviderRegistry(session.registry);
  } catch {
    return createNativeReleaseDiscoveryRegistry({ candidateSha256: input.candidateSha256 });
  }
}

async function main(): Promise<number> {
  const allowed = new Set(["--candidate", "--resume", "--dry-run", "--status", "--request", "--setup", "--receipt"]);
  const supplied = process.argv.slice(2);
  const requiredStateArguments = supplied.filter((value) => value.startsWith(requireStatePrefix));
  if (supplied.some((value) => value.startsWith("--") && !allowed.has(value) && !value.startsWith(requireStatePrefix)) || requiredStateArguments.length > 1 || requiredStateArguments.some((value) => value.length === requireStatePrefix.length)) {
    console.error("RELEASE_CERTIFICATION_ARGUMENT_REJECTED");
    return 1;
  }
  const candidatePath = option("--candidate");
  const requiredState = requiredStateArguments[0]?.slice(requireStatePrefix.length);
  const request = process.argv.includes("--request");
  const setupRequested = process.argv.includes("--setup");
  const receipt = option("--receipt");
  const dryRun = process.argv.includes("--dry-run") || request || receipt !== undefined;
  const status = process.argv.includes("--status");
  const resume = option("--resume");
  if ((!status && !candidatePath) || (dryRun && status) || (setupRequested && (status || request || receipt !== undefined || resume !== undefined || process.argv.includes("--dry-run"))) || (requiredState !== undefined && !status) || (receipt !== undefined && !/^[a-f0-9]{64}$/iu.test(receipt)) || (resume !== undefined && !/^[a-f0-9]{64}$/iu.test(resume))) {
    console.error("RELEASE_CERTIFICATION_USAGE");
    return 1;
  }
  try {
    const workspace = controllerWorkspace();
    if (setupRequested) {
      const candidateSha256 = await releaseCandidateSha256(candidatePath!);
      const setup = await createLocalOperatorFundingSetup({
        candidateSha256,
        loopback: createBunLocalFundingLoopbackPort(),
        browser: createMacOsBrowserPort(),
        secrets: createMacOsKeychainSecretStore(),
        readinessStore: createFileOperatorFundingReadinessStore(join(workspace, "operator-funding-readiness.json")),
      });
      await setup.launch();
      console.log(JSON.stringify({ progress: "local_setup_opened", setup: setup.descriptor(), zeroEffectCounters: zeroEffectCounters() }));
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const readiness = await setup.readiness();
        if (readiness.status === "ready") {
          console.log(JSON.stringify({ progress: "local_setup_complete", readiness: { status: "ready", readinessSha256: readiness.readinessSha256, rails: readiness.rails.map(({ rail, capabilitySha256, accountScopeSha256, expiresAtMs, status }) => ({ rail, capabilitySha256, accountScopeSha256, expiresAtMs, status })) }, zeroEffectCounters: zeroEffectCounters() }));
          return 0;
        }
        await Bun.sleep(250);
      }
      console.error("LOCAL_FUNDING_SESSION_EXPIRED");
      return 1;
    }
    if (!status && !dryRun) {
      const config = await loadCertifierConfig();
      const session = await loadReleaseExecutionSession({ config, candidateSha256: await releaseCandidateSha256(candidatePath!), workspace });
      const result = await runReleaseCertification({ candidatePath: candidatePath!, workspace, dryRun: false, session });
      console.log(JSON.stringify({ status: result.state.status, candidateSha256: result.state.candidate.candidateSha256, topologySha256: result.state.topologySha256, stateSha256: result.state.stateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256 }));
      return result.state.status === "completed" ? 0 : 1;
    }
    const candidateSha256 = !status ? await releaseCandidateSha256(candidatePath!) : undefined;
    const funding = !status ? await operatorFundingReadinessProjection(workspace) : undefined;
    const fundingPrerequisites = funding?.status === "pending" ? undefined : funding;
    // Funding setup is a local, effect-free prerequisite. Surface it before
    // attempting remote catalog reads so a transient pricing outage cannot
    // hide the one concrete action the operator can complete locally.
    if (request && funding?.status !== "ready") {
      console.log(JSON.stringify({
        progress: "local_setup_required",
        setup: localFundingSetupDescriptor({ candidateSha256: candidateSha256! }),
        zeroEffectCounters: zeroEffectCounters(),
      }));
      return 1;
    }
    let result: Awaited<ReturnType<typeof runReleaseCertification>> | undefined;
    try {
      result = status
        ? await new ReleaseCertificationController({ candidatePath: candidatePath ?? canonicalCandidatePath, workspace }).status()
        : await runReleaseCertification({
          candidatePath: candidatePath!,
          workspace,
          dryRun: true,
          providers: await preapprovalDiscoveryRegistry({ candidateSha256: candidateSha256!, workspace }),
          costCatalog: createCertificationBudgetCatalog({ quantityContract: RELEASE_TOPOLOGY_QUANTITY_CONTRACT }),
          requireCurrentPriceCatalog: true,
          operatorFundingReadiness: funding,
        });
    } catch (error) {
      if (!status && error instanceof Error && error.message === "RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED") {
        console.log(JSON.stringify({
          progress: "preapproval_blocked",
          candidateSha256,
          readiness: {
            capabilityDiscovery: { status: "completed", mode: "read_only" },
            pricing: { status: "blocked", reasonCode: "RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED" },
            execution: await executionReadinessProjection({ candidateSha256: candidateSha256!, workspace }),
          },
          prerequisites: preparePreApprovalPrerequisites(fundingPrerequisites ? { funding: fundingPrerequisites } : undefined),
        }));
        return 1;
      }
      throw error;
    }
    if (!result) {
      console.error("RELEASE_CONTROLLER_STATUS_UNAVAILABLE");
      return 1;
    }
    if (requiredState !== undefined && requiredState !== result.state.status) throw new Error("RELEASE_CERTIFICATION_STATE_MISMATCH");
    if (resume && resume.toLowerCase() !== result.state.stateSha256 && resume.toLowerCase() !== result.authorizationRequest.resumeStateSha256) throw new Error("RELEASE_CERTIFICATION_RESUME_MISMATCH");
    if (receipt && receipt.toLowerCase() !== result.authorizationRequest.expectedReceiptSha256) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
    const resolvedCandidateSha256 = result.state.candidate.candidateSha256;
    const executionReadiness = await executionReadinessProjection({ candidateSha256: resolvedCandidateSha256, workspace });
    if (request && executionReadiness.status !== "ready") {
      console.log(JSON.stringify({
        progress: "preapproval_blocked",
        candidateSha256: resolvedCandidateSha256,
        readiness: { capabilityDiscovery: { status: "completed", mode: "read_only" }, pricing: { status: "completed", mode: "read_only" }, execution: executionReadiness },
        prerequisites: preparePreApprovalPrerequisites({ funding: funding! }),
      }));
      return 1;
    }
    console.log(JSON.stringify(request || receipt ? {
      progress: result.state.status,
      authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256,
      expectedReceiptSha256: result.authorizationRequest.expectedReceiptSha256,
      receiptValidated: receipt === undefined ? false : true,
      approvalStatus: "prerequisites_pending",
      prerequisites: preparePreApprovalPrerequisites(fundingPrerequisites ? { funding: fundingPrerequisites } : undefined),
      review: reviewProjection(result.authorizationRequest),
      executionReadiness,
      zeroEffectCounters: zeroEffectCounters(),
    } : { status: result.state.status, candidateSha256: result.state.candidate.candidateSha256, topologySha256: result.state.topologySha256, stateSha256: result.state.stateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256, expectedReceiptSha256: result.authorizationRequest.expectedReceiptSha256, controllerStateSha256: result.authorizationRequest.controllerStateSha256, resumeStateSha256: result.authorizationRequest.controllerStateSha256 }));
    return status && requiredState !== undefined ? 0 : result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "RELEASE_CONTROLLER_FAILED");
    return 1;
  }
}

process.exitCode = await main();
