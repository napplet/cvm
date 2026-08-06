import { expect, test } from "bun:test";

import {
  createContextVmDeploymentClient,
  createPaymentDeploymentClients,
  createVertexDeploymentClient,
} from "../../src/release/deployment/contextvm-client";

const digest = (letter: string) => letter.repeat(64);

test("contextvm: records only the official SDK correlation and a service-owned key reference", () => {
  const client = createContextVmDeploymentClient({
    serviceKeyReference: "nostr:contextvm-service-key",
    relaySetReference: "relay-set:primary",
    relaySetSha256: digest("a"),
  });

  const correlation = client.correlate({
    clientPubkey: "b".repeat(64), method: "tools/call", params: { name: "session_status", _meta: { progressToken: 1 } },
  });
  expect(correlation.serviceKeyReference).toBe("nostr:contextvm-service-key");
  expect(correlation.invocationSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(correlation)).not.toMatch(/nsec|private|secret/i);
  expect(() => createContextVmDeploymentClient({ serviceKeyReference: "nsec1-do-not-import", relaySetReference: "relay-set:primary", relaySetSha256: digest("a") })).toThrow("DEPLOYMENT_SECRET_REFERENCE_INVALID");
});

test("payments: keep NWC and Cashu consent references distinct and reconcile only the original top-up", async () => {
  const clients = createPaymentDeploymentClients({
    nwcConnectionReference: "nwc:consent:wallet-one",
    cashuWalletReference: "cashu:funded-wallet:one",
  });
  expect(clients.nwc.discovery()).toEqual({ rail: "nwc_lightning", consentReference: "nwc:consent:wallet-one" });
  expect(clients.cashu.discovery()).toEqual({ rail: "cashu", consentReference: "cashu:funded-wallet:one" });
  expect(await clients.nwc.reconcileOriginal({ originalOperationId: "topup-one", receiptOperationId: "topup-one" })).toEqual({ status: "reconciled", originalOperationId: "topup-one" });
  await expect(clients.cashu.reconcileOriginal({ originalOperationId: "topup-one", receiptOperationId: "topup-other" })).resolves.toEqual({ status: "blocked", originalOperationId: "topup-one" });
});

test("vertex: binds a Gemini request to the shared loopback Google client and never reads ambient ADC", async () => {
  const requests: unknown[] = [];
  const client = createVertexDeploymentClient({
    candidateSha256: digest("c"), projectId: "napplet-cvm-run-1", location: "europe-west1", model: "gemini-2.5-pro",
    credentialReference: "gcp:adc:release",
    vertex: {
      predict: async (input) => { requests.push(input); return { status: "completed" as const }; },
    },
  });
  await expect(client.dispatch({ operationId: "vertex-original-op", requestSha256: digest("d") })).resolves.toEqual({ status: "completed", operationId: "vertex-original-op" });
  expect(requests).toEqual([expect.objectContaining({ operationId: "vertex-original-op", region: "europe-west1", modelReference: "gemini-2.5-pro", requestDigest: digest("d") })]);
  expect(await client.reconcileOriginal({ operationId: "vertex-original-op" })).toEqual({ status: "completed", operationId: "vertex-original-op", originalOperationOnly: true });
  expect(() => createVertexDeploymentClient({ candidateSha256: digest("c"), projectId: "napplet-cvm-run-1", location: "europe-west1", model: "gemini-2.5-pro", credentialReference: "ya29.raw-adc", vertex: { predict: async () => ({ status: "completed" as const }) } })).toThrow("DEPLOYMENT_SECRET_REFERENCE_INVALID");
});
