import { expect, test } from "bun:test";

import { createCliUploadDeploymentClients } from "../../src/release/deployment/cli-upload-clients";
import { createRelayDeploymentClients } from "../../src/release/deployment/relay-clients";
import { createContextVmDeploymentClient } from "../../src/release/deployment/contextvm-client";
import { createPaymentDeploymentClients } from "../../src/release/deployment/payment-clients";
import { createVertexDeploymentClient } from "../../src/release/deployment/vertex-client";
import { createCompatibleHostDeploymentClient } from "../../src/release/deployment/compatible-host-client";
import { createNip46DeploymentClient } from "../../src/release/deployment/nip46-signer-client";
import { registerCompleteDeploymentClientFamilies } from "../../src/release/deployment/factory";

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

test("cli-upload: factory registers all ten non-infrastructure provider families", () => {
  const publication = createCliUploadDeploymentClients({ promotedCliSourceReference: "napplet:cli:0.5.2", promotedCliSourceSha256: digest("f"), uploadTargetReference: "blossom:target:primary" });
  const relays = createRelayDeploymentClients({ ownerKeyReference: "nostr:owner-external-nip46", attestationKeyReference: "nostr:attestation-service-key", relaySetReference: "relay-set:primary", relaySetSha256: digest("1") });
  const families = registerCompleteDeploymentClientFamilies({
    contextvm: createContextVmDeploymentClient({ serviceKeyReference: "nostr:contextvm-service-key", relaySetReference: "relay-set:primary", relaySetSha256: digest("2") }),
    payments: createPaymentDeploymentClients({ nwcConnectionReference: "nwc:consent:wallet-one", cashuWalletReference: "cashu:funded-wallet:one" }),
    vertex: createVertexDeploymentClient({ candidateSha256: digest("3"), projectId: "napplet-cvm-run-1", location: "europe-west1", model: "gemini-2.5-pro", credentialReference: "gcp:adc:release", vertex: { predict: async () => ({ status: "blocked" as const }) } }),
    host: createCompatibleHostDeploymentClient({ referenceHostReference: "napplet:reference-host:0.3.1", chromiumReference: "chromium:fixture:123", packageHost: {} as never, browser: {} as never }),
    signer: createNip46DeploymentClient({ disposableClientKeyReference: "nostr:nip46-disposable-client-key", signer: {} as never, ownerEventVerifier: {} as never }),
    publication, relays,
  });
  expect(Object.keys(families)).toEqual(["contextvm", "cep8_lightning", "cashu", "model", "compatible_host", "signer", "promoted_cli", "upload", "owner_relay", "attestation_relay"]);
});
