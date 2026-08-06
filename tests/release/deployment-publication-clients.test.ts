import { expect, test } from "bun:test";

import { createCliUploadDeploymentClients } from "../../src/release/deployment/cli-upload-clients";
import { createRelayDeploymentClients } from "../../src/release/deployment/relay-clients";

const digest = (letter: string) => letter.repeat(64);

test("cli-upload: pins promoted CLI source and reconciles only the exact original upload", async () => {
  const clients = createCliUploadDeploymentClients({
    promotedCliSourceReference: "napplet:cli:0.5.2",
    promotedCliSourceSha256: digest("a"),
    uploadTargetReference: "blossom:target:primary",
  });
  expect(clients.promotedCli.discovery()).toEqual({ sourceReference: "napplet:cli:0.5.2", sourceSha256: digest("a"), command: ["napplet", "deploy", "--pre-signed"] });
  expect(await clients.upload.reconcileOriginal({ originalOperationId: "bud-original-op", observedOperationId: "bud-original-op", fileChecksums: [digest("b")] })).toEqual({ status: "reconciled", operationId: "bud-original-op" });
  await expect(clients.upload.reconcileOriginal({ originalOperationId: "bud-original-op", observedOperationId: "bud-other-op", fileChecksums: [digest("b")] })).resolves.toEqual({ status: "blocked", operationId: "bud-original-op" });
  expect(() => createCliUploadDeploymentClients({ promotedCliSourceReference: "napplet:cli:latest", promotedCliSourceSha256: digest("a"), uploadTargetReference: "blossom:target:primary" })).toThrow("DEPLOYMENT_PROMOTED_CLI_INVALID");
});

test("relays: keep fixture owner and service attestation authority separate", async () => {
  const clients = createRelayDeploymentClients({
    ownerKeyReference: "nostr:owner-external-nip46",
    attestationKeyReference: "nostr:attestation-service-key",
    relaySetReference: "relay-set:primary",
    relaySetSha256: digest("c"),
  });
  expect(clients.owner.discovery()).toEqual({ role: "owner", keyReference: "nostr:owner-external-nip46", relaySetReference: "relay-set:primary", relaySetSha256: digest("c") });
  expect(clients.attestation.discovery()).toEqual({ role: "attestation", keyReference: "nostr:attestation-service-key", relaySetReference: "relay-set:primary", relaySetSha256: digest("c") });
  expect(await clients.owner.reconcileOriginal({ originalOperationId: "owner-original-op", observedOperationId: "owner-original-op", eventSha256: digest("d") })).toEqual({ status: "reconciled", operationId: "owner-original-op" });
  await expect(clients.attestation.reconcileOriginal({ originalOperationId: "attestation-original-op", observedOperationId: "owner-original-op", eventSha256: digest("e") })).resolves.toEqual({ status: "blocked", operationId: "attestation-original-op" });
  expect(() => createRelayDeploymentClients({ ownerKeyReference: "nostr:shared-service-key", attestationKeyReference: "nostr:shared-service-key", relaySetReference: "relay-set:primary", relaySetSha256: digest("c") })).toThrow("DEPLOYMENT_RELAY_KEY_ROLE_INVALID");
});
