import type { z } from "zod";

import type { DirectPublicationReferenceSchema } from "../../certification/live/direct-publication-contract";
import { ProductionCoreControlClient } from "./production-core-control";
import { createFixedProductionEdgeSuiteAdapters, type ProductionEdgeSuiteAdapters } from "./production-edge-suite-adapters";

/** Historical Cloud Run/ADC reader assembly. Keep it separate so successor
 * handler imports cannot initialize google-auth-library or legacy control. */
export function createLegacyProductionEdgeSuiteAdapters(input: Readonly<{ candidateId: unknown; control: unknown; artifactContract?: "nip5d-direct-v1"; directPublicationReference?: z.infer<typeof DirectPublicationReferenceSchema> }>): ProductionEdgeSuiteAdapters {
  if (!(input.control instanceof ProductionCoreControlClient)) throw new Error("PRODUCTION_EDGE_CONTROL_CLIENT_REQUIRED");
  return createFixedProductionEdgeSuiteAdapters({ ...input, control: input.control });
}
