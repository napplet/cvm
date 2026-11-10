// Deprecated typed compatibility surface. Operators install its implementation separately.
import { legacyPaymentModule } from "../payments/legacy-module";
export type * from "./edge-clients-contracts";
export const { MountedPublicationOperationSchema, mountedPublicationEndpoints, createProductionEdgeClients } = await legacyPaymentModule("src/production/edge-clients.ts", ["MountedPublicationOperationSchema", "mountedPublicationEndpoints", "createProductionEdgeClients"]) as typeof import("./edge-clients-contracts");
