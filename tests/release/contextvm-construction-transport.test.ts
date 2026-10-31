import { expect, test } from "bun:test";
import { PrivateKeySigner } from "@contextvm/sdk/signer/private-key-signer";

import {
  assertContextVmCertificationClient,
  openContextVmCertificationClient,
  type ContextVmCertificationConstructionTransport,
} from "../../src/release/deployment/contextvm-client";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";

const digest = (letter: string) => letter.repeat(64);

async function authorization(now: number) {
  const request = await createAuthorizationRequest({
    candidateSha256: digest("a"), topologySha256: digest("b"), effectPlanSha256: digest("c"), controllerStateSha256: digest("d"), providerCapabilitiesSha256: digest("e"),
    orderedEffects: [
      { id: "signed-admission", provider: "contextvm", operation: "verify_integration", estimatedCostMicros: 1 },
      { id: "private-control", provider: "cloud_run", operation: "verify_integration", estimatedCostMicros: 1 },
    ],
    providerScopes: [
      { provider: "contextvm", accountScopeSha256: digest("f"), projectScopeSha256: digest("0") },
      { provider: "cloud_run", accountScopeSha256: digest("f"), projectScopeSha256: digest("0") },
    ],
    estimate: { currency: "USD", maximumMicros: 2, sourceId: "construction-fixture", observedAtMs: now, freshUntilMs: now + 60_000 },
    maximumRunDurationMs: 1_000, cleanupByMs: now + 20_000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: now + 30_000,
  });
  return { request, receipt: await createAuthorizationReceipt(request) };
}

function journal() {
  return new PostgresOperationJournal({ async connect() { throw new Error("CONSTRUCTION_TEST_SQL_MUST_NOT_RUN"); } }, {
    namespace: "contextvm-construction-test",
    scopeSha256: digest("b"),
  });
}

test("deny-effects construction transport performs the real receipt-gated SDK handshake without network I/O", async () => {
  const now = Date.now();
  const { request, receipt } = await authorization(now);
  const events: string[] = [];
  let handler: ((message: unknown) => void) | undefined;
  const transport: ContextVmCertificationConstructionTransport = {
    async start() { events.push("start"); },
    async send(message) {
      const wire = message as Readonly<{ id?: unknown; method?: unknown }>;
      events.push(`send:${String(wire.method)}`);
      if (typeof wire.id === "string") queueMicrotask(() => handler?.({ jsonrpc: "2.0", id: wire.id, result: {} }));
    },
    async close() { events.push("close"); },
    onMessage(next) { events.push("handler"); handler = next; },
  };
  const previous = process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
  process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = "deny";
  try {
    const client = await openContextVmCertificationClient({
      certificationKeyReference: "nostr:construction-fixture", serverPubkey: digest("1"), relays: ["wss://relay.example"],
      signerBroker: { async resolveContextVmCertificationSigner() { return new PrivateKeySigner("2".repeat(64)); } },
      journal: journal(), candidateSha256: digest("a"), topologySha256: digest("b"),
      authorizationRequest: request, authorizationReceipt: receipt, now: () => now, timeoutMs: 1_000, constructionTransport: transport,
    });
    assertContextVmCertificationClient(client);
    expect(events).toEqual(["handler", "start", "send:initialize", "send:notifications/initialized"]);
    await client.close();
    expect(events).toEqual(["handler", "start", "send:initialize", "send:notifications/initialized", "close"]);
  } finally {
    if (previous === undefined) delete process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
    else process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = previous;
  }
});

test("construction transport is rejected before signer, network, or SQL activity outside deny-effects mode", async () => {
  const now = Date.now();
  const { request, receipt } = await authorization(now);
  let calls = 0;
  const transport: ContextVmCertificationConstructionTransport = {
    async start() { calls += 1; }, async send() { calls += 1; }, async close() { calls += 1; }, onMessage() { calls += 1; },
  };
  const previous = process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
  delete process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
  try {
    await expect(openContextVmCertificationClient({
      certificationKeyReference: "nostr:construction-fixture", serverPubkey: digest("1"), relays: ["wss://relay.example"],
      signerBroker: { async resolveContextVmCertificationSigner() { calls += 1; return new PrivateKeySigner("2".repeat(64)); } },
      journal: journal(), candidateSha256: digest("a"), topologySha256: digest("b"),
      authorizationRequest: request, authorizationReceipt: receipt, now: () => now, timeoutMs: 1_000, constructionTransport: transport,
    })).rejects.toThrow("CONTEXTVM_CONSTRUCTION_TRANSPORT_DENIED");
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
    else process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = previous;
  }
});
