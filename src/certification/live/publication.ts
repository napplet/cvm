import { z } from "zod";
import { ProtectedSuiteResultSchema, WorkerCandidateSchema, type ProtectedSuiteResult } from "../contracts";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const SourceObservationSchema = z.object({
  status: z.literal("passed"),
  candidateId: DigestSchema,
  sealedArtifactSha256: DigestSchema,
  aggregateSha256: DigestSchema,
  promotedCliSourceVerified: z.literal(true),
  promotedCliAssetVerified: z.literal(true),
}).strict();
const SubmissionObservationSchema = z.object({
  status: z.literal("submitted"),
  intentId: z.string().min(1).max(256),
  sealedArtifactSha256: DigestSchema,
  userSigningExternal: z.literal(true),
  operationIds: z.object({ deploy: z.string().min(1).max(300), ownerManifest: z.string().min(1).max(300), attestation: z.string().min(1).max(300) }).strict(),
}).strict();
const ReconciliationObservationSchema = z.object({
  status: z.literal("complete"),
  intentId: z.string().min(1).max(256),
  operationIds: z.object({ deploy: z.string().min(1).max(300), ownerManifest: z.string().min(1).max(300), attestation: z.string().min(1).max(300) }).strict(),
  originalOperationsOnly: z.literal(true),
  deploymentObserved: z.literal(true),
  ownerRelayObserved: z.literal(true),
  attestationRelayObserved: z.literal(true),
}).strict();

/** The protected runner alone wires the promoted source contract, sealed CLI
 * adapter, external owner signer, PublicationService, and relay ports. This
 * interface deliberately has no credential, raw signed event, upload bytes,
 * or protected-evidence writer. */
export type LivePublicationObservationPort = Readonly<{
  evidenceClass: "protected_live" | "deterministic";
  verifyPromotedSource(candidate: Readonly<{ candidateId: string }>): Promise<unknown>;
  submitOriginalPublication(source: Readonly<{ sealedArtifactSha256: string; aggregateSha256: string }>): Promise<unknown>;
  reconcileOriginalPublication(operation: Readonly<{ intentId: string; operationIds: Readonly<{ deploy: string; ownerManifest: string; attestation: string }> }>): Promise<unknown>;
}>;

export type LivePublicationCertificationInput = Readonly<{
  candidate: unknown;
  observationPort?: LivePublicationObservationPort;
}>;

function nonPass(status: "blocked" | "failed", reasonCode: ProtectedSuiteResult["reasonCode"], limitation: string): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse({ status, claims: [], limitations: [limitation], reasonCode });
}

function exactOperationIds(intentId: string, operationIds: Readonly<{ deploy: string; ownerManifest: string; attestation: string }>): boolean {
  return operationIds.deploy === `deploy:${intentId}`
    && operationIds.ownerManifest === `owner_manifest:${intentId}`
    && operationIds.attestation === `attestation:${intentId}`;
}

/**
 * Future protected execution verifies the exact promoted CLI asset, submits a
 * user-externally-signed sealed artifact, then observes only the three durable
 * original publication operations. A timeout or partial provider response can
 * never manufacture a replacement upload, owner event, or attestation.
 */
export async function runLivePublicationCertification(input: LivePublicationCertificationInput): Promise<ProtectedSuiteResult> {
  const candidate = WorkerCandidateSchema.safeParse(input.candidate);
  const port = input.observationPort;
  if (!candidate.success || !port || port.evidenceClass !== "protected_live") {
    return nonPass("blocked", "INPUT_UNAVAILABLE", "protected-live-publication-required");
  }

  try {
    const source = SourceObservationSchema.parse(await port.verifyPromotedSource({ candidateId: candidate.data.id }));
    if (source.candidateId !== candidate.data.id) return nonPass("failed", "EVIDENCE_INVALID", "promoted-source-candidate-mismatch");
    const submitted = SubmissionObservationSchema.parse(await port.submitOriginalPublication({ sealedArtifactSha256: source.sealedArtifactSha256, aggregateSha256: source.aggregateSha256 }));
    if (submitted.sealedArtifactSha256 !== source.sealedArtifactSha256 || !exactOperationIds(submitted.intentId, submitted.operationIds)) {
      return nonPass("failed", "EVIDENCE_INVALID", "sealed-publication-operation-invalid");
    }
    const reconciled = ReconciliationObservationSchema.parse(await port.reconcileOriginalPublication({ intentId: submitted.intentId, operationIds: submitted.operationIds }));
    if (reconciled.intentId !== submitted.intentId || !exactOperationIds(reconciled.intentId, reconciled.operationIds)
      || JSON.stringify(reconciled.operationIds) !== JSON.stringify(submitted.operationIds)) {
      return nonPass("failed", "EVIDENCE_INVALID", "original-publication-reconciliation-invalid");
    }
    return ProtectedSuiteResultSchema.parse({
      status: "passed",
      claims: ["release.promoted_cli", "release.sealed_publication", "release.external_owner_signing"],
      limitations: ["selection-external"],
      reasonCode: "OBSERVATION_COMPLETE",
    });
  } catch {
    return nonPass("blocked", "PROVIDER_UNAVAILABLE", "publication-observation-unavailable");
  }
}
