// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./edge-clients-contracts";
const implementation = await legacyPaymentModule("src/production/edge-clients.ts", ["MountedPublicationOperationSchema", "mountedPublicationEndpoints", "createProductionEdgeClients"]) as typeof import("./edge-clients-contracts");
export const { MountedPublicationOperationSchema, mountedPublicationEndpoints } = implementation;
export const createProductionEdgeClients: typeof implementation.createProductionEdgeClients = input => {
  if (input.host.chromium.kind !== "chromium") throw new Error("PRODUCTION_EDGE_CHROMIUM_REQUIRED");
  return implementation.createProductionEdgeClients(input);
};
