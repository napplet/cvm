import { canonicalJson } from "../promotion/schema";
import { validatedAvailablePromotedCliSourceContract, SOURCE_BUILT_CLI_IDENTITY } from "../publication/napplet-cli-source-contract";
import type { ProductionPublicationContext, ProductionPublicationOperations } from "../release/deployment/production-session-runtime";
import type { NativePromotedCliSource } from "../release/native/promoted-cli";
import type { ExactSealedUploadAdapter } from "../release/native/upload";
import { loadPinnedCliNetworkHelpers } from "./pinned-cli-network";
import { ProductionPublicationContextMaterializer } from "./publication-context";

/** Normal publication operations distinguish initial preparation from strictly
 * read-only original observation. Neither a control request nor a recovery
 * query supplies source facts, signed events, files or provider configuration. */
export function createProductionPublicationOperations(input: Readonly<{
  materializer: ProductionPublicationContextMaterializer;
  context: ProductionPublicationContext;
  source: NativePromotedCliSource;
  upload: ExactSealedUploadAdapter;
}>): ProductionPublicationOperations {
  if (!(input.materializer instanceof ProductionPublicationContextMaterializer)) throw new Error("PRODUCTION_PUBLICATION_MATERIALIZER_REQUIRED");
  const original: ProductionPublicationOperations["original"] = async identity => {
    const source = await input.materializer.source();
    if (identity.candidateSha256 !== source.candidateId || identity.sealedArtifactSha256 !== source.sealedArtifactSha256 || identity.aggregateSha256 !== source.aggregateSha256) throw new Error("PRODUCTION_PUBLICATION_ORIGINAL_SOURCE_CHANGED");
    return input.context.resolve(identity);
  };
  return Object.freeze<ProductionPublicationOperations>({
    original,
    async source() {
      const contract = validatedAvailablePromotedCliSourceContract(input.source.contract);
      if (!contract || canonicalJson(contract.identity) !== canonicalJson(SOURCE_BUILT_CLI_IDENTITY)) throw new Error("PRODUCTION_PUBLICATION_CLI_SOURCE_REQUIRED");
      // The selected worker image pins this source-built binary. The network
      // helper is independently checked from its actual retained bytes here.
      await loadPinnedCliNetworkHelpers();
      const source = await input.materializer.source();
      return { status: "passed", ...source, promotedCliSourceVerified: true, promotedCliAssetVerified: true };
    },
    async resolve(identity) { await input.materializer.materialize(); return original(identity); },
    async deploy(identity) { await input.materializer.materialize(); await original(identity); return input.context.deploy(identity); },
    async observeUpload(value) {
      const source = await input.materializer.source();
      const identity = { candidateSha256: source.candidateId, sealedArtifactSha256: source.sealedArtifactSha256, aggregateSha256: source.aggregateSha256 };
      const context = await original(identity);
      if (context.intent.intentId !== value.intentId || value.operationId !== `deploy:${context.intent.intentId}`) throw new Error("PRODUCTION_PUBLICATION_ORIGINAL_OPERATION_REQUIRED");
      const deploy = await input.context.deploy({ ...identity, operationId: value.operationId });
      return input.upload.reconcileOriginalUpload({ operationId: value.operationId, files: deploy.files });
    },
  });
}
