import { expect, test } from "bun:test";

import { PromotedNappletCliAdapter, canonicalSealedDeployAggregate } from "../../src/publication/napplet-cli-adapter";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { createNativePromotedNappletCliSource } from "../../src/release/native/promoted-cli";
import { createNostrRelayPublicationAdapter } from "../../src/release/native/nostr-relay";
import { createExactSealedUploadAdapter } from "../../src/release/native/upload";
import { createProtectedLivePublicationObservationPort } from "../../src/certification/live/publication-ports";
import { runLivePublicationCertification } from "../../src/certification/live/publication";

const digest = (letter: string) => letter.repeat(64);
const pubkey = "a".repeat(64);
const bytes = new TextEncoder().encode("sealed napplet deployment bytes");
const file = { path: "/index.html", mimeType: "text/html", bytes, sha256: await sha256(bytes), size: bytes.byteLength };
const aggregateSha256 = canonicalSealedDeployAggregate([file]);

async function sha256(value: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const artifact = {
  accountId: "account:publication", sessionId: "session:publication", artifactId: "artifact:publication", artifactVersion: 1,
  aggregateSha256, manifestSha256: digest("b"), verificationEvidenceSha256: digest("c"), sealedObjectGeneration: "generation:1",
  sealedObjectSha256: digest("d"), sealedFiles: [{ path: file.path, mimeType: file.mimeType, sha256: file.sha256, size: file.size }],
  entrypoint: "/index.html", normalizedDTag: "sealed-napplet", requiredCapabilities: [], optionalCapabilities: [],
  policyIdentity: "policy:publication", toolchainIdentity: "toolchain:publication", runtimeCompatibilityIdentity: "runtime:publication",
} as const;
const ownerEvent = { id: digest("e"), pubkey, created_at: 1, kind: 35129 as const, tags: [["d", artifact.normalizedDTag]], content: "", sig: "c".repeat(128) };
const sourceSnapshot = {
  identity: { version: "0.5.2" as const, sourceCommit: "1a38b9150f3a3da148091c11bce4d0365f7298e5", linuxSha256: "46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e" },
  sourceFiles: {
    "deploy-network.ts": "b28dd1966718512617c139aaede77b3ed9a4b46cfbd7a2bb642eb046c46c4440", "blossom-upload.ts": "078970ea91ff2d7f35c7d45798ad05232a082ea6a124424069aae70dbf74e71e",
    "types.ts": "18c313d152bd4e2eb4f382d16f60bd361212566e42091f8bf27b9dd6df800f10", "cli.ts": "bc1ae1fc5919a5d6a4b4ace181989915090f18ae1b409193ba11dc4e516ca430",
    "deploy-plan.ts": "d53317627c99ab38aa702d9218c243d387250a7252ccc31866d2cb989d7e4ac8", "signing.ts": "be5bbc8205227ae09447e87fb0e7d6f0da5f12da6b94601e8609f98b991ef858",
    "discover.ts": "eeb7667d815367377811ac8d909ebee6ebe2fde33002d869335f446fb64a67e9", "manifest.ts": "74b9f5f13079cf451412c30c7ad944e445d31e07a46826792ec0d6b78a30f0a8",
  },
  requiredExports: ["DeployFilePayload", "ServerUploadResult", "RelayPublishResult", "NetworkDeployProgress", "NetworkDeployResult", "uploadFilesToServers", "publishEventWithSimplePool", "networkDeploySucceeded"],
  rejectedRoutes: ["collectDeployFilePayloads", "executeNetworkDeploy", "createDeployPlan", "discoverNapplets", "createDeployManifestTemplates", "signDeployManifestTemplates", "createDeploySigner", "resolveSigningMethod", "main", "root_manifest", "snapshot_manifest", "multi_target", "dependency_build_prebuilt_rebuild", "dry_run_json_stdout"],
  liveExecution: "not_observed" as const,
};

async function authorization() {
  const config = {
    candidateSha256: digest("f"), topologySha256: digest("1"), effectPlanSha256: digest("2"), accountScopeSha256: digest("3"), projectScopeSha256: digest("4"),
    ownerAccountScopeSha256: digest("7"), ownerProjectScopeSha256: digest("8"), attestationAccountScopeSha256: digest("9"), attestationProjectScopeSha256: digest("a"),
  };
  const request = await createAuthorizationRequest({
    candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, effectPlanSha256: config.effectPlanSha256,
    controllerStateSha256: digest("5"), providerCapabilitiesSha256: digest("6"),
    orderedEffects: [{ id: "sealed-upload", provider: "upload", operation: "verify_integration", estimatedCostMicros: 1 }],
    providerScopes: [
      { provider: "attestation_relay", accountScopeSha256: config.attestationAccountScopeSha256, projectScopeSha256: config.attestationProjectScopeSha256 },
      { provider: "owner_relay", accountScopeSha256: config.ownerAccountScopeSha256, projectScopeSha256: config.ownerProjectScopeSha256 },
      { provider: "upload", accountScopeSha256: config.accountScopeSha256, projectScopeSha256: config.projectScopeSha256 },
    ],
    estimate: { currency: "USD", maximumMicros: 1, sourceId: "publication-fixture", observedAtMs: 1, freshUntilMs: 10_000 },
    maximumRunDurationMs: 1_000, cleanupByMs: 9_000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: 9_000,
  });
  return { config, request, receipt: await createAuthorizationReceipt(request) };
}

test("wrong promoted source blocks before the sealed bytes leave the controller", async () => {
  let uploads = 0;
  const source = createNativePromotedNappletCliSource({
    snapshot: { ...sourceSnapshot, identity: { ...sourceSnapshot.identity, linuxSha256: digest("0") } },
    upload: { uploadExact: async () => { uploads += 1; return {}; }, reconcileOriginalUpload: async () => ({ status: "missing" }) },
    relay: { publishOriginalEvent: async () => ({ state: "complete", relayObservation: "relay:unused" }), reconcileOriginalEvent: async () => ({ state: "unknown" }) },
  });
  const adapter = new PromotedNappletCliAdapter({ contract: source.contract, source: source.port });
  const result = await adapter.deployPreSignedNamed({
    operationId: "deploy:intent:publication", artifact, target: { kind: 35129, dTag: artifact.normalizedDTag }, sealedFiles: [file], deployFiles: [file], ownerEvent,
    servers: ["https://blossom.example"], relays: ["wss://relay.example"], authorizeExactHashes: async () => ({}),
  });
  expect(result).toMatchObject({ state: "publication_unavailable", safeReasonCode: "PUBLICATION_UNAVAILABLE" });
  expect(uploads).toBe(0);
});

test("relay persistence binds exact signed owner and attestation events and reconciles only original IDs", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorization();
  const attestationEvent = { id: digest("1"), pubkey: "b".repeat(64), created_at: 2, kind: 30382, tags: [["e", ownerEvent.id], ["a", artifact.aggregateSha256]], content: "cvm build attestation", sig: "d".repeat(128) };
  let ownerPublished = false;
  let attestationPublished = false;
  const relay = createNostrRelayPublicationAdapter({
    config: {
      ...config, intentId: "intent:publication", sealedArtifactSha256: artifact.sealedObjectSha256, aggregateSha256,
      relaySetReference: "relay-set:primary", relaySetSha256: digest("b"), relays: ["wss://relay.example"],
      ownerEvent, attestationEvent, ownerSignerPubkey: ownerEvent.pubkey, attestationSignerPubkey: attestationEvent.pubkey,
    }, request, receipt, now: () => 1_000,
    port: {
      persistSignedEvent: async ({ operationId, eventId }) => { transcript.push(`persist:${operationId}:${eventId}`); },
      observeOriginalEvent: async ({ operationId, eventId }) => {
        const published = operationId.startsWith("owner_manifest") ? ownerPublished : attestationPublished;
        return published ? { status: "complete", operationId, eventId, relaySetReference: "relay-set:primary", relayObservation: `relay:${eventId}` } : { status: "missing" };
      },
      publishSignedEvent: async ({ operationId, eventId, relays }) => {
        transcript.push(`publish:${operationId}:${eventId}`);
        expect(relays).toEqual(["wss://relay.example"]);
        if (operationId.startsWith("owner_manifest")) ownerPublished = true;
        else attestationPublished = true;
      },
    },
  });

  const owner = await relay.publishOwnerManifest({ operationId: "owner_manifest:intent:publication", event: ownerEvent, relays: ["wss://relay.example"] });
  const attestation = await relay.publishAttestation({ operationId: "attestation:intent:publication", event: attestationEvent, relays: ["wss://relay.example"] });
  expect(owner).toMatchObject({ state: "completed", relayObservation: `relay:${ownerEvent.id}` });
  expect(attestation).toMatchObject({ state: "completed", relayObservation: `relay:${attestationEvent.id}` });
  expect(await relay.reconcileOriginalEvent({ operationId: "owner_manifest:intent:publication" })).toMatchObject({ state: "completed", relayObservation: `relay:${ownerEvent.id}` });
  await expect(relay.publishOwnerManifest({ operationId: "owner_manifest:intent:publication", event: { ...ownerEvent, pubkey: "0".repeat(64) }, relays: ["wss://relay.example"] })).rejects.toThrow("NOSTR_RELAY_EVENT_INVALID");
  expect(transcript).toEqual([
    `persist:owner_manifest:intent:publication:${ownerEvent.id}`, `publish:owner_manifest:intent:publication:${ownerEvent.id}`,
    `persist:attestation:intent:publication:${attestationEvent.id}`, `publish:attestation:intent:publication:${attestationEvent.id}`,
  ]);
  expect(JSON.stringify(transcript)).not.toMatch(/nsec|private|secret/i);
});

test("protected publication bridge accepts only exact source, signer, intent, and original operation evidence", async () => {
  const calls: string[] = [];
  const source = createNativePromotedNappletCliSource({
    snapshot: sourceSnapshot,
    upload: { uploadExact: async () => ({ operationId: "deploy:intent:publication", state: "complete", fullServerUploadId: "blossom:location" }), reconcileOriginalUpload: async () => ({ operationId: "deploy:intent:publication", state: "complete", fullServerUploadId: "blossom:location" }) },
    relay: { publishOriginalEvent: async () => ({ operationId: "owner_manifest:intent:publication", state: "complete", relayObservation: "relay:owner" }), reconcileOriginalEvent: async () => ({ operationId: "owner_manifest:intent:publication", state: "complete", relayObservation: "relay:owner" }) },
  });
  const port = createProtectedLivePublicationObservationPort({
    candidateId: digest("f"), sealedArtifactSha256: artifact.sealedObjectSha256, aggregateSha256, source,
    submission: { accountId: artifact.accountId, intentId: "intent:publication", command: { commandId: "command:publication", intentId: "intent:publication", intentFingerprint: digest("c"), operationIds: { deploy: "deploy:intent:publication", ownerManifest: "owner_manifest:intent:publication", attestation: "attestation:intent:publication" } }, event: ownerEvent, signerPubkey: ownerEvent.pubkey },
    publication: {
      submitSignedManifest: async () => { calls.push("submit"); return { status: "partial", intentId: "intent:publication" }; },
      reconcile: async () => { calls.push("reconcile"); return { status: "complete", intentId: "intent:publication", fullServerUploadId: "blossom:location", ownerRelayObservation: "relay:owner", attestationRelayObservation: "relay:attestation" }; },
    },
  });
  const result = await runLivePublicationCertification({ candidate: { id: digest("f"), provider: "modal", image: `registry.example/worker@sha256:${digest("e")}`, sourceSha256: digest("d") }, observationPort: port });
  expect(result).toMatchObject({ status: "passed", reasonCode: "OBSERVATION_COMPLETE" });
  expect(calls).toEqual(["submit", "reconcile"]);
});

test("persists and uploads the exact sealed bytes once, then reconciles only the original upload operation", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorization();
  let completed = false;
  const upload = createExactSealedUploadAdapter({
    config: { ...config, sealedArtifactSha256: artifact.sealedObjectSha256, aggregateSha256, targetReference: "blossom-target:primary", retentionDays: 30 },
    request, receipt, now: () => 1_000,
    port: {
      persist: async ({ operationId }) => { transcript.push(`persist:${operationId}`); },
      observeOriginalUpload: async ({ operationId }) => completed
        ? { status: "complete", operationId, targetReference: "blossom-target:primary", retentionDays: 30, fileChecksums: [file.sha256], locationReference: "blossom:location:one" }
        : { status: "missing" },
      uploadExact: async ({ operationId, files, targetReference, retentionDays }) => {
        transcript.push(`upload:${operationId}`);
        expect(files).toEqual([file]);
        expect(targetReference).toBe("blossom-target:primary");
        expect(retentionDays).toBe(30);
        completed = true;
      },
    },
  });
  const first = await upload.uploadExact({ operationId: "deploy:intent:publication", files: [file], authorizeExactHashes: async (hashes) => { expect(hashes).toEqual([file.sha256]); } });
  const replay = await upload.uploadExact({ operationId: "deploy:intent:publication", files: [file], authorizeExactHashes: async () => { throw new Error("must not authorize replacement upload"); } });
  expect(first).toMatchObject({ state: "complete", operationId: "deploy:intent:publication", fullServerUploadId: "blossom:location:one" });
  expect(replay).toEqual(first);
  expect(transcript).toEqual(["persist:deploy:intent:publication", "upload:deploy:intent:publication", "persist:deploy:intent:publication"]);
});
