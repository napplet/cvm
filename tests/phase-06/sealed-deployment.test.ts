import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fixture from "../fixtures/phase-06-cli-source-contract.json" with { type: "json" };
import { PromotedNappletCliAdapter } from "../../src/publication/napplet-cli-adapter.js";
import { probePromotedCliPreSignedRoute } from "../../src/publication/napplet-cli-source-contract.js";
import { DeterministicPromotedNappletCliSource, signedPhase06EventFixture, verifiedPhase06Artifact } from "./fakes.js";

const bytes = new TextEncoder().encode("sealed index bytes");
const sha256 = async (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

test("deploys exact sealed bytes and the completed owner event through only the promoted structured source facade", async () => {
  const source = new DeterministicPromotedNappletCliSource();
  const adapter = new PromotedNappletCliAdapter({ contract: probePromotedCliPreSignedRoute(fixture), source });
  const file = { path: "/index.html", mimeType: "text/html", bytes, sha256: await sha256(bytes), size: bytes.byteLength };
  const result = await adapter.deployPreSignedNamed({
    operationId: "deploy:intent:sealed",
    artifact: verifiedPhase06Artifact,
    target: { kind: 35129, dTag: verifiedPhase06Artifact.normalizedDTag },
    sealedFiles: [file],
    deployFiles: [file],
    ownerEvent: signedPhase06EventFixture,
    servers: ["https://blossom.example"],
    relays: ["wss://relay.example"],
    authorizeExactHashes: async (hashes) => ({ hashes }),
  });
  expect(result).toMatchObject({ state: "completed", fullServerUploadId: "upload:deploy:intent:sealed", relayObservation: "relay:deploy:intent:sealed" });
  expect(source.uploadCalls).toBe(1);
  expect(source.relayCalls).toBe(1);
  expect(source.uploaded[0]).toMatchObject({ files: [{ bytes, sha256: file.sha256 }] });
  expect(source.relayed[0]).toMatchObject({ event: signedPhase06EventFixture });
});

test("fails closed before source calls for unavailable source, altered bytes, wrong named target, or incomplete upload", async () => {
  const source = new DeterministicPromotedNappletCliSource();
  const file = { path: "/index.html", mimeType: "text/html", bytes, sha256: await sha256(bytes), size: bytes.byteLength };
  const input = {
    operationId: "deploy:intent:sealed", artifact: verifiedPhase06Artifact, target: { kind: 35129 as const, dTag: verifiedPhase06Artifact.normalizedDTag }, sealedFiles: [file], deployFiles: [file], ownerEvent: signedPhase06EventFixture, servers: ["https://blossom.example"], relays: ["wss://relay.example"], authorizeExactHashes: async (hashes: readonly string[]) => ({ hashes }),
  };
  await expect(new PromotedNappletCliAdapter({ contract: { status: "publication_unavailable", liveExecution: "not_observed", reasonCode: "SOURCE_SNAPSHOT_INVALID" }, source }).deployPreSignedNamed(input)).resolves.toMatchObject({ state: "publication_unavailable" });
  await expect(new PromotedNappletCliAdapter({ contract: { status: "available", liveExecution: "not_observed" } as never, source }).deployPreSignedNamed(input)).resolves.toMatchObject({ state: "publication_unavailable" });
  await expect(new PromotedNappletCliAdapter({ contract: probePromotedCliPreSignedRoute(fixture), source }).deployPreSignedNamed({ ...input, target: { kind: 15129, dTag: "root" } as unknown as { kind: 35129; dTag: string } })).rejects.toThrow("SEALED_NAMED_DEPLOY_INVALID");
  expect(source.uploadCalls).toBe(0);
});

test("rejects a self-consistent substituted file set that does not match the trusted sealed manifest", async () => {
  const source = new DeterministicPromotedNappletCliSource();
  const adapter = new PromotedNappletCliAdapter({ contract: probePromotedCliPreSignedRoute(fixture), source });
  const substitutedBytes = new TextEncoder().encode("substituted payload");
  const substituted = { path: "/index.html", mimeType: "text/html", bytes: substitutedBytes, sha256: await sha256(substitutedBytes), size: substitutedBytes.byteLength };
  await expect(adapter.deployPreSignedNamed({
    operationId: "deploy:intent:substituted",
    artifact: verifiedPhase06Artifact,
    target: { kind: 35129, dTag: verifiedPhase06Artifact.normalizedDTag },
    sealedFiles: [substituted],
    deployFiles: [substituted],
    ownerEvent: signedPhase06EventFixture,
    servers: ["https://blossom.example"],
    relays: ["wss://relay.example"],
    authorizeExactHashes: async (hashes) => ({ hashes }),
  })).rejects.toThrow("SEALED_NAMED_DEPLOY_INVALID");
  expect(source.uploadCalls).toBe(0);
});

test("locally fails closed when source callbacks claim success over partial or unknown relay outcomes", async () => {
  const file = { path: "/index.html", mimeType: "text/html", bytes, sha256: await sha256(bytes), size: bytes.byteLength };
  const input = {
    operationId: "deploy:intent:local-outcome",
    artifact: verifiedPhase06Artifact,
    target: { kind: 35129 as const, dTag: verifiedPhase06Artifact.normalizedDTag },
    sealedFiles: [file],
    deployFiles: [file],
    ownerEvent: signedPhase06EventFixture,
    servers: ["https://blossom.example"],
    relays: ["wss://relay.example"],
    authorizeExactHashes: async (hashes: readonly string[]) => ({ hashes }),
  };
  for (const relayResult of ["partial", "unknown"] as const) {
    const source = new DeterministicPromotedNappletCliSource();
    source.relayResult = relayResult;
    source.networkDeploySucceeded = () => true;
    const result = await new PromotedNappletCliAdapter({ contract: probePromotedCliPreSignedRoute(fixture), source }).deployPreSignedNamed(input);
    expect(result.state).toBe(relayResult);
    expect(source.networkSuccessCalls).toBe(0);
  }
});

test("converts incomplete source completion reports to unknown instead of publishing a completed result", async () => {
  const source = new DeterministicPromotedNappletCliSource();
  source.uploadFilesToServers = async ({ operationId }) => ({ operationId, state: "complete", fullServerUploadId: undefined });
  const file = { path: "/index.html", mimeType: "text/html", bytes, sha256: await sha256(bytes), size: bytes.byteLength };
  await expect(new PromotedNappletCliAdapter({ contract: probePromotedCliPreSignedRoute(fixture), source }).deployPreSignedNamed({
    operationId: "deploy:intent:missing-upload-evidence",
    artifact: verifiedPhase06Artifact,
    target: { kind: 35129, dTag: verifiedPhase06Artifact.normalizedDTag },
    sealedFiles: [file],
    deployFiles: [file],
    ownerEvent: signedPhase06EventFixture,
    servers: ["https://blossom.example"],
    relays: ["wss://relay.example"],
    authorizeExactHashes: async (hashes) => ({ hashes }),
  })).resolves.toMatchObject({ state: "unknown" });
  expect(source.relayCalls).toBe(0);
});
