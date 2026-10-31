import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const reference = z.string().regex(/^[a-z][a-z0-9:._/-]{2,255}$/iu);
const origin = z.string().url().refine((value) => new URL(value).protocol === "https:");
const wss = z.string().url().refine((value) => new URL(value).protocol === "wss:");
const publicKey = z.string().regex(/^[a-f0-9]{64}$/iu);
const absolutePath = z.string().regex(/^\/[A-Za-z0-9._/-]{1,1023}$/u);

/**
 * Deliberately reference-only configuration.  Secret values are resolved by
 * the deployment identity, never loaded from this document or passed to a
 * worker.  Keeping this closed makes a development realm impossible to
 * accidentally select through an extra environment variable.
 */
export const ProductionConfigSchema = z.object({
  realm: z.literal("production-real"),
  candidateSha256: digest,
  topologySha256: digest,
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
  regions: z.tuple([z.string().min(2), z.string().min(2)]),
  cloudSql: z.object({ instanceReference: reference, database: z.literal("production_real"), roleCredentialReference: reference, /** restricted role copied into the recovered clone */ restoreRecoveredRoleCredentialReference: reference, /** restricted role provisioned only in the empty verification target */ restoreMigrationRoleCredentialReference: reference, migrationRevision: digest }).strict(),
  gcs: z.object({ bucket: z.string().min(3), location: z.literal("nam4"), encryptionKeyReference: reference, migrationBackupKeyReference: reference, retentionDays: z.literal(30) }).strict(),
  /** Dedicated mounted KEK for locally wrapped per-checkpoint DEKs. */
  checkpoint: z.object({ kekReference: reference }).strict(),
  contextvm: z.object({ relay: z.string().url().refine((value) => new URL(value).protocol === "wss:"), serviceKeyReference: reference }).strict(),
  certification: z.object({ authorizationRequestReference: reference, authorizationReceiptReference: reference, clientKeyReference: reference, sessionMaterialReference: reference, serverPubkey: publicKey }).strict(),
  funding: z.object({ nwcConnectionReference: reference, cashuConsentReference: reference, protectedMaterialReference: reference, admissionReceiptReference: reference, statusCursorReference: reference }).strict(),
  vertex: z.object({ projectReference: reference, credentialReference: reference, model: z.literal("gemini-4-argon"), priceSnapshotSha256: digest }).strict(),
  worker: z.object({ selectedProvider: z.enum(["modal", "fly"]), evidenceReference: reference, modalAccessReference: reference, flyAccessReference: reference, image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu), toolchainSha256: digest, policyVersion: z.string().min(1), artifactContract: z.enum(["legacy-aggregate-v1", "nip5d-direct-v1"]).optional(), restoreRecoveryVersion: z.literal(1).optional(), retainedProfiles: z.array(z.object({ image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu), toolchainSha256: digest, artifactContract: z.enum(["legacy-aggregate-v1", "nip5d-direct-v1"]), restoreRecoveryVersion: z.literal(1).optional() }).strict()).max(8).optional() }).strict(),
  compatibleHost: z.object({ targetUrl: origin, targetSha256: digest, chromiumExecutable: absolutePath }).strict(),
  publication: z.object({
    cliSourceReference: reference, signerBrokerReference: reference, signerSessionKeyReference: reference, attestationKeyReference: reference,
    ownerPubkey: publicKey, uploadServer: origin, uploadTargetReference: reference, relays: z.array(wss).min(1).max(16),
  }).strict(),
  publicOrigins: z.object({ static: origin, preview: origin, artifact: origin }).strict(),
  policy: z.object({ artifactVersion: z.string().min(1), retentionDays: z.literal(30), liveGraceMs: z.literal(600_000) }).strict(),
  collector: z.object({ otlpEndpoint: origin, serviceName: z.literal("napplet-cvm-production") }).strict(),
  operator: z.object({ serviceAccount: z.string().regex(/^[a-z][a-z0-9-]{2,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u), privateControlAudience: z.string().url().refine(value => new URL(value).protocol === "https:" && /^[a-z0-9-]+\.run\.app$/u.test(new URL(value).hostname)) }).strict(),
  image: z.object({ controlPlane: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu), toolchainSha256: digest }).strict(),
}).strict();

export type ProductionConfig = Readonly<z.infer<typeof ProductionConfigSchema>>;

/** The legacy Google-only configuration stays readable for historical
 * recovery. Deployment policy disables its activation. Reuse the existing
 * provider interfaces for application wiring; do not add a parallel graph. */
export const GOOGLE_CLOUD_DEPLOYMENT_DISABLED = "GOOGLE_CLOUD_DEPLOYMENT_DISABLED";

export function assertProductionDeploymentAllowed(_config: ProductionConfig): void {
  throw new Error(GOOGLE_CLOUD_DEPLOYMENT_DISABLED);
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Parses only explicit configuration; no ambient dev/default fallback exists. */
export function loadProductionConfig(value: unknown): ProductionConfig {
  const config = ProductionConfigSchema.parse(value);
  if (config.regions[0] === config.regions[1]) throw new Error("PRODUCTION_REGIONS_MUST_DIFFER");
  if (config.worker.image.split("@sha256:")[1] !== config.image.controlPlane.split("@sha256:")[1]
    && config.worker.toolchainSha256 !== config.image.toolchainSha256) {
    throw new Error("PRODUCTION_TOOLCHAIN_IDENTITY_MISMATCH");
  }
  const images = [config.worker.image, ...(config.worker.retainedProfiles ?? []).map(profile => profile.image)];
  if (new Set(images).size !== images.length) throw new Error("PRODUCTION_WORKER_EXECUTABLES_INVALID");
  return immutable(structuredClone(config));
}

/** Reject accidental development graph material before authority construction. */
export function assertProductionReferenceGraph(value: unknown): void {
  const serialized = JSON.stringify(value).toLowerCase();
  const forbidden = ["src/dev", "fakewallet", "faucet", "fixture", "synthetic", "deterministicobjectstore", "local-checkpoint", "docker.sock", "window.nostr", "nostr_private_key"];
  if (forbidden.some((needle) => serialized.includes(needle))) throw new Error("PRODUCTION_DEVELOPMENT_AUTHORITY_DENIED");
}
