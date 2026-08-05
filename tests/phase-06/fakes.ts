import type {
  AttestationPort,
  NappletDeploymentPort,
  Phase06Clock,
  PreviewHostPort,
  SealedArtifactIdentity,
  SealedArtifactPort,
} from "../../src/publication/contracts.js";

export const verifiedPhase06Artifact = Object.freeze({
  accountId: "account:phase-06-owner",
  sessionId: "session:phase-06-preview",
  artifactId: "artifact:phase-06-verified",
  artifactVersion: 7,
  aggregateSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  verificationEvidenceSha256: "c".repeat(64),
  sealedObjectGeneration: "generation:phase-06",
  sealedObjectSha256: "d".repeat(64),
  entrypoint: "/index.html",
  normalizedDTag: "phase-06-napplet",
  requiredCapabilities: ["notes.read"],
  optionalCapabilities: ["notifications"],
  policyIdentity: "policy:phase-06",
  toolchainIdentity: "toolchain:promoted",
  runtimeCompatibilityIdentity: "runtime:napplet-host-v1",
}) satisfies SealedArtifactIdentity;

export class DeterministicSealedArtifactPort implements SealedArtifactPort {
  calls = 0;
  artifact: unknown = verifiedPhase06Artifact;

  async readVerified(): Promise<SealedArtifactIdentity> {
    this.calls += 1;
    return this.artifact as SealedArtifactIdentity;
  }
}

export class DeterministicPreviewHostPort implements PreviewHostPort {
  calls = 0;
  readonly descriptors: unknown[] = [];
  response: unknown = {
    previewGrantId: "preview-grant:phase-06",
    iframeSandbox: "allow-scripts",
    authority: "preview_read_only",
  };

  async createDescriptor(input: Parameters<PreviewHostPort["createDescriptor"]>[0]) {
    this.calls += 1;
    this.descriptors.push(input);
    return this.response as Awaited<ReturnType<PreviewHostPort["createDescriptor"]>>;
  }
}

export class DeterministicNappletDeploymentPort implements NappletDeploymentPort {
  calls = 0;
  async deployExact() { this.calls += 1; return { state: "completed" as const, observationId: "deployment-observation" }; }
  async publishOwnerManifest() { this.calls += 1; return { state: "completed" as const, observationId: "owner-observation" }; }
}

export class DeterministicAttestationPort implements AttestationPort {
  calls = 0;
  async publish() { this.calls += 1; return { state: "completed" as const, observationId: "attestation-observation" }; }
}

export function fixedPhase06Clock(now = 1_700_000_000_000): Phase06Clock {
  return { nowMs: () => now };
}

export const signedPhase06EventFixture = Object.freeze({
  id: "e".repeat(64),
  pubkey: "1".repeat(64),
  created_at: 1_700_000_000,
  kind: 35129,
  tags: [["d", verifiedPhase06Artifact.normalizedDTag]],
  content: "sealed manifest",
  sig: "2".repeat(128),
});
