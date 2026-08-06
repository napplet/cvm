import { z } from "zod";
import { HostBrowserEvidenceSchema } from "../../publication/host-surface";
import { ProtectedSuiteResultSchema, WorkerCandidateSchema, type ProtectedSuiteResult } from "../contracts";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const SealedBuildSchema = z.object({
  status: z.literal("passed"),
  sealedArtifactSha256: DigestSchema,
  manifestSha256: DigestSchema,
  capabilitiesSha256: DigestSchema,
  aggregateSha256: DigestSchema,
}).strict();
const HostileMatrixSchema = z.object({
  status: z.literal("passed"),
  denialProbeCount: z.literal(4),
  directAuthorityDenied: z.literal(true),
  mutationDenied: z.literal(true),
  goldenChangeReviewed: z.literal(true),
  rollbackExercised: z.literal(true),
}).strict();
const SignerBoundarySchema = z.object({
  status: z.literal("passed"),
  externalSigner: z.literal(true),
  userKeyOutsideCvm: z.literal(true),
  keyCanaryAbsentFromCvm: z.literal(true),
  keyCanaryAbsentFromEvidence: z.literal(true),
}).strict();

/** Plan 07-25 injects the protected runner/host/signer implementation. The
 * adapter intentionally cannot construct a browser, signer, provider, or
 * evidence writer, which keeps deterministic test ports non-authoritative. */
export type LiveSecurityHostObservationPort = Readonly<{
  evidenceClass: "protected_live" | "deterministic";
  runSealedBuild(candidate: Readonly<{ candidateId: string; image: string }>): Promise<unknown>;
  runHostileMatrix(identity: Readonly<{ sealedArtifactSha256: string; manifestSha256: string; capabilitiesSha256: string; aggregateSha256: string }>): Promise<unknown>;
  runBrowser(identity: Readonly<{ sealedArtifactSha256: string; aggregateSha256: string }>): Promise<unknown>;
  inspectSignerBoundary(identity: Readonly<{ sealedArtifactSha256: string; aggregateSha256: string }>): Promise<unknown>;
}>;

export type LiveSecurityHostCertificationInput = Readonly<{
  candidate: unknown;
  observationPort?: LiveSecurityHostObservationPort;
}>;

function nonPass(status: "blocked" | "failed", reasonCode: ProtectedSuiteResult["reasonCode"], limitation: string): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse({ status, claims: [], limitations: [limitation], reasonCode });
}

/**
 * Future protected execution runs the frozen sealed build, denial probes,
 * Chromium compatible-host matrix, and an external signer boundary through
 * injected ports. Only digest-only facts cross this adapter boundary; no key,
 * source, browser output, runtime message, or provider-native data can become
 * a certification claim.
 */
export async function runLiveSecurityHostCertification(input: LiveSecurityHostCertificationInput): Promise<ProtectedSuiteResult> {
  const candidate = WorkerCandidateSchema.safeParse(input.candidate);
  const port = input.observationPort;
  if (!candidate.success || !port || port.evidenceClass !== "protected_live") {
    return nonPass("blocked", "INPUT_UNAVAILABLE", "protected-live-security-host-required");
  }

  try {
    const build = SealedBuildSchema.parse(await port.runSealedBuild({ candidateId: candidate.data.id, image: candidate.data.image }));
    const identity = {
      sealedArtifactSha256: build.sealedArtifactSha256,
      manifestSha256: build.manifestSha256,
      capabilitiesSha256: build.capabilitiesSha256,
      aggregateSha256: build.aggregateSha256,
    };
    const [hostile, browser, signer] = await Promise.all([
      port.runHostileMatrix(identity),
      port.runBrowser({ sealedArtifactSha256: build.sealedArtifactSha256, aggregateSha256: build.aggregateSha256 }),
      port.inspectSignerBoundary({ sealedArtifactSha256: build.sealedArtifactSha256, aggregateSha256: build.aggregateSha256 }),
    ]);
    const hostileResult = HostileMatrixSchema.parse(hostile);
    const browserEvidence = HostBrowserEvidenceSchema.parse(browser);
    const signerBoundary = SignerBoundarySchema.parse(signer);
    if (browserEvidence.execution !== "real_compatible_host_browser" || browserEvidence.sealedArtifactSha256 !== build.sealedArtifactSha256 || browserEvidence.certificationStatus !== "pass") {
      return nonPass("failed", "EVIDENCE_INVALID", "compatible-host-evidence-incomplete");
    }
    if (hostileResult.status !== "passed" || signerBoundary.status !== "passed") {
      return nonPass("failed", "EVIDENCE_INVALID", "security-or-key-custody-evidence-incomplete");
    }
    return ProtectedSuiteResultSchema.parse({
      status: "passed",
      claims: ["release.security_host", "release.compatible_host", "release.user_key_custody"],
      limitations: ["selection-external"],
      reasonCode: "OBSERVATION_COMPLETE",
    });
  } catch {
    return nonPass("blocked", "PROVIDER_UNAVAILABLE", "security-host-observation-unavailable");
  }
}
