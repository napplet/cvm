import type { ProductionOperationalDependenciesInput } from "../../src/release/deployment/production-dependencies";

/** Construction-only fixtures. Any attempted suite execution fails immediately;
 * these labels test graph validation and never constitute live evidence. */
export function unexecutedProtectedPorts(onUnexpected: () => void = () => {}): ProductionOperationalDependenciesInput["protectedPorts"] {
  const unexpected = async () => { onUnexpected(); throw new Error("UNEXPECTED_PROTECTED_SUITE_EXECUTION"); };
  return Object.freeze<ProductionOperationalDependenciesInput["protectedPorts"]>({
    admission: Object.freeze({ origin: "project-owned", evidenceClass: "real", executeSample: unexpected }),
    telemetry: Object.freeze({ origin: "project-owned", evidenceClass: "real", emit: unexpected, queryWindow: unexpected }),
    chaos: Object.freeze({ origin: "project-owned", evidenceClass: "real", executeFault: unexpected, observeOriginal: unexpected, observeTopology: unexpected }),
    durability: Object.freeze({ origin: "project-owned", evidenceClass: "real", inventory: unexpected, loseLocalState: unexpected, createFreshInstance: unexpected }),
    "security-host": Object.freeze({ origin: "project-owned", evidenceClass: "real", runSealedBuild: unexpected, runHostileMatrix: unexpected, runBrowser: unexpected, inspectSignerBoundary: unexpected }),
    "supply-chain": Object.freeze({ origin: "project-owned", evidenceClass: "real", runBuild: unexpected, supplyChainInput: unexpected }),
    "ContextVM-payment-model": Object.freeze({ origin: "project-owned", evidenceClass: "real", exerciseSignedTransport: unexpected, exerciseCep8Settlement: unexpected, reconcileOriginalModelOperation: unexpected }),
    publication: Object.freeze({ origin: "project-owned", evidenceClass: "real", verifyPromotedSource: unexpected, submitOriginalPublication: unexpected, reconcileOriginalPublication: unexpected }),
  });
}
