import type { ReleaseExecutionSession } from "../controller";
import type { ReleaseExecutionFactoryInput } from "../production-execution";
import { RELEASE_PRODUCTION_PROVIDER_IDS, createNativeReleaseProviderRegistry } from "../native-registry";
import { createDeploymentReleaseExecutionSession, type DeploymentFactoryRuntime } from "./factory";

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
  protectedSuites: Object.freeze([
    "admission", "telemetry", "chaos", "durability", "security-host", "supply-chain", "ContextVM-payment-model", "publication",
  ]),
  materialization: true as const,
  workerSelection: true as const,
  protectedVerification: true as const,
  finalization: true as const,
  actualCost: true as const,
  cleanupOwnership: true as const,
});

export type ProductionFactoryReadiness = Readonly<{
  ready: boolean;
  blockers: readonly string[];
}>;

function configured(input: ReleaseExecutionFactoryInput, provider: string): boolean {
  const names: Readonly<Record<string, readonly string[]>> = {
    cloud_run: ["googleApplicationDefaultCredentials"],
    gcs: ["googleApplicationDefaultCredentials"],
    collector: ["googleApplicationDefaultCredentials"],
    cloud_sql_postgres: ["googleApplicationDefaultCredentials"],
    modal: ["modalApiAccess"], fly: ["flyApiAccess"], contextvm: ["contextVmServiceKey"],
    cep8_lightning: ["nwcLightningConnection"], cashu: ["cashuFundedWallet"], model: ["vertexModelCredential"],
    compatible_host: ["compatibleHostAccess"], signer: [], promoted_cli: [], upload: [], owner_relay: [], attestation_relay: ["attestationRelayKey"],
  };
  return (names[provider] ?? []).every((name) => typeof input.deploymentConfig.secretReferences[name] === "string");
}

/** Finite, authority-free readiness is used before the approval review. */
export function assessProductionFactoryReadiness(input: ReleaseExecutionFactoryInput): ProductionFactoryReadiness {
  const blockers = [
    ...PRODUCTION_FACTORY_SECRET_REFERENCE_NAMES.filter((name) => !(name in input.deploymentConfig.secretReferences)).map((name) => `SECRET_REFERENCE_REQUIRED:${name}`),
    ...(input.deploymentConfig.publicSettings.regions.length < 2 ? ["REGION_TOPOLOGY_REQUIRED"] : []),
  ];
  return Object.freeze({ ready: blockers.length === 0, blockers: Object.freeze(blockers) });
}

function runtime(input: ReleaseExecutionFactoryInput): DeploymentFactoryRuntime {
  const registry = createNativeReleaseProviderRegistry({
    candidateSha256: input.candidateSha256,
    providers: Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((provider) => [provider, Object.freeze({
      async discoverCapabilities() { return Object.freeze({ capability: "available" as const }); },
      async discoverAuthentication() {
        return Object.freeze({ authentication: configured(input, provider) ? "authorized" as const : "not_configured" as const });
      },
      async plan() { throw new Error("PRODUCTION_FACTORY_APPROVAL_REQUIRED"); },
      async apply() { throw new Error("PRODUCTION_FACTORY_APPROVAL_REQUIRED"); },
      async observe() { throw new Error("PRODUCTION_FACTORY_APPROVAL_REQUIRED"); },
      async cleanup() { throw new Error("PRODUCTION_FACTORY_APPROVAL_REQUIRED"); },
    })])) as never,
  });
  return Object.freeze({
    registry,
    async prepareAuthorizedExecution() {
      throw new Error("PRODUCTION_FACTORY_EXECUTION_PORTS_REQUIRED");
    },
  });
}

/**
 * This composes the sole pre-approval session. Construction has no transport,
 * model, wallet, signer, browser, CLI, relay, or provider invocation. Effect
 * methods are intentionally unreachable until Plan 07-26 supplies the
 * receipt-bound operational ports.
 */
export function createProductionReleaseExecutionSession(input: ReleaseExecutionFactoryInput): ReleaseExecutionSession {
  const readiness = assessProductionFactoryReadiness(input);
  if (!readiness.ready) throw new Error(`PRODUCTION_FACTORY_READINESS_BLOCKED:${readiness.blockers.join(",")}`);
  if (Object.keys(input.deploymentConfig.secretReferences).some((name) => !REQUIRED.has(name))) {
    throw new Error("PRODUCTION_FACTORY_SECRET_REFERENCE_SET_INVALID");
  }
  return createDeploymentReleaseExecutionSession(input, runtime(input));
}
