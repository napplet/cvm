import { expect, test } from "bun:test";

import { createContextVmDeploymentClient } from "../../src/release/deployment/contextvm-client";
import { createPaymentDeploymentClients } from "../../src/release/deployment/payment-clients";
import { createVertexDeploymentClient } from "../../src/release/deployment/vertex-client";
import { registerDeploymentClientFamilies } from "../../src/release/deployment/factory";

const digest = (letter: string) => letter.repeat(64);
const vertexPrice = { sourceUrl: "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", sourceDocumentSha256: digest("1"), quoteSha256: digest("2"), observedAtMs: 1_000, freshUntilMs: 2_000, effectiveFromMs: 900, effectiveUntilMs: 3_000, currency: "USD" as const, inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 };
function vertexJournal() { const values = new Map<string, unknown>(); return { async claim(entry: { operationId: string }) { const prior = values.get(entry.operationId); if (prior) return { claimed: false, entry: prior }; values.set(entry.operationId, entry); return { claimed: true, entry }; }, async read(operationId: string) { return values.get(operationId); }, async write(entry: { operationId: string }) { values.set(entry.operationId, entry); } }; }

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
    candidateSha256: digest("c"), projectId: "napplet-cvm-run-1", location: "global", model: "gemini-4-argon",
    credentialReference: "gcp:adc:release", price: vertexPrice, journal: vertexJournal(),
    interactions: {
      create: async (input) => { requests.push(input); return { id: "original", model: "gemini-4-argon", input: input.input, status: "completed" as const, created: "2026-10-27T00:00:00.000Z", output_text: "{}", usage: { totalInputTokens: 1, totalCachedTokens: 0, totalOutputTokens: 1, totalThoughtTokens: 0, totalToolUseTokens: 0 } }; },
      get: async () => undefined,
      list: async () => ({ interactions: [] }),
    },
    now: () => 1_500,
  });
  await expect(client.dispatch({ operationId: "vertex-original-op", idea: "a napplet", systemInstruction: "JSON only", maximumOutputTokens: 32 })).resolves.toMatchObject({ status: "completed", operationId: "vertex-original-op" });
  expect(requests).toEqual([expect.objectContaining({ location: "global", model: "gemini-4-argon", store: true })]);
  expect(await client.reconcileOriginal({ operationId: "vertex-original-op" })).toMatchObject({ status: "completed", operationId: "vertex-original-op" });
  expect(() => createVertexDeploymentClient({ candidateSha256: digest("c"), projectId: "napplet-cvm-run-1", location: "global", model: "gemini-3.8-flash", credentialReference: "ya29.raw-adc", price: vertexPrice, journal: vertexJournal(), interactions: { create: async () => undefined, get: async () => undefined, list: async () => ({ interactions: [] }) } })).toThrow();
});

test("contextvm: factory registers the four distinct non-infrastructure families", () => {
  const contextvm = createContextVmDeploymentClient({ serviceKeyReference: "nostr:contextvm-service-key", relaySetReference: "relay-set:primary", relaySetSha256: digest("e") });
  const payments = createPaymentDeploymentClients({ nwcConnectionReference: "nwc:consent:wallet-one", cashuWalletReference: "cashu:funded-wallet:one" });
  const vertex = createVertexDeploymentClient({ candidateSha256: digest("f"), projectId: "napplet-cvm-run-1", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:release", price: vertexPrice, journal: vertexJournal(), interactions: { create: async () => undefined, get: async () => undefined, list: async () => ({ interaction_metadatas: [] }) } });
  expect(Object.keys(registerDeploymentClientFamilies({ contextvm, payments, vertex }))).toEqual(["contextvm", "cep8_lightning", "cashu", "model"]);
});
