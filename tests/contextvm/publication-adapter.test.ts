import { describe, expect, test } from "bun:test";

import { ContextVmFundingAdapter } from "../../src/contextvm/adapter";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import type { ContextVmInboundEnvelope, ContextVmTransportPort, ContextVmWireNotification, ContextVmWireResponse } from "../../src/contextvm/sdk-bridge";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { canonicalCapabilityReview } from "../../src/publication/capability-review";
import { probePromotedCliPreSignedRoute } from "../../src/publication/napplet-cli-source-contract";
import { PreviewService } from "../../src/publication/preview-service";
import { DeterministicPreviewHostPort, DeterministicSealedArtifactPort, fixedPhase06Clock, verifiedPhase06Artifact } from "../phase-06/fakes";
import sourceFixture from "../fixtures/phase-06-cli-source-contract.json" with { type: "json" };

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

function adapter(input: Readonly<{ source?: unknown; preview?: ConstructorParameters<typeof ContextVmFundingAdapter>[0]["preview"]; publication?: ConstructorParameters<typeof ContextVmFundingAdapter>[0]["publication"] }> = {}) {
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

  test("blocks an incompatible required capability through the signed preview action before a host descriptor exists", async () => {
    const sealedArtifacts = new DeterministicSealedArtifactPort();
    sealedArtifacts.artifact = {
      ...verifiedPhase06Artifact,
      accountId: await accountIdForPrincipal({ pubkey }),
      manifestCapabilities: verifiedPhase06Artifact.manifestCapabilities?.map((capability) => capability.name === "notes.read" ? { ...capability, available: false } : capability),
    };
    const host = new DeterministicPreviewHostPort();
    const service = new PreviewService({ sealedArtifacts, host, clock: fixedPhase06Clock(), capabilityReview: canonicalCapabilityReview });
    let facadeCalls = 0;
    const { sut, transport } = adapter({ preview: {
      previewVerifiedArtifact: async (input) => {
        facadeCalls += 1;
        return service.previewVerifiedArtifact(input as { accountId: string; sessionId: string; artifactId: string; runtimeVariant: string });
      },
      reviewCapabilities: async () => { throw new Error("REVIEW_NOT_EXPECTED"); },
    } });

    await sut.handle(request("preview", { action: "descriptor", sessionId: verifiedPhase06Artifact.sessionId, artifactId: verifiedPhase06Artifact.artifactId, runtimeVariant: "napplet-host/v1" }));

    expect(facadeCalls).toBe(1);
    expect(host.calls).toBe(0);
    expect(host.descriptors).toEqual([]);
    expect(transport.responses.at(-1)?.response).toMatchObject({ result: { status: "denied", safeReasonCode: "preview_not_available", nextAction: "preview" } });
    expect(JSON.stringify(transport.responses)).not.toContain("previewGrantId");
    expect(JSON.stringify(transport.responses)).not.toMatch(/authority|signer|relay|storage|cookie/i);
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
      source: probePromotedCliPreSignedRoute(sourceFixture),
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

  test("rejects a forged or mutated available contract at the ContextVM dispatch boundary before facade effects", async () => {
    const verified = probePromotedCliPreSignedRoute(sourceFixture);
    if (verified.status !== "available") throw new Error("PROMOTED_CLI_FIXTURE_UNAVAILABLE");
    const candidates = [
      { status: "available", liveExecution: "not_observed" },
      { ...verified, identity: { ...verified.identity, linuxSha256: "0".repeat(64) } },
      { ...verified, sourceFiles: { ...verified.sourceFiles, "deploy-network.ts": "0".repeat(64) } },
      { ...verified, surface: { ...verified.surface, rejectedRoutes: verified.surface.rejectedRoutes.slice(1) } },
    ];
    for (const source of candidates) {
      let effects = 0;
      const { sut, transport } = adapter({ source, publication: {
        createIntent: async () => { effects += 1; return {}; }, submitSignedManifest: async () => { effects += 1; return {}; }, status: async () => { effects += 1; return {}; }, reconcile: async () => { effects += 1; return {}; },
      } });
      await sut.handle(request("publication", { action: "create_intent", sessionId: "session:one", artifactId: "artifact:one", runtimeVariant: "runtime:one", idempotencyKey: "intent:one", purpose: "Publish this napplet", consent: "approved" }));
      expect(effects).toBe(0);
      expect(transport.responses.at(-1)?.response).toMatchObject({ result: { status: "publication_unavailable" } });
    }
  });
});
