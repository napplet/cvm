import { canonicalJson } from "../promotion/schema";
import { validateAuthorizationRequest } from "../release/authorization";
import { createExactSealedUploadAdapter, type ExactSealedUploadAdapter, type ExactSealedUploadPort } from "../release/native/upload";
import type { PreSignedNamedDeployFile } from "../publication/napplet-cli-adapter";
import { ProductionPublicationContextMaterializer } from "./publication-context";
import type { ProductionGenerationRuntime } from "./generation-runtime";

/** Resolves artifact-dependent upload facts after the actual source build.
 * Preapproval material contains only the selected target and provider scope;
 * callers cannot supply a golden future artifact hash or replace its files. */
export function createProductionPublicationUpload(input: Readonly<{
  materializer: ProductionPublicationContextMaterializer;
  authorization: ProductionGenerationRuntime["authorization"];
  targetReference: string;
  port: ExactSealedUploadPort;
  now?: () => number;
}>): ExactSealedUploadAdapter {
  if (!(input.materializer instanceof ProductionPublicationContextMaterializer)) throw new Error("PRODUCTION_PUBLICATION_MATERIALIZER_REQUIRED");
  const resolve = async (operationId: string, files: readonly PreSignedNamedDeployFile[]) => {
    const context = await input.materializer.materialize();
    if (operationId !== `deploy:${context.intent.intentId}`) throw new Error("PRODUCTION_PUBLICATION_UPLOAD_OPERATION_REQUIRED");
    const metadata = files.map(({ bytes: _bytes, ...file }) => file).sort((a, b) => a.path.localeCompare(b.path));
    const expected = [...context.artifact.sealedFiles].sort((a, b) => a.path.localeCompare(b.path));
    if (canonicalJson(metadata) !== canonicalJson(expected)) throw new Error("PRODUCTION_PUBLICATION_UPLOAD_FILES_REQUIRED");
    const request = await validateAuthorizationRequest(input.authorization.request);
    if (request.authorizationRequestSha256 !== input.authorization.authorizationRequestSha256) throw new Error("PRODUCTION_PUBLICATION_AUTHORIZATION_REQUIRED");
    const scope = request.providerScopes.find(value => value.provider === "upload");
    if (!scope) throw new Error("PRODUCTION_PUBLICATION_UPLOAD_SCOPE_REQUIRED");
    return createExactSealedUploadAdapter({
      config: { candidateSha256: request.candidateSha256, topologySha256: request.topologySha256, effectPlanSha256: request.effectPlanSha256,
        accountScopeSha256: scope.accountScopeSha256, projectScopeSha256: scope.projectScopeSha256,
        sealedArtifactSha256: context.artifact.sealedObjectSha256, aggregateSha256: context.artifact.aggregateSha256,
        targetReference: input.targetReference, retentionDays: request.artifactRetentionDays, intentExpiresAtMs: context.intent.expiresAtMs },
      request, receipt: input.authorization.receipt, port: input.port, now: input.now,
    });
  };
  return Object.freeze<ExactSealedUploadAdapter>({
    async uploadExact(value) { return (await resolve(value.operationId, value.files)).uploadExact(value); },
    async reconcileOriginalUpload(value) { return (await resolve(value.operationId, value.files)).reconcileOriginalUpload(value); },
  });
}
