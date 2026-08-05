import { describe, expect, test } from "bun:test";

import { ContextVmFundingAdapter } from "../../src/contextvm/adapter";
import type { ContextVmInboundEnvelope, ContextVmTransportPort, ContextVmWireNotification, ContextVmWireResponse } from "../../src/contextvm/sdk-bridge";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

const pubkey = "a".repeat(64);
const sha = "b".repeat(64);

class Transport implements ContextVmTransportPort {
  inbound?: (input: ContextVmInboundEnvelope) => Promise<void>;
  responses: Array<{ response: ContextVmWireResponse; requestEventId: string }> = [];
  notifications: Array<{ notification: ContextVmWireNotification; requestEventId: string }> = [];

  onInbound(handler: (input: ContextVmInboundEnvelope) => Promise<void>): void { this.inbound = handler; }
  configureAnnouncement(): void {}
  async sendResponse(_clientPubkey: string, response: ContextVmWireResponse, requestEventId: string): Promise<void> { this.responses.push({ response, requestEventId }); }
  async sendNotification(_clientPubkey: string, notification: ContextVmWireNotification, requestEventId: string): Promise<void> { this.notifications.push({ notification, requestEventId }); }
  canonicalInvocation(clientPubkey: string, method: string, params: unknown) { return { clientPubkey, invocationHash: `${method}:${JSON.stringify(params).length}` }; }
}

function request(name: "preview" | "publication", argumentsInput: unknown, requestEventId = "event:publication"): ContextVmInboundEnvelope {
  return {
    verifiedClientPubkey: pubkey,
    requestEventId,
    rawEvent: { id: requestEventId, tags: [] },
    request: { id: requestEventId, method: "tools/call", params: { name, arguments: argumentsInput } },
  };
}

function adapter(input: Readonly<{ source?: unknown; preview?: Record<string, (value: unknown) => Promise<unknown>>; publication?: Record<string, (value: unknown) => Promise<unknown>> }> = {}) {
  const transport = new Transport();
  const sut = new ContextVmFundingAdapter({
    service: new FundingService(new TransactionalMemoryFundingStore()),
    transport,
    ...(input.preview ? { preview: input.preview } : {}),
    ...(input.publication ? { publication: input.publication } : {}),
    ...(input.source ? { publicationSourceContract: input.source } : {}),
  });
  return { sut, transport };
}

describe("signed ContextVM preview and publication", () => {
  test("routes strict preview/review commands through the verified owner and emits only safe notifications", async () => {
    const calls: unknown[] = [];
    const { sut, transport } = adapter({ preview: {
      previewVerifiedArtifact: async (value) => { calls.push(value); return { state: "ready", artifactId: "artifact:one", aggregateSha256: sha, previewGrantId: "preview:one", expiresAtMs: 10, capabilityDigest: sha, nextAction: "review_capabilities", providerPayload: "must not leak" }; },
      reviewCapabilities: async (value) => { calls.push(value); return { state: "ready", artifactId: "artifact:one", aggregateSha256: sha, capabilityDigest: sha, required: [], optional: [], nextAction: "sign_manifest" }; },
    } });

    await sut.handle(request("preview", { action: "descriptor", sessionId: "session:one", artifactId: "artifact:one", runtimeVariant: "runtime:one" }));
    await sut.handle(request("preview", { action: "review_capabilities", sessionId: "session:one", artifactId: "artifact:one", runtimeVariant: "runtime:one" }, "event:review"));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ principal: { pubkey }, sessionId: "session:one", artifactId: "artifact:one", requestEventId: "event:publication" });
    expect(transport.responses[0]?.response).toMatchObject({ result: { status: "ready", artifactId: "artifact:one", nextAction: "review_capabilities" } });
    expect(transport.notifications.map((entry) => entry.notification.method)).toEqual(["notifications/preview", "notifications/preview"]);
    expect(JSON.stringify(transport.responses)).not.toContain("providerPayload");
  });

  test("fails closed with publication_unavailable before a facade can observe any action", async () => {
    let effects = 0;
    const { sut, transport } = adapter({ publication: {
      createIntent: async () => { effects += 1; return {}; }, submitSignedManifest: async () => { effects += 1; return {}; }, status: async () => { effects += 1; return {}; }, reconcile: async () => { effects += 1; return {}; },
    }, source: { status: "publication_unavailable", liveExecution: "not_observed", reasonCode: "PROMOTED_IDENTITY_MISMATCH" } });

    await sut.handle(request("publication", { action: "create_intent", sessionId: "session:one", artifactId: "artifact:one", runtimeVariant: "runtime:one", idempotencyKey: "intent:one", purpose: "Publish this napplet", consent: "approved" }));

    expect(effects).toBe(0);
    expect(transport.responses.at(-1)?.response).toMatchObject({ result: { status: "publication_unavailable", nextAction: "preview" } });
    expect(JSON.stringify(transport.responses)).not.toMatch(/PROMOTED_IDENTITY_MISMATCH|provider|store|secret/i);
  });

  test("routes available publication actions with stable signed-event correlation and suppresses unsafe fields", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const { sut, transport } = adapter({
      source: { status: "available", liveExecution: "not_observed", surface: { requiredExports: [], rejectedRoutes: [] } },
      publication: {
        createIntent: async (value) => { calls.push({ name: "create", input: value }); return { state: "intent_ready", intentId: "intent:one", fingerprint: sha, normalizedDTag: "one", capabilityDigest: sha, expiresAtMs: 10, nextAction: "sign_manifest", rawRecord: "forbidden" }; },
        submitSignedManifest: async (value) => { calls.push({ name: "submit", input: value }); return { state: "partial", intentId: "intent:one", artifactId: "artifact:one", nextAction: "reconcile_publication", safeServerEvidenceCount: 1, providerPayload: "forbidden" }; },
        status: async (value) => { calls.push({ name: "status", input: value }); return { state: "intent_ready", intentId: "intent:one", artifactId: "artifact:one", nextAction: "sign_manifest" }; },
        reconcile: async (value) => { calls.push({ name: "reconcile", input: value }); return { state: "publication_reconciliation_pending", intentId: "intent:one", artifactId: "artifact:one", nextAction: "reconcile_publication" }; },
      },
    });
    const command = { commandId: "command:one", intentId: "intent:one", intentFingerprint: sha, operationIds: { deploy: "deploy:intent:one", ownerManifest: "owner_manifest:intent:one", attestation: "attestation:intent:one" } };
    const event = { id: sha, pubkey, created_at: 1, kind: 35129, tags: [["d", "one"]], content: "", sig: "c".repeat(128) };
    await sut.handle(request("publication", { action: "create_intent", sessionId: "session:one", artifactId: "artifact:one", runtimeVariant: "runtime:one", idempotencyKey: "intent:one", purpose: "Publish this napplet", consent: "approved" }));
    await sut.handle(request("publication", { action: "submit_signed_manifest", intentId: "intent:one", command, event }, "event:submit"));
    await sut.handle(request("publication", { action: "status", intentId: "intent:one" }, "event:status"));
    await sut.handle(request("publication", { action: "reconcile", intentId: "intent:one" }, "event:reconcile"));

    expect(calls.map((call) => call.name)).toEqual(["create", "submit", "status", "reconcile"]);
    expect(calls[1]?.input).toMatchObject({ principal: { pubkey }, requestEventId: "event:submit", command, event });
    expect(transport.notifications.map((entry) => entry.notification.method)).toEqual(["notifications/publication", "notifications/publication", "notifications/publication", "notifications/publication"]);
    expect(JSON.stringify(transport.responses)).not.toMatch(/rawRecord|providerPayload|private|secret|credential/i);
  });
});
