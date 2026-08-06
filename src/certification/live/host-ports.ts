import type { LiveSecurityHostObservationPort } from "./security-host.js";
import type { CompatibleHostBrowserObservationPort } from "../../release/native/compatible-host.js";

/**
 * Bridges repository-owned adapters into the existing protected certification
 * suite. It composes evidence producers only: it cannot launch a browser,
 * request signer consent, publish, or write evidence itself.
 */
export function createLiveSecurityHostObservationPort(input: Readonly<{
  runSealedBuild: LiveSecurityHostObservationPort["runSealedBuild"];
  runHostileMatrix: LiveSecurityHostObservationPort["runHostileMatrix"];
  compatibleHost: Pick<CompatibleHostBrowserObservationPort, "runBrowser">;
  inspectSignerBoundary: LiveSecurityHostObservationPort["inspectSignerBoundary"];
}>): LiveSecurityHostObservationPort {
  return Object.freeze({
    evidenceClass: "protected_live" as const,
    runSealedBuild: input.runSealedBuild,
    runHostileMatrix: input.runHostileMatrix,
    runBrowser: (identity) => input.compatibleHost.runBrowser(identity),
    inspectSignerBoundary: input.inspectSignerBoundary,
  });
}
