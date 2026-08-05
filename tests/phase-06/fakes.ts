import type {
  AttestationPort,
  NappletDeploymentPort,
  Phase06Clock,
  PreviewHostPort,
  SealedArtifactIdentity,
  SealedArtifactPort,
} from "../../src/publication/contracts.js";
import { canonicalSealedDeployAggregate, type PromotedNappletCliSourcePort } from "../../src/publication/napplet-cli-adapter.js";

export const verifiedPhase06SealedFiles = Object.freeze([
  Object.freeze({ path: "/index.html", mimeType: "text/html", sha256: "e1572f5549c18871efdf707d9d28292dae1b32b0b21f98c3def8ff045f540b85", size: 18 }),
]);

const verifiedPhase06ArtifactValue: SealedArtifactIdentity = {
  accountId: "account:phase-06-owner",
  sessionId: "session:phase-06-preview",
  artifactId: "artifact:phase-06-verified",
  artifactVersion: 7,
  aggregateSha256: canonicalSealedDeployAggregate(verifiedPhase06SealedFiles),
  manifestSha256: "b".repeat(64),
  verificationEvidenceSha256: "c".repeat(64),
  sealedObjectGeneration: "generation:phase-06",
  sealedObjectSha256: "d".repeat(64),
  sealedFiles: verifiedPhase06SealedFiles,
  entrypoint: "/index.html",
  normalizedDTag: "phase-06-napplet",
  requiredCapabilities: ["notes.read"],
  optionalCapabilities: ["notifications"],
  manifestCapabilities: [
    { name: "notes.read", requirement: "required", purpose: "Read selected notes", consent: "required", compatibleRuntimes: ["napplet-host/v1"], available: true },
    { name: "notifications", requirement: "optional", purpose: "Show completion notices", consent: "optional", compatibleRuntimes: [], available: true },
  ],
  policyIdentity: "policy:phase-06",
  toolchainIdentity: "toolchain:promoted",
  runtimeCompatibilityIdentity: "runtime:napplet-host-v1",
};

export const verifiedPhase06Artifact = Object.freeze(verifiedPhase06ArtifactValue);

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
  async deployExact({ operationId }: Parameters<NappletDeploymentPort["deployExact"]>[0]) { this.calls += 1; return { operationId, state: "completed" as const, observationId: "deployment-observation" }; }
  async publishOwnerManifest({ operationId }: Parameters<NappletDeploymentPort["publishOwnerManifest"]>[0]) { this.calls += 1; return { operationId, state: "completed" as const, observationId: "owner-observation" }; }
}

export class DeterministicAttestationPort implements AttestationPort {
  calls = 0;
  async publish({ operationId }: Parameters<AttestationPort["publish"]>[0]) { this.calls += 1; return { operationId, state: "completed" as const, observationId: "attestation-observation" }; }
}

export class DeterministicPromotedNappletCliSource implements PromotedNappletCliSourcePort {
  uploadCalls = 0;
  relayCalls = 0;
  networkSuccessCalls = 0;
  uploaded: unknown[] = [];
  relayed: unknown[] = [];
  uploadResult: "complete" | "partial" | "failed" | "unknown" = "complete";
  relayResult: "complete" | "partial" | "failed" | "unknown" = "complete";

  async uploadFilesToServers(input: Parameters<PromotedNappletCliSourcePort["uploadFilesToServers"]>[0]) {
    this.uploadCalls += 1;
    this.uploaded.push(input);
    return { operationId: input.operationId, state: this.uploadResult, fullServerUploadId: this.uploadResult === "complete" ? `upload:${input.operationId}` : undefined };
  }

  async publishEventWithSimplePool(input: Parameters<PromotedNappletCliSourcePort["publishEventWithSimplePool"]>[0]) {
    this.relayCalls += 1;
    this.relayed.push(input);
    return { operationId: input.operationId, state: this.relayResult, relayObservation: this.relayResult === "complete" ? `relay:${input.operationId}` : undefined };
  }

  networkDeploySucceeded() {
    this.networkSuccessCalls += 1;
    return true;
  }
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
