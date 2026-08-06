import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OperationSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const ProjectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const RegionSchema = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u);
const ReferenceSchema = z.string().regex(/^[a-z][a-z0-9:./_-]{2,255}$/iu);

/** Vertex Gemini is intentionally a thin operation-bound view over the shared
 * Google deployment client. It owns no ADC resolver and never redispatches an
 * ambiguous operation; an injected Google primitive is the sole transport. */
export function createVertexDeploymentClient(input: Readonly<{
  candidateSha256: unknown;
  projectId: unknown;
  location: unknown;
  model: unknown;
  credentialReference: unknown;
  vertex: Readonly<{ predict(input: Readonly<{ operationId: string; region: string; modelReference: string; requestDigest: string }>): Promise<Readonly<{ status: "completed" | "missing" | "pending" | "unknown" | "blocked" }>> }>;
}>) {
  const candidateSha256 = DigestSchema.parse(input.candidateSha256);
  const projectId = ProjectSchema.parse(input.projectId);
  const location = RegionSchema.parse(input.location);
  const model = z.string().regex(/^gemini-[a-z0-9._-]{2,128}$/iu).parse(input.model);
  const credentialReference = ReferenceSchema.parse(input.credentialReference);
  if (/(?:ya29\.|private|secret|token|password)/iu.test(credentialReference)) throw new Error("DEPLOYMENT_SECRET_REFERENCE_INVALID");
  const dispatched = new Set<string>();

  return Object.freeze({
    discovery: () => Object.freeze({ candidateSha256, projectId, location, model, credentialReference, provider: "vertex_ai_gemini" as const }),
    async dispatch(value: Readonly<{ operationId: unknown; requestSha256: unknown }>) {
      const operationId = OperationSchema.parse(value.operationId);
      const requestSha256 = DigestSchema.parse(value.requestSha256);
      if (dispatched.has(operationId)) return Object.freeze({ status: "unknown" as const, operationId });
      const result = await input.vertex.predict({ operationId, region: location, modelReference: model, requestDigest: requestSha256 });
      if (result.status === "completed") dispatched.add(operationId);
      return Object.freeze({ status: result.status, operationId });
    },
    async reconcileOriginal(value: Readonly<{ operationId: unknown }>) {
      const operationId = OperationSchema.parse(value.operationId);
      return Object.freeze({ status: dispatched.has(operationId) ? "completed" as const : "unknown" as const, operationId, originalOperationOnly: true as const });
    },
  });
}
