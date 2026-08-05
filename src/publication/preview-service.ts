import { CapabilityReviewSchema, SealedArtifactIdentitySchema, type CapabilityReview, PreviewDescriptorSchema, type Phase06Clock, type PreviewDescriptor, type PreviewHostPort, type SealedArtifactPort } from "./contracts.js";
import { safePreviewDenial, type SafePreviewDenial } from "./public-status.js";

const HostGrantSchema = PreviewDescriptorSchema.pick({ previewGrantId: true, iframeSandbox: true, authority: true }).passthrough();
const allowedHostGrantKeys = new Set(["previewGrantId", "iframeSandbox", "authority", "artifact", "review", "nowMs", "expiresAtMs"]);

function parseHostGrant(value: unknown) {
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !allowedHostGrantKeys.has(key))) throw new Error("PREVIEW_GRANT_AUTHORITY_INVALID");
  return HostGrantSchema.parse(value);
}

export class PreviewService {
  constructor(private readonly dependencies: Readonly<{ sealedArtifacts: SealedArtifactPort; host: PreviewHostPort; clock: Phase06Clock; capabilityReview: (artifact: unknown, runtimeVariant: string) => CapabilityReview | Promise<CapabilityReview> }>) {}

  async previewVerifiedArtifact(input: Readonly<{ accountId: string; sessionId: string; artifactId: string; runtimeVariant: string }>): Promise<PreviewDescriptor | SafePreviewDenial> {
    let artifact: ReturnType<typeof SealedArtifactIdentitySchema.parse>;
    try {
      artifact = SealedArtifactIdentitySchema.parse(await this.dependencies.sealedArtifacts.readVerified({ accountId: input.accountId, sessionId: input.sessionId, artifactId: input.artifactId }));
    } catch {
      return safePreviewDenial();
    }
    let review: CapabilityReview;
    try {
      review = CapabilityReviewSchema.parse(await this.dependencies.capabilityReview(artifact, input.runtimeVariant));
    } catch {
      return safePreviewDenial();
    }
    if (artifact.accountId !== input.accountId || artifact.sessionId !== input.sessionId || artifact.artifactId !== input.artifactId || review.artifactId !== artifact.artifactId || review.aggregateSha256 !== artifact.aggregateSha256 || review.normalizedDTag !== artifact.normalizedDTag || review.runtimeVariant !== input.runtimeVariant || review.compatibility === "incompatible") return safePreviewDenial();
    const nowMs = this.dependencies.clock.nowMs(); const expiresAtMs = nowMs + 60_000;
    try {
      const grant = parseHostGrant(await this.dependencies.host.createDescriptor({ artifact, review, nowMs, expiresAtMs }));
      return PreviewDescriptorSchema.parse({ artifact, review, previewGrantId: grant.previewGrantId, expiresAtMs, iframeSandbox: grant.iframeSandbox, authority: grant.authority });
    } catch {
      return safePreviewDenial();
    }
  }
}
