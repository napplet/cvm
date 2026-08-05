import { CapabilityReviewSchema, SealedArtifactIdentitySchema, type CapabilityReview, type ManifestCapability } from "./contracts.js";

type CapabilityDetail = Readonly<ManifestCapability & { name: string; requirement: "required" | "optional"; compatibleRuntimes: readonly string[] }>;

function compareBytes(left: string, right: string): number {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
function unique(values: readonly string[], code: string): string[] {
  const normalized = [...values].sort(compareBytes);
  if (normalized.some((value, index) => index > 0 && value === normalized[index - 1])) throw new Error(code);
  return normalized;
}
function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function detail(value: Readonly<{ name: string; requirement: "required" | "optional"; purpose: string; consent: "required" | "optional"; compatibleRuntimes: readonly string[]; available: boolean }>, runtimeVariant: string): CapabilityDetail {
  if (value.requirement !== value.consent) throw new Error("CAPABILITY_DECLARATION_CONTRADICTORY");
  const compatibleRuntimes = unique(value.compatibleRuntimes, "CAPABILITY_RUNTIME_DUPLICATE");
  return {
    capability: value.name,
    name: value.name,
    requirement: value.requirement,
    purpose: value.purpose,
    consent: value.consent,
    compatibleRuntimes,
    available: value.available && compatibleRuntimes.includes(runtimeVariant),
  };
}
function compareDetail(left: CapabilityDetail, right: CapabilityDetail): number {
  return compareBytes(`${left.name}\u0000${left.purpose}\u0000${left.consent}\u0000${left.compatibleRuntimes.join("\u0000")}`, `${right.name}\u0000${right.purpose}\u0000${right.consent}\u0000${right.compatibleRuntimes.join("\u0000")}`);
}
function frozen<T>(value: T): T { return Object.freeze(value); }

/** Produces the only capability view used for preview approval: verified manifest plus host runtime. */
export async function canonicalCapabilityReview(artifactInput: unknown, runtimeVariant: string): Promise<CapabilityReview> {
  const artifact = SealedArtifactIdentitySchema.parse(artifactInput);
  if (!artifact.manifestCapabilities) throw new Error("MANIFEST_CAPABILITIES_REQUIRED");
  const declared = artifact.manifestCapabilities.map((value) => detail(value, runtimeVariant));
  const names = unique(declared.map((value) => value.name), "CAPABILITY_DECLARATION_DUPLICATE");
  if (names.length !== declared.length) throw new Error("CAPABILITY_DECLARATION_DUPLICATE");
  const required = declared.filter((value) => value.requirement === "required").sort(compareDetail);
  const optional = declared.filter((value) => value.requirement === "optional").sort(compareDetail);
  if (!exactSet(unique(artifact.requiredCapabilities, "REQUIRED_CAPABILITY_DUPLICATE"), required.map((value) => value.name).sort(compareBytes))
    || !exactSet(unique(artifact.optionalCapabilities, "OPTIONAL_CAPABILITY_DUPLICATE"), optional.map((value) => value.name).sort(compareBytes))) throw new Error("CAPABILITY_IDENTITY_MISMATCH");
  const missingRequired = required.filter((value) => !value.available);
  const unavailableOptional = optional.filter((value) => !value.available);
  const compatibility = missingRequired.length > 0 ? "incompatible" : unavailableOptional.length > 0 ? "degraded" : "compatible";
  const withoutDigest = {
    artifactId: artifact.artifactId,
    aggregateSha256: artifact.aggregateSha256,
    normalizedDTag: artifact.normalizedDTag,
    runtimeVariant,
    required,
    optional,
    compatibility,
    manifestSha256: artifact.manifestSha256,
    policyIdentity: artifact.policyIdentity,
    toolchainIdentity: artifact.toolchainIdentity,
    runtimeCompatibilityIdentity: artifact.runtimeCompatibilityIdentity,
  } as const;
  return frozen(CapabilityReviewSchema.parse({ ...withoutDigest, capabilityDigest: await capabilityDigestForReview(withoutDigest) }));
}

/** Exact versioned bytes are the review's approval boundary; its digest field is deliberately excluded. */
export function canonicalCapabilityBytes(reviewInput: unknown): Uint8Array {
  const review = CapabilityReviewSchema.partial({ capabilityDigest: true }).parse(reviewInput);
  const detail = (value: ManifestCapability) => ({
    name: value.name ?? value.capability,
    requirement: value.requirement ?? value.consent,
    purpose: value.purpose,
    consent: value.consent,
    compatibleRuntimes: unique(value.compatibleRuntimes ?? [], "CAPABILITY_RUNTIME_DUPLICATE"),
    available: value.available,
  });
  const record = {
    v: 1,
    artifactId: review.artifactId,
    aggregateSha256: review.aggregateSha256,
    manifestSha256: review.manifestSha256 ?? null,
    normalizedDTag: review.normalizedDTag,
    policyIdentity: review.policyIdentity ?? null,
    toolchainIdentity: review.toolchainIdentity ?? null,
    runtimeCompatibilityIdentity: review.runtimeCompatibilityIdentity ?? null,
    runtimeVariant: review.runtimeVariant,
    capabilities: [...review.required.map(detail), ...review.optional.map(detail)],
    compatibility: review.compatibility,
  };
  return new TextEncoder().encode(JSON.stringify(record));
}

export async function capabilityDigestForReview(reviewInput: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalCapabilityBytes(reviewInput));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function evaluateRuntimeCompatibility(reviewInput: unknown): Readonly<{ compatibility: CapabilityReview["compatibility"]; missingRequired: readonly string[]; unavailableOptional: readonly string[] }> {
  const review = CapabilityReviewSchema.parse(reviewInput);
  return frozen({
    compatibility: review.compatibility,
    missingRequired: review.required.filter((value) => !value.available).map((value) => value.capability),
    unavailableOptional: review.optional.filter((value) => !value.available).map((value) => value.capability),
  });
}
