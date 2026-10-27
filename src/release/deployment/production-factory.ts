import type { ReleaseExecutionSession } from "../controller";
import type { ReleaseExecutionFactoryInput } from "../production-execution";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../native-registry";
import { PROTECTED_SUITES } from "../../certification/runner";
import { createDeploymentReleaseExecutionSession, type DeploymentFactoryRuntime } from "./factory";
import {
  isProductionOperationalDependencies,
  type ProductionOperationalDependencies,
} from "./production-dependencies";

/** Hash-pinned receipt execution imports this named factory from the same
 * production module as the static readiness inventory. The implementation is
 * intentionally mounted/runtime-owned: preapproval only reads this export and
 * never constructs it. */
export { createProductionCertificationSessionMaterial } from "../../production/mounted-session-material";

/**
 * Names are controller-owned opaque locators, never environment variable names
 * or secret values.  NWC Lightning and funded Cashu remain independent
 * prerequisites; owner NIP-46 is deliberately not a pre-approval input.
 */
export const PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES = Object.freeze([
  "googleApplicationDefaultCredentials",
  "modalApiAccess",
  "flyApiAccess",
  "contextVmServiceKey",
  "nwcLightningConnection",
  "cashuFundedWallet",
  "vertexModelCredential",
  "compatibleHostAccess",
  "attestationRelayKey",
] as const);

const REQUIRED = new Set<string>(PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES);

export const releaseReadiness = Object.freeze({
  providerFamilies: Object.freeze([...RELEASE_PRODUCTION_PROVIDER_IDS]),
  protectedSuites: Object.freeze([...PROTECTED_SUITES]),
  materialization: true as const,
  workerSelection: true as const,
  protectedVerification: true as const,
  finalization: true as const,
  actualCost: true as const,
  cleanupOwnership: true as const,
  authorizedExecution: "dependency_injection_required" as const,
});

export type ProductionFactoryReadiness = Readonly<{
  ready: boolean;
  blockers: readonly string[];
}>;

/** Finite, authority-free readiness is used before the approval review. */
export function assessProductionFactoryReadiness(input: ReleaseExecutionFactoryInput, dependencies?: unknown): ProductionFactoryReadiness {
  const blockers = [
    ...PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES.filter((name) => !(name in input.deploymentConfig.secretReferences)).map((name) => `SECRET_REFERENCE_REQUIRED:${name}`),
    ...(input.deploymentConfig.publicSettings.regions.length < 2 ? ["REGION_TOPOLOGY_REQUIRED"] : []),
    ...(dependencies === undefined ? ["AUTHORIZED_EXECUTION_PORTS_REQUIRED"] : !isProductionOperationalDependencies(dependencies) ? ["PRODUCTION_OPERATIONAL_DEPENDENCIES_INVALID"] : []),
  ];
  return Object.freeze({ ready: blockers.length === 0, blockers: Object.freeze(blockers) });
}

function runtime(dependencies: ProductionOperationalDependencies): DeploymentFactoryRuntime {
  return Object.freeze({
    registry: dependencies.registry,
    prepareAuthorizedExecution: dependencies.prepareAuthorizedExecution,
  });
}

/**
 * This composes the sole pre-approval session. Construction has no transport,
 * model, wallet, signer, browser, CLI, relay, or provider invocation. Effect
 * methods remain unreachable until a receipt-bound, project-owned dependency
 * graph is supplied. Construction itself remains effect-free.
 */
export function createProductionReleaseExecutionSession(input: ReleaseExecutionFactoryInput, dependencies?: unknown): ReleaseExecutionSession {
  const readiness = assessProductionFactoryReadiness(input, dependencies);
  if (!readiness.ready) throw new Error(`PRODUCTION_FACTORY_READINESS_BLOCKED:${readiness.blockers.join(",")}`);
  if (Object.keys(input.deploymentConfig.secretReferences).some((name) => !REQUIRED.has(name))) {
    throw new Error("PRODUCTION_FACTORY_SECRET_REFERENCE_SET_INVALID");
  }
  if (!isProductionOperationalDependencies(dependencies)) throw new Error("PRODUCTION_FACTORY_OPERATIONAL_DEPENDENCIES_REQUIRED");
  return createDeploymentReleaseExecutionSession(input, runtime(dependencies));
}
