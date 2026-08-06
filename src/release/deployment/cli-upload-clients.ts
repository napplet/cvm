import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ReferenceSchema = z.string().regex(/^[a-z][a-z0-9:._/-]{2,255}$/iu);

/** Closed argv and original-BUD-operation descriptors. The promoted CLI and
 * Blossom transport are deliberately not executable in this factory. */
export function createCliUploadDeploymentClients(input: Readonly<{
  promotedCliSourceReference: unknown;
  promotedCliSourceSha256: unknown;
  uploadTargetReference: unknown;
}>) {
  const sourceReference = ReferenceSchema.parse(input.promotedCliSourceReference);
  const sourceSha256 = DigestSchema.parse(input.promotedCliSourceSha256);
  const uploadTargetReference = ReferenceSchema.parse(input.uploadTargetReference);
  if (!/^napplet:cli:(?!latest$)[0-9]+\.[0-9]+\.[0-9]+$/u.test(sourceReference) || !uploadTargetReference.startsWith("blossom:")) throw new Error("DEPLOYMENT_PROMOTED_CLI_INVALID");

  return Object.freeze({
    promotedCli: Object.freeze({
      discovery: () => Object.freeze({ sourceReference, sourceSha256, command: Object.freeze(["napplet", "deploy", "--pre-signed"]) }),
    }),
    upload: Object.freeze({
      discovery: () => Object.freeze({ targetReference: uploadTargetReference, protocol: "blossom_bud" as const }),
      async reconcileOriginal(inputForOperation: Readonly<{ originalOperationId: unknown; observedOperationId: unknown; fileChecksums: unknown }>) {
        const operationId = OperationSchema.parse(inputForOperation.originalOperationId);
        try {
          if (OperationSchema.parse(inputForOperation.observedOperationId) !== operationId || !z.array(DigestSchema).min(1).max(4_096).parse(inputForOperation.fileChecksums).length) throw new Error("mismatch");
          return Object.freeze({ status: "reconciled" as const, operationId });
        } catch {
          return Object.freeze({ status: "blocked" as const, operationId });
        }
      },
    }),
  });
}
