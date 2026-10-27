import type { ReleaseExecutionSession } from "../controller";
import type { ReleaseProviderId } from "../contracts";
import type { ReleaseProviderPort } from "../providers";
import type { ReleaseExecutionFactoryInput } from "../production-execution";
import { validateAuthorizationReceipt } from "../authorization";
import {
  PRODUCTION_LIVE_PROTECTED_PORT_KEYS,
  type ProductionLiveProtectedCertificationPorts,
} from "../../certification/live/production-ports";
import { RELEASE_PRODUCTION_PROVIDER_IDS } from "../native-registry";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "./postgres-operation-journal";
import {
  createProductionOperationalDependencies,
  type ProductionOperationalDependencies,
} from "./production-dependencies";
import { createProductionReleaseExecutionSession } from "./production-factory";
import type { ProductionEdgeSuiteAdapters } from "./production-edge-suite-adapters";
import { assembleInstalledProductionSessionRuntime } from "./production-session-runtime";

export type ProductionCoreSuitePorts = Pick<ProductionLiveProtectedCertificationPorts,
  "admission" | "telemetry" | "chaos" | "durability">;

/**
 * The dynamic, pinned factory has a deliberately small authority surface.  A
 * controller creates this value from the concrete authenticated transports
 * (Google, workers, ContextVM/NWC/Cashu, Vertex, host, signer, publication and
 * relays); neither the certifier CLI nor deployment JSON can supply clients or
 * credentials.  The journal check is intentionally here, at the composition
 * boundary, so no production session can silently fall back to file or memory
 * original-operation state.
 */
export type ProductionSessionRuntime = Readonly<{
  receipt: unknown;
  journal: PostgresOperationJournal;
  providers: Readonly<Record<ReleaseProviderId, Readonly<{
    origin: "project-owned";
    evidenceClass: "real";
    brokerReference: string;
    port: ReleaseProviderPort;
  }>>>;
  protectedPorts: ProductionLiveProtectedCertificationPorts;
  prepare: Parameters<typeof createProductionOperationalDependencies>[0]["prepare"];
  now?: () => number;
}>;

export const productionSessionReadiness = Object.freeze({
  providerFamilies: Object.freeze([...RELEASE_PRODUCTION_PROVIDER_IDS]),
  protectedSuites: Object.freeze([...PRODUCTION_LIVE_PROTECTED_PORT_KEYS]),
  durableOriginalOperations: "postgres" as const,
  effectGate: "exact-receipt-per-operation" as const,
});

/** Inventory consumed by the hash-pinned preapproval loader.  It is static
 * evidence only; `createReleaseExecutionSession` still rejects a missing
 * controller-owned runtime before any provider method can be reached. */
export const releaseReadiness = Object.freeze({
  providerFamilies: productionSessionReadiness.providerFamilies,
  protectedSuites: productionSessionReadiness.protectedSuites,
  materialization: true as const,
  workerSelection: true as const,
  protectedVerification: true as const,
  finalization: true as const,
  actualCost: true as const,
  cleanupOwnership: true as const,
});

/** Joins the only two controller-owned suite families.  The core-control
 * adapter owns admission/telemetry/chaos/restore while Plan 69 owns the
 * signer/host/supply-chain/payment/publication edge.  Keeping the join here
 * prevents either factory from silently supplying a deterministic fallback. */
export function composeProductionProtectedPorts(input: Readonly<{
  core: ProductionCoreSuitePorts;
  edge: ProductionEdgeSuiteAdapters;
}>): ProductionLiveProtectedCertificationPorts {
  if (!exactKeys(input.core, ["admission", "telemetry", "chaos", "durability"])
    || !exactKeys(input.edge, ["security-host", "supply-chain", "ContextVM-payment-model", "publication"])) {
    throw new Error("PRODUCTION_SESSION_PROTECTED_PORT_SET_REQUIRED");
  }
  return Object.freeze({
    admission: input.core.admission,
    telemetry: input.core.telemetry,
    chaos: input.core.chaos,
    durability: input.core.durability,
    "security-host": input.edge["security-host"],
    "supply-chain": input.edge["supply-chain"],
    "ContextVM-payment-model": input.edge["ContextVM-payment-model"],
    publication: input.edge.publication,
  });
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

/** Builds the one project-owned operational graph without transport I/O. */
export function createProductionSessionDependencies(runtime: ProductionSessionRuntime): ProductionOperationalDependencies {
  if (!runtime || typeof runtime !== "object") throw new Error("PRODUCTION_SESSION_RUNTIME_REQUIRED");
  if (Object.keys(runtime).length === 0) throw new Error("PRODUCTION_SESSION_RUNTIME_REQUIRED");
  if (!("receipt" in runtime) || runtime.receipt === undefined || runtime.receipt === null) {
    throw new Error("PRODUCTION_SESSION_RECEIPT_REQUIRED");
  }
  if (!("journal" in runtime)) throw new Error("PRODUCTION_SESSION_RUNTIME_REQUIRED");
  try { assertPostgresOperationJournal(runtime.journal); }
  catch { throw new Error("PRODUCTION_SESSION_POSTGRES_JOURNAL_REQUIRED"); }
  if (typeof runtime.prepare !== "function"
    || !exactKeys(runtime.providers, RELEASE_PRODUCTION_PROVIDER_IDS)
    || !exactKeys(runtime.protectedPorts, PRODUCTION_LIVE_PROTECTED_PORT_KEYS)) {
    throw new Error("PRODUCTION_SESSION_RUNTIME_REQUIRED");
  }
  return createProductionOperationalDependencies({
    receipt: runtime.receipt,
    providers: runtime.providers,
    protectedPorts: Object.fromEntries(PRODUCTION_LIVE_PROTECTED_PORT_KEYS.map((key) => [
      key,
      Object.freeze({ ...runtime.protectedPorts[key], origin: "project-owned" as const }),
    ])) as never,
    prepare: runtime.prepare,
    now: runtime.now,
  });
}

/**
 * Production entrypoint.  A caller must provide the controller-owned runtime
 * assembled from sealed references after the exact receipt is available.  This
 * prevents user-authored config, ambient environment variables, or a generic
 * dependency injection seam from creating a live session.
 */
export async function createReleaseExecutionSession(input: ReleaseExecutionFactoryInput): Promise<ReleaseExecutionSession> {
  /* The receipt is deliberately unavailable at no-effect preapproval time.
   * The normal executor resolves the controller-owned immutable receipt record
   * and passes it here only after canonical validation. This module repeats
   * that validation because every operational provider depends on this seam. */
  if (!input.authorization) throw new Error("PRODUCTION_SESSION_RECEIPT_REQUIRED");
  const receipt = await validateAuthorizationReceipt({
    request: input.authorization.request,
    receipt: input.authorization.receipt,
    nowMs: Date.now(),
  });
  const { runtime } = assembleInstalledProductionSessionRuntime(receipt);
  if (input.candidateSha256 !== receipt.candidateSha256
    || input.deploymentConfig.candidateSha256 !== receipt.candidateSha256) {
    throw new Error("PRODUCTION_SESSION_RECEIPT_BINDING_REQUIRED");
  }
  return createProductionReleaseExecutionSession(input, createProductionSessionDependencies(runtime));
}
