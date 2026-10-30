import { createHash } from "node:crypto";
import { z } from "zod";
import { CheckpointRestoreRequestSchema } from "../phase-02/contracts";
import { canonicalJson } from "../promotion/schema";

export const PricedRestoreMetadataSchema = CheckpointRestoreRequestSchema.omit({ archive: true }).extend({
  capabilityGrant: z.literal("phase-05-continuation-grant"),
}).strict();
export type PricedRestoreMetadata = z.infer<typeof PricedRestoreMetadataSchema>;

/** Both effect and query use metadata plus the archive digest authenticated by
 * the resolver. Raw bytes and supplied binding digests never enter this seam;
 * existing v1 operation identities remain separate. */
export function pricedRestoreBinding(value: unknown) {
  const metadata = PricedRestoreMetadataSchema.parse(value);
  const bindingSha256 = createHash("sha256").update(canonicalJson({ schemaVersion: "priced-continuation-restore-v1", metadata })).digest("hex");
  return Object.freeze({ metadata, operationId: `priced-restore:${bindingSha256}`, bindingSha256 });
}
