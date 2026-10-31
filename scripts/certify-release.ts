import { prepareReleaseWorkspace, ReleaseCertificationController, RELEASE_WORKSPACE_ENV, releaseCandidateSha256, runReleaseCertification, type ReleaseCertificationResult } from "../src/release/controller";
import { createNativeReleaseDiscoveryRegistry } from "../src/release/native-discovery";
import { createReleaseControllerProviderRegistry } from "../src/release/native-registry";
import { loadFinalizedReleaseVerificationAuthority } from "../src/release/production-execution";
import { CERTIFIER_CONFIG_SHA256_ENV, loadCertifierConfig } from "../src/certification/config";
import { loadReleaseExecutionReadiness, loadReleaseExecutionSession, loadReleaseFundingFeePolicyProjection } from "../src/release/production-execution";
import { preparePreApprovalPrerequisites } from "../src/release/deployment/consent";
import { pendingOperatorFundingReadiness, releaseCertificationFundingReadiness, validateOperatorFundingReadiness } from "../src/release/deployment/operator-funding";
import {
  createBunLocalFundingLoopbackPort,
  createFileOperatorFundingReadinessStore,
  createLocalOperatorFundingSetup,
  createMacOsBrowserPort,
  createMacOsKeychainSecretStore,
} from "../src/release/deployment/local-setup";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCertificationBudgetCatalog, createProductionLiveCostCatalog } from "../src/release/costs/production-catalog";
import { createApplicationDefaultTokenPort, createOfficialPricingSources, PRODUCTION_CATALOG_SELECTORS } from "../src/release/costs/official-sources";
import { createOfficialFundingRailFeePort, type SealedFundingFeePolicyProjection } from "../src/release/costs/funding-fees";
import { RELEASE_TOPOLOGY_QUANTITY_CONTRACT } from "../src/release/topology";
import { RELEASE_COST_FAMILIES, type LiveCostCatalogPort } from "../src/release/costs/live-estimator";
import { createDeploymentExecutionConfig } from "../src/release/deployment/config";
import { loadPreparedCollectorPreapproval, materializePreapproval } from "../src/release/preapproval-materializer";
import { prepareProductionCollectorImage, type PreparedCollectorImage } from "../src/release/collector-image";
import { validateAuthorizationReceipt } from "../src/release/authorization";
import { verifyFinalizedRelease } from "../src/release/verify-finalization";

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

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `--receipt` is an opaque controller receipt ID, never receipt JSON. The
 * canonical structured receipt must already have been written by the sole
 * consent/controller path under the confined workspace. */
async function readControllerReceipt(workspace: string, receiptSha256: string): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/iu.test(receiptSha256)) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
  try {
    return JSON.parse(await readFile(join(workspace, "authorization-receipts", `${receiptSha256.toLowerCase()}.json`), "utf8"));
  } catch {
    throw new Error("RELEASE_AUTHORIZATION_RECEIPT_UNAVAILABLE");
  }
}

/** Read-only verification is deliberately kept on the product CLI so the
 * operator lifecycle has one stable root. The bundle remains unable to choose
 * its verifier: only the configured, pinned trust root is accepted. */
async function verifyImmutableBundle(bundleSha256: string) {
  if (!/^[a-f0-9]{64}$/u.test(bundleSha256)) throw new Error("RELEASE_CERTIFICATION_USAGE");
  const config = await loadCertifierConfig();
  if (config.mode !== "protected") throw new Error("TRUST_ROOT_CONFIGURATION_INVALID");
  const workspace = controllerWorkspace();
  const authority = config.trustRoot ? { config, configSha256: process.env[CERTIFIER_CONFIG_SHA256_ENV]! } : await loadFinalizedReleaseVerificationAuthority({ config, workspace, bundleSha256 });
  return verifyFinalizedRelease({ workspace, bundleSha256, ...authority });
}

/** Materialization is a bounded local write of measured, redacted readiness
 * bytes.  The operator cannot supply any portion of this input: the protected
 * configuration itself is hash-pinned, while candidate/topology/state and
 * price facts come from the controller's no-effect dry run. */
async function materializeRequestPreapproval(input: Readonly<{
  candidateSha256: string;
  topologySha256: string;
  facts: readonly unknown[];
  authorization: Awaited<ReturnType<ReleaseCertificationController["dryRun"]>>["authorizationRequest"];
  workspace: string;
  collector: PreparedCollectorImage;
}>) {
  const certifier = await loadCertifierConfig();
  if (certifier.mode !== "protected" || certifier.credentials !== "configured" || !certifier.releaseExecution || !certifier.controller) {
    throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED");
  }
  const execution = certifier.releaseExecution;
  const deployment = createDeploymentExecutionConfig(JSON.parse(await readFile(execution.configPath, "utf8")));
  if (deployment.candidateSha256 !== input.candidateSha256 || deployment.sourceRevision !== certifier.controller.sourceRevision || deployment.factoryModuleSha256 !== execution.sha256 || deployment.publicSettings.regions.length !== 2) {
    throw new Error("PREAPPROVAL_DEPLOYMENT_BINDING_REJECTED");
  }
  const catalogSha256 = await sha256Json(input.facts);
  const providerScopesSha256 = await sha256Json(input.authorization.providerScopes);
  return materializePreapproval({
    workspace: input.workspace,
    repositoryRoot: execution.root,
    candidateId: input.candidateSha256,
    source: { sourceRevision: certifier.controller.sourceRevision, sourceSha256: certifier.controller.sourceSha256 },
    topology: { candidateSha256: input.candidateSha256, topologySha256: input.topologySha256 },
    catalog: { catalogSha256, topologySha256: input.topologySha256 },
    authorization: {
      authorizationRequestSha256: input.authorization.authorizationRequestSha256,
      controllerStateSha256: input.authorization.controllerStateSha256,
      effectPlanSha256: input.authorization.effectPlanSha256,
      providerScopesSha256,
      maximumAuthorizedCostMicros: input.authorization.maximumAuthorizedCostMicros,
      cleanupByMs: input.authorization.cleanupByMs,
      expiresAtMs: input.authorization.expiresAtMs,
    },
    publicSettings: {
      regions: deployment.publicSettings.regions as [string, string],
      maximumRunDurationMs: deployment.publicSettings.maximumRunDurationMs,
      retentionDays: deployment.publicSettings.retentionDays,
    },
    opaqueReferenceNames: Object.keys(deployment.secretReferences).sort(),
    collector: input.collector,
    factory: {
      root: execution.root,
      modulePath: execution.modulePath,
      moduleSha256: execution.sha256,
      configPath: execution.configPath,
      configSha256: execution.configSha256,
    },
  });
}

/** A local, no-network preparation boundary. The output is a retained OCI
 * layout and planned immutable registry reference, not an upload claim. */
async function prepareCollectorPreapproval(input: Readonly<{ candidateSha256: string; workspace: string }>): Promise<PreparedCollectorImage> {
  const certifier = await loadCertifierConfig();
  if (certifier.mode !== "protected" || certifier.credentials !== "configured" || !certifier.releaseExecution || !certifier.controller) throw new Error("RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED");
  const execution = certifier.releaseExecution;
  const deployment = createDeploymentExecutionConfig(JSON.parse(await readFile(execution.configPath, "utf8")));
  if (deployment.candidateSha256 !== input.candidateSha256 || deployment.sourceRevision !== certifier.controller.sourceRevision || !deployment.collectorRegistryTarget) throw new Error("PREAPPROVAL_COLLECTOR_CONFIGURATION_REQUIRED");
  return prepareProductionCollectorImage({
    repositoryRoot: execution.root,
    registryTarget: deployment.collectorRegistryTarget,
    artifactDirectory: join(input.workspace, "collector-oci"),
  });
}

/** Build the controller-owned, read-only price discovery path. It neither
 * selects a project nor creates a billing account; ADC is used only as an
 * opaque request header for the public Cloud Billing catalog. */
function currentOfficialCostCatalog(policy: SealedFundingFeePolicyProjection) {
  const official = createOfficialPricingSources({
    fetch,
    adc: createApplicationDefaultTokenPort(),
    google: { selectors: PRODUCTION_CATALOG_SELECTORS },
    workers: {
      modal: { cpuCores: 2, memoryGiB: 2, unit: "worker-100-seconds" },
      fly: { preset: "shared-cpu-1x", memory: "1GB", unit: "worker-100-seconds" },
    },
  });
  return createProductionLiveCostCatalog({ google: official.google, sources: official.sources, vertex: official.sources, fundingRailFees: createOfficialFundingRailFeePort({ policy, readUsdSatConversion: () => official.sources.readUsdSatConversion() }), quantityContract: RELEASE_TOPOLOGY_QUANTITY_CONTRACT });
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
  const allowed = new Set(["--candidate", "--resume", "--dry-run", "--status", "--request", "--setup", "--receipt", "--verify-bundle"]);
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
  const verifyBundle = option("--verify-bundle");
  const dryRun = process.argv.includes("--dry-run") || request || receipt !== undefined;
  const status = process.argv.includes("--status");
  const resume = option("--resume");
  if ((!status && !candidatePath && !verifyBundle) || (dryRun && status) || (setupRequested && (status || request || receipt !== undefined || resume !== undefined || process.argv.includes("--dry-run"))) || (verifyBundle !== undefined && (status || candidatePath || request || receipt !== undefined || resume !== undefined || setupRequested || process.argv.includes("--dry-run"))) || (requiredState !== undefined && !status) || (receipt !== undefined && !/^[a-f0-9]{64}$/iu.test(receipt)) || (resume !== undefined && !/^[a-f0-9]{64}$/iu.test(resume))) {
    console.error("RELEASE_CERTIFICATION_USAGE");
    return 1;
  }
  try {
    if (verifyBundle) {
      const decision = await verifyImmutableBundle(verifyBundle);
      console.log(JSON.stringify({ progress: decision.status === "promoted" ? "bundle_verified" : "bundle_blocked", status: decision.status, bundleSha256: decision.bundleSha256, evidenceSha256: decision.evidenceSha256, cleanup: decision.cleanup }));
      return decision.status === "promoted" ? 0 : 1;
    }
    const workspace = controllerWorkspace();
    const workspaceCapability = await prepareReleaseWorkspace(workspace);
    /* Resolve an opaque receipt reference before any candidate discovery. A
     * nonexistent ID is not allowed to trigger pricing/provider reads just to
     * learn that it cannot authorize anything. Structural validation remains
     * below, against the freshly reconstructed controller request. */
    const controllerReceipt = receipt ? await readControllerReceipt(workspace, receipt) : undefined;
    if (setupRequested) {
      const candidateSha256 = await releaseCandidateSha256(candidatePath!);
      const execution = await executionReadinessProjection({ candidateSha256, workspace });
      if (execution.status !== "ready") {
        console.log(JSON.stringify({ progress: "preapproval_blocked", candidateSha256, readiness: { execution }, zeroEffectCounters: zeroEffectCounters() }));
        return 1;
      }
      try {
        const config = await loadCertifierConfig();
        const policy = await loadReleaseFundingFeePolicyProjection({ config, candidateSha256, workspace });
        await currentOfficialCostCatalog(policy).listPriceFacts({ providers: RELEASE_COST_FAMILIES });
      }
      catch (error) {
        const reasonCode = error instanceof Error && /^[A-Z][A-Z0-9_]{2,95}$/u.test(error.message) ? error.message : "OFFICIAL_PRICE_DISCOVERY_FAILED";
        console.log(JSON.stringify({ progress: "preapproval_blocked", candidateSha256, readiness: { execution, pricing: { status: "blocked", reasonCode } }, zeroEffectCounters: zeroEffectCounters() }));
        return 1;
      }
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
      const result = await runReleaseCertification({ candidatePath: candidatePath!, workspace, workspaceCapability, dryRun: false, session });
      console.log(JSON.stringify({ status: result.state.status, candidateSha256: result.state.candidate.candidateSha256, topologySha256: result.state.topologySha256, stateSha256: result.state.stateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256 }));
      return result.state.status === "completed" ? 0 : 1;
    }
    const candidateSha256 = !status ? await releaseCandidateSha256(candidatePath!) : undefined;
    // Implementation comes first. An incomplete factory must not ask the
    // operator to fund, log in, or approve a candidate it cannot execute.
    let preparedCatalog: LiveCostCatalogPort | undefined;
    let preparedPriceFacts: readonly unknown[] | undefined;
    let preparedCollector: PreparedCollectorImage | undefined;
    if (request) {
      const execution = await executionReadinessProjection({ candidateSha256: candidateSha256!, workspace });
      if (execution.status !== "ready") {
        console.log(JSON.stringify({ progress: "preapproval_blocked", candidateSha256, readiness: { execution }, zeroEffectCounters: zeroEffectCounters() }));
        return 1;
      }
      try {
        preparedCollector = await prepareCollectorPreapproval({ candidateSha256: candidateSha256!, workspace });
        const config = await loadCertifierConfig();
        const policy = await loadReleaseFundingFeePolicyProjection({ config, candidateSha256: candidateSha256!, workspace });
        const facts = await currentOfficialCostCatalog(policy).listPriceFacts({ providers: RELEASE_COST_FAMILIES });
        preparedPriceFacts = facts;
        preparedCatalog = Object.freeze({ async listPriceFacts() { return facts; } });
      } catch (error) {
        const reasonCode = error instanceof Error && /^[A-Z][A-Z0-9_]{2,95}$/u.test(error.message) ? error.message : "OFFICIAL_PRICE_DISCOVERY_FAILED";
        console.log(JSON.stringify({ progress: "preapproval_blocked", candidateSha256, readiness: { execution, pricing: { status: "blocked", reasonCode } }, zeroEffectCounters: zeroEffectCounters() }));
        return 1;
      }
    }
    if (receipt) {
      const receiptRequestSha256 = controllerReceipt && typeof controllerReceipt === "object" && !Array.isArray(controllerReceipt)
        ? (controllerReceipt as { authorizationRequestSha256?: unknown }).authorizationRequestSha256
        : undefined;
      if (typeof receiptRequestSha256 !== "string") throw new Error("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
      preparedCollector = await loadPreparedCollectorPreapproval({ workspace, candidateId: candidateSha256!, authorizationRequestSha256: receiptRequestSha256 });
    }
    const funding = !status ? await operatorFundingReadinessProjection(workspace) : undefined;
    const certificationFunding = funding ? await releaseCertificationFundingReadiness(funding) : undefined;
    const fundingPrerequisites = certificationFunding?.status === "pending" ? undefined : certificationFunding;
    let result: ReleaseCertificationResult | undefined;
    try {
      result = status
        ? await new ReleaseCertificationController({ candidatePath: candidatePath ?? canonicalCandidatePath, workspace, workspaceCapability }).status()
        : await runReleaseCertification({
          candidatePath: candidatePath!,
          workspace,
          workspaceCapability,
          dryRun: true,
          providers: await preapprovalDiscoveryRegistry({ candidateSha256: candidateSha256!, workspace }),
          // A project maximum-spend policy is useful only for local dry-run
          // bounds. It is not vendor provenance and must never authorize a
          // `--request`; that path requires injected fresh official facts.
          ...(request ? { costCatalog: preparedCatalog! } : { costCatalog: createCertificationBudgetCatalog({ quantityContract: RELEASE_TOPOLOGY_QUANTITY_CONTRACT }) }),
          requireCurrentPriceCatalog: true,
          operatorFundingReadiness: certificationFunding,
          ...(preparedCollector ? { collectorImage: preparedCollector } : {}),
        });
    } catch (error) {
      if (!status && error instanceof Error && ["RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED", "ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED"].includes(error.message)) {
        console.log(JSON.stringify({
          progress: "preapproval_blocked",
          candidateSha256,
          readiness: {
            capabilityDiscovery: { status: "completed", mode: "read_only" },
            pricing: { status: "blocked", reasonCode: error.message },
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
    if (resume && resume.toLowerCase() !== result.state.stateSha256 && resume.toLowerCase() !== result.authorizationRequest.controllerStateSha256) throw new Error("RELEASE_CERTIFICATION_RESUME_MISMATCH");
    let resolvedReceipt: unknown;
    if (receipt) {
      resolvedReceipt = controllerReceipt;
      const validated = await validateAuthorizationReceipt({ request: result.authorizationRequest, receipt: resolvedReceipt, nowMs: Date.now() });
      if (validated.authorizationReceiptSha256 !== receipt.toLowerCase()) throw new Error("RELEASE_AUTHORIZATION_RECEIPT_INVALID");
    }
    const resolvedCandidateSha256 = result.state.candidate.candidateSha256;
    const executionReadiness = await executionReadinessProjection({ candidateSha256: resolvedCandidateSha256, workspace });
    if (request && executionReadiness.status !== "ready") {
      console.log(JSON.stringify({
        progress: "preapproval_blocked",
        candidateSha256: resolvedCandidateSha256,
        readiness: { capabilityDiscovery: { status: "completed", mode: "read_only" }, pricing: { status: "completed", mode: "read_only" }, execution: executionReadiness },
        prerequisites: preparePreApprovalPrerequisites({ funding: certificationFunding! }),
      }));
      return 1;
    }
    const materialization = request
      ? await materializeRequestPreapproval({ candidateSha256: resolvedCandidateSha256, topologySha256: result.state.topologySha256, facts: preparedPriceFacts!, authorization: result.authorizationRequest, workspace, collector: preparedCollector! })
      : undefined;
    if (receipt) {
      /* No endpoint/provider object is accepted on the command line. Only a
       * controller-stored receipt is resolved, validated, and carried into
       * the pinned factory. runReleaseCertification then revalidates it at
       * the session and every protected operation boundary. */
      const config = await loadCertifierConfig();
      const session = await loadReleaseExecutionSession({
        config,
        candidateSha256: resolvedCandidateSha256,
        workspace,
        authorization: { request: result.authorizationRequest, receipt: resolvedReceipt },
      });
      const live = await runReleaseCertification({ candidatePath: candidatePath!, workspace, workspaceCapability, dryRun: false, session, collectorImage: preparedCollector! });
      console.log(JSON.stringify({
        progress: live.state.status,
        candidateSha256: live.state.candidate.candidateSha256,
        topologySha256: live.state.topologySha256,
        stateSha256: live.state.stateSha256,
        authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256,
        authorizationReceiptSha256: receipt.toLowerCase(),
        bundleSha256: live.finalization?.bundleSha256 ?? null,
        verificationConfigSha256: live.finalization?.verificationConfig?.sha256 ?? null,
      }));
      return live.state.status === "completed" ? 0 : 1;
    }
    /* Funding consent is the only remaining operator action, and is requested
     * only after the normal candidate → implementation → official price →
     * controller-request → sealed-materialization path has completed. This
     * preserves a reviewable request/artifact even when NWC/Cashu setup is
     * genuinely absent; it never opens a wallet or creates funding here. */
    if (request && certificationFunding?.status !== "ready") {
      console.log(JSON.stringify({
        progress: "local_setup_required",
        setup: localFundingSetupDescriptor({ candidateSha256: resolvedCandidateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256 }),
        review: reviewProjection(result.authorizationRequest),
        executionReadiness,
        materialization: { materializationId: materialization!.materializationId, artifactSha256: materialization!.artifactSha256 },
        zeroEffectCounters: zeroEffectCounters(),
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
      ...(materialization ? { materialization: { materializationId: materialization.materializationId, artifactSha256: materialization.artifactSha256 } } : {}),
      zeroEffectCounters: zeroEffectCounters(),
    } : { status: result.state.status, candidateSha256: result.state.candidate.candidateSha256, topologySha256: result.state.topologySha256, stateSha256: result.state.stateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256, expectedReceiptSha256: result.authorizationRequest.expectedReceiptSha256, controllerStateSha256: result.authorizationRequest.controllerStateSha256, resumeStateSha256: result.authorizationRequest.controllerStateSha256 }));
    return status && requiredState !== undefined ? 0 : result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "RELEASE_CONTROLLER_FAILED");
    return 1;
  }
}

process.exitCode = await main();
