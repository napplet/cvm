import { CapabilityReviewSchema, type CapabilityReview, PreviewDescriptorSchema, type Phase06Clock, type PreviewDescriptor, type PreviewHostPort, type SealedArtifactPort } from "./contracts.js";

export class PreviewService {
  constructor(private readonly dependencies: Readonly<{ sealedArtifacts: SealedArtifactPort; host: PreviewHostPort; clock: Phase06Clock; capabilityReview: (artifact: unknown, runtimeVariant: string) => CapabilityReview }>) {}

  async previewVerifiedArtifact(input: Readonly<{ accountId: string; sessionId: string; artifactId: string; runtimeVariant: string }>): Promise<PreviewDescriptor> {
    const artifact = await this.dependencies.sealedArtifacts.readVerified({ accountId: input.accountId, sessionId: input.sessionId, artifactId: input.artifactId });
    const review = CapabilityReviewSchema.parse(this.dependencies.capabilityReview(artifact, input.runtimeVariant));
    if (artifact.accountId !== input.accountId || artifact.sessionId !== input.sessionId || review.artifactId !== artifact.artifactId || review.aggregateSha256 !== artifact.aggregateSha256) throw new Error("PREVIEW_ARTIFACT_BINDING_INVALID");
    const nowMs = this.dependencies.clock.nowMs(); const expiresAtMs = nowMs + 60_000;
    const grant = await this.dependencies.host.createDescriptor({ artifact, review, nowMs, expiresAtMs });
    return PreviewDescriptorSchema.parse({ artifact, review, previewGrantId: grant.previewGrantId, expiresAtMs, iframeSandbox: grant.iframeSandbox, authority: grant.authority });
  }
}
