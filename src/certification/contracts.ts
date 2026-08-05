import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const SafeIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);
const CommandSchema = z.array(z.string().min(1).max(240).refine((value) => !/[\r\n\0]/u.test(value), "command value is unsafe")).min(1).max(16);
const EpochMsSchema = z.number().int().nonnegative().finite();

/** All certification outcomes are explicit; only passed observations can own a claim. */
export const CertificationStatusSchema = z.enum(["passed", "failed", "blocked", "skipped", "not_observed", "stale"]);
export type CertificationStatus = z.infer<typeof CertificationStatusSchema>;

/** Candidate identity is an input to evidence, never a provider client or selection authority. */
export const WorkerCandidateSchema = z.object({
  id: DigestSchema,
  provider: z.enum(["modal", "fly"]),
  image: z.string().regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/iu),
  sourceSha256: DigestSchema,
}).strict();
export type WorkerCandidate = z.infer<typeof WorkerCandidateSchema>;

export const CertificationInputSchema = z.object({
  datasetSha256: DigestSchema,
  profileSha256: DigestSchema,
  topologySha256: DigestSchema,
  command: CommandSchema,
}).strict();

/** Release-scoped facts are explicit, finite and digest-only. They bind an
 * observation to every immutable promotion input instead of trusting a claim
 * supplied by a provider or caller. */
export const ReleaseObservationBindingSchema = z.object({
  releaseId: DigestSchema,
  sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/iu),
  inputs: z.object({
    controlImageDigest: DigestSchema, workerImageDigest: DigestSchema, packageLockSha256: DigestSchema, toolchainSha256: DigestSchema,
    migrationSha256: DigestSchema, configSha256: DigestSchema, policySha256: DigestSchema, datasetSha256: DigestSchema,
    goldenSha256: DigestSchema, sbomSha256: DigestSchema, provenanceSha256: DigestSchema,
  }).strict(),
}).strict();

export const CertificationClaimSchema = z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/u);
const ReasonCodeSchema = z.enum([
  "OBSERVATION_COMPLETE", "CREDENTIALS_UNAVAILABLE", "TOPOLOGY_UNAVAILABLE", "PROVIDER_UNAVAILABLE",
  "READINESS_FAILED", "ISOLATION_FAILED", "CLEANUP_FAILED", "SAMPLE_INSUFFICIENT", "SLO_NOT_MET",
  "EVIDENCE_INVALID", "OBSERVATION_EXPIRED", "INPUT_UNAVAILABLE",
]);

export const CertificationObservationInputSchema = z.object({
  version: z.literal(1),
  evidenceClass: z.enum(["deterministic", "protected_live"]).default("deterministic"),
  status: CertificationStatusSchema,
  candidate: WorkerCandidateSchema,
  input: CertificationInputSchema,
  startedAtMs: EpochMsSchema,
  completedAtMs: EpochMsSchema,
  expiresAtMs: EpochMsSchema,
  claims: z.array(CertificationClaimSchema).max(32),
  limitations: z.array(SafeIdSchema).max(32),
  reasonCode: ReasonCodeSchema,
  releaseBinding: ReleaseObservationBindingSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.completedAtMs < value.startedAtMs || value.expiresAtMs <= value.completedAtMs) context.addIssue({ code: "custom", message: "observation chronology is invalid" });
  if (new Set(value.claims).size !== value.claims.length || new Set(value.limitations).size !== value.limitations.length) context.addIssue({ code: "custom", message: "observation values must be unique" });
  if (value.status === "passed" ? value.claims.length === 0 : value.claims.length !== 0) context.addIssue({ code: "custom", message: "only passed observations may own claims" });
  if (value.evidenceClass === "protected_live" && !value.releaseBinding) context.addIssue({ code: "custom", message: "protected live evidence requires a release binding" });
});

export const CertificationObservationSchema = CertificationObservationInputSchema.extend({ evidenceSha256: DigestSchema }).strict();
export type CertificationObservation = z.infer<typeof CertificationObservationSchema>;
export type CertificationObservationInput = z.infer<typeof CertificationObservationInputSchema>;

export const CertificationBundleSchema = z.object({
  version: z.literal(1), candidateId: DigestSchema, observationDigests: z.array(DigestSchema).min(1).max(128),
  claims: z.array(CertificationClaimSchema).min(1).max(128), assembledAtMs: EpochMsSchema,
  evidenceSha256: DigestSchema, pointer: z.string().regex(/^current\/[a-f0-9]{64}\.json$/iu),
}).strict();
export type CertificationBundle = z.infer<typeof CertificationBundleSchema>;
