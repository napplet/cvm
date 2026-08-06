import {
  createProductionLiveProtectedCertificationPorts,
  PRODUCTION_LIVE_PROTECTED_PORT_KEYS,
  type ProductionLiveProtectedCertificationPorts,
} from "../../certification/live/production-ports";

/**
 * Deployment-owned exact-eight boundary. The concrete adapter methods are
 * injected by the authenticated executor, while this factory establishes the
 * public D-138 names and rejects fixture or aliased ports before any suite
 * runner can receive them.
 */
export function createDeploymentProtectedPorts(
  input: ProductionLiveProtectedCertificationPorts,
): ProductionLiveProtectedCertificationPorts {
  const ports = createProductionLiveProtectedCertificationPorts(input);
  const values = PRODUCTION_LIVE_PROTECTED_PORT_KEYS.map((key) => ports[key]);
  if (new Set(values).size !== values.length) {
    throw new Error("DEPLOYMENT_PROTECTED_PORT_IDENTITY_REQUIRED");
  }
  return Object.freeze({ ...ports });
}
