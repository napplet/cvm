import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/contextvm-phase-03.json";
import { buildContextVmAnnouncement } from "../../src/contextvm/announcement";
import { ContextVmFundingAdapter } from "../../src/contextvm/adapter";
import { ContextVmSdkBridge, type ContextVmInboundEnvelope, type ContextVmTransportPort, type ContextVmWireNotification, type ContextVmWireResponse } from "../../src/contextvm/sdk-bridge";
import { FundingService } from "../../src/funding/funding-service";
import { AccountStatusService } from "../../src/funding/account-status";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { runContextVmAllowlistProbe } from "../support/phase-04/session-artifact-probes";

class FakeContextVmTransport implements ContextVmTransportPort {
  inbound?: (input: ContextVmInboundEnvelope) => Promise<void>;
  responses: Array<{ clientPubkey: string; requestEventId: string; response: ContextVmWireResponse }> = [];
  notifications: Array<{ clientPubkey: string; requestEventId: string; notification: ContextVmWireNotification }> = [];
  canonicalCalls: Array<{ clientPubkey: string; method: string; params: unknown }> = [];
  configured = false;

  onInbound(handler: (input: ContextVmInboundEnvelope) => Promise<void>): void { this.inbound = handler; }
  configureAnnouncement(): void { this.configured = true; }
  async sendResponse(clientPubkey: string, response: ContextVmWireResponse, requestEventId: string): Promise<void> { this.responses.push({ clientPubkey, response, requestEventId }); }
  async sendNotification(clientPubkey: string, notification: ContextVmWireNotification, requestEventId: string): Promise<void> { this.notifications.push({ clientPubkey, notification, requestEventId }); }
  canonicalInvocation(clientPubkey: string, method: string, params: unknown) {
    this.canonicalCalls.push({ clientPubkey, method, params });
    return { clientPubkey, invocationHash: `${clientPubkey.slice(0, 8)}:${method}` };
  }
}

function envelope(overrides: Partial<ContextVmInboundEnvelope> = {}): ContextVmInboundEnvelope {
  const requestEventId = "event-0001";
  return {
    verifiedClientPubkey: fixture.requests.verifiedPubkey,
    requestEventId,
    rawEvent: {
      id: requestEventId,
      tags: [["pmi", fixture.requests.cashuPmi], ["payment_interaction", "explicit_gating"], ["direct_payment", fixture.requests.cashuPmi, fixture.requests.directPayment]],
    },
    request: {
      id: "request-0001",
      method: "tools/call",
      params: {
        name: "top_up",
        arguments: { idempotencyKey: "topup-0001", pmi: fixture.requests.cashuPmi, mode: "explicit_gating" },
        _meta: { progressToken: "untrusted-and-excluded-from-identity" },
      },
    },
    ...overrides,
  };
}

async function credit(service: FundingService, pubkey = fixture.requests.verifiedPubkey) {
  return service.execute({
    principal: { pubkey }, kind: "credit_settlement", idempotencyKey: "seed-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: "seed-topup", rail: "lightning", unit: "sat", amount: "500", externalReference: "external-seed", settlementReference: "settlement-seed", verifiedAt: "2026-08-04T00:00:00.000Z" } },
  });
}

describe("ContextVM v1 announcement", () => {
  test("announcement is canonical, truthful, and limited to the two v1 top-up PMIs", () => {
    const first = buildContextVmAnnouncement(fixture.announcement);
    const second = buildContextVmAnnouncement(structuredClone(fixture.announcement));

    expect(first).toEqual(second);
    expect(first.tags).toEqual([
      ["cap", "top_up", "1-1000000", "sat"],
      ["payment_interaction", "explicit_gating"],
      ["payment_interaction", "transparent"],
      ["pmi", "bitcoin-cashu-v4-direct"],
      ["pmi", "bitcoin-lightning-bolt11"],
    ]);
    expect(first.metadata.tools).toEqual([
      { name: "account_status", available: true, planned: false, invocable: true },
      { name: "funded_admission", available: true, planned: false, invocable: true },
      { name: "preview", available: false, planned: true, invocable: false },
      { name: "publication", available: false, planned: true, invocable: false },
      { name: "resume_session", available: true, planned: false, invocable: true },
      { name: "revise_session", available: true, planned: false, invocable: true },
      { name: "session_status", available: true, planned: false, invocable: true },
      { name: "start_session", available: true, planned: false, invocable: true },
      { name: "top_up", available: true, planned: false, invocable: true },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/x402|l402|private|secret|invoice|preimage/i);
    expect(first.metadata.generationPrice).toBeUndefined();
  });
});

describe("verified ContextVM funding adapter", () => {
  test("exposes exactly the locked start, revise, status, and explicit resume tools without registering repair", async () => {
    const probe = await runContextVmAllowlistProbe();
    expect(probe.calls).toEqual({ start: expect.any(Array), revise: expect.any(Array), status: expect.any(Array) });
    expect(probe.calls.start).toHaveLength(1);
    expect(probe.calls.revise).toHaveLength(1);
    expect(probe.calls.status).toHaveLength(1);
    expect(probe.responses.at(-1)?.response).toMatchObject({ error: { code: -32602 } });
    const service = new FundingService(new TransactionalMemoryFundingStore());
    const transport = new FakeContextVmTransport();
    const calls: Record<string, unknown[]> = { start: [], revise: [], status: [], resume: [] };
    const adapter = new ContextVmFundingAdapter({
      service, transport,
      generation: {
        startSession: async (input) => { calls.start.push(input); return { status: "completed", code: "ACTION_COMMITTED", accountId: "account:internal", sessionId: "session:one", sessionVersion: 1, artifactVersion: 1, confirmedSpend: "7", remainingCap: "93", remainingBalance: "493", nextAction: "revise_session", operationId: "operation:one" }; },
        reviseSession: async (input) => { calls.revise.push(input); return { status: "denied", code: "STALE_SESSION_VERSION" }; },
      },
      sessionStatus: { read: async (input) => { calls.status.push(input); return { status: "not_found_or_denied" }; } },
      continuation: { resumeSession: async (input) => { calls.resume.push(input); return { status: "restored", code: "RESUME_RESTORED", sessionId: "session:one", checkpointId: "checkpoint:one", pendingActionReference: "pending:one" }; } },
    });

    await adapter.handle(envelope({ request: { id: "start-1", method: "tools/call", params: { name: "start_session", arguments: { admissionReference: "admission:one", idempotencyKey: "start-one", maximum: "100", idea: "A tiny focused napplet" } } } }));
    expect(calls.start).toHaveLength(1);
    expect(transport.responses.at(-1)?.response).toMatchObject({ result: { status: "completed", sessionId: "session:one", confirmedSpend: "7" } });
    expect(JSON.stringify(transport.responses.at(-1)?.response)).not.toMatch(/account:internal|provider|prompt|repair/i);

    await adapter.handle(envelope({ request: { id: "revise-1", method: "tools/call", params: { name: "revise_session", arguments: { sessionId: "session:one", admissionReference: "admission:one", idempotencyKey: "revise-one", expectedVersion: 1, maximum: "100", revision: "Change only the title" } } } }));
    expect(calls.revise).toHaveLength(1);
    expect(transport.responses.at(-1)?.response).toMatchObject({ result: { status: "denied", code: "STALE_SESSION_VERSION" } });

    await adapter.handle(envelope({ request: { id: "status-1", method: "tools/call", params: { name: "session_status", arguments: { sessionId: "session:one", billing: { limit: 1 } } } } }));
    expect(calls.status).toHaveLength(1);
    expect(transport.responses.at(-1)?.response).toMatchObject({ result: { status: "not_found_or_denied" } });

    const accountId = await accountIdForPrincipal({ pubkey: fixture.requests.verifiedPubkey });
    await adapter.handle(envelope({ request: { id: "resume-1", method: "tools/call", params: { name: "resume_session", arguments: { sessionId: "session:one", checkpointId: "checkpoint:one", expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "resume-one", approvePendingAction: true, capApprovalReference: "admission:one", pendingAction: { reference: "pending:one", fingerprint: "a".repeat(64), kind: "revise_session", maximum: "100" } } } } }));
    expect(calls.resume).toEqual([{ principal: { id: accountId }, sessionId: "session:one", checkpointId: "checkpoint:one", expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "resume-one", approvePendingAction: true, capApprovalReference: "admission:one", pendingAction: { reference: "pending:one", fingerprint: "a".repeat(64), kind: "revise_session", maximum: "100" } }]);
    expect(transport.responses.at(-1)).toMatchObject({ requestEventId: "event-0001", response: { result: { status: "restored", sessionId: "session:one", checkpointId: "checkpoint:one" } } });
    expect(JSON.stringify(transport.responses.at(-1))).not.toMatch(/account:|provider|archive|credential|reasoning|cashu|allocation|lease|action-budget/i);

    await adapter.handle(envelope({ request: { id: "resume-invalid", method: "tools/call", params: { name: "resume_session", arguments: { sessionId: "session:one", checkpointId: "checkpoint:one", expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "resume-invalid", approvePendingAction: true, capApprovalReference: "admission:one", principal: { id: "account:forged" }, pendingAction: { reference: "pending:one", fingerprint: "a".repeat(64), kind: "revise_session", maximum: "100" } } } } }));
    expect(transport.responses.at(-1)?.response).toMatchObject({ error: { code: -32602 } });
    expect(calls.resume).toHaveLength(1);

    await adapter.handle(envelope({ request: { id: "repair-1", method: "tools/call", params: { name: "trigger_validation_repair", arguments: {} } } }));
    expect(transport.responses.at(-1)?.response).toMatchObject({ error: { code: -32602 } });
    expect(calls).toEqual({ start: expect.any(Array), revise: expect.any(Array), status: expect.any(Array), resume: expect.any(Array) });
  });

  test("forwards only an SDK-correlated signed event and preserves the SDK-verified sender", async () => {
    let inbound: ((message: unknown, context: { clientPubkey: string }) => Promise<void> | void) | undefined;
    let event: { id: string; tags: string[][] } | undefined = {
      id: "signed-event-001",
      tags: [["pmi", fixture.requests.cashuPmi]],
    };
    const bridge = new ContextVmSdkBridge({
      setAnnouncementExtraTags: () => undefined,
      setAnnouncementPricingTags: () => undefined,
      setSupportedPaymentInteraction: () => undefined,
      getNostrRequestEvent: () => event,
      set onmessage(_handler: undefined) {},
      set onmessageWithContext(handler: typeof inbound) { inbound = handler; },
    } as never);
    const delivered: ContextVmInboundEnvelope[] = [];
    bridge.onInbound(async (value) => { delivered.push(value); });

    await inbound?.({
      id: "rpc-001",
      method: "tools/call",
      params: { _meta: { requestEventId: "signed-event-001" }, name: "account_status", arguments: {} },
    }, { clientPubkey: fixture.requests.verifiedPubkey });
    expect(delivered).toEqual([{
      verifiedClientPubkey: fixture.requests.verifiedPubkey,
      requestEventId: "signed-event-001",
      rawEvent: event,
      request: { id: "rpc-001", method: "tools/call", params: { _meta: { requestEventId: "signed-event-001" }, name: "account_status", arguments: {} } },
    }]);

    event = { id: "different-event", tags: [] };
    await inbound?.({
      id: "rpc-002",
      method: "tools/call",
      params: { _meta: { requestEventId: "signed-event-001" }, name: "account_status", arguments: {} },
    }, { clientPubkey: fixture.requests.forgedPubkey });
    expect(delivered).toHaveLength(1);
  });

  test("SDK bridge confines the pinned transport setters and canonical explicit-gating identity to the adapter folder", () => {
    const configured: Record<string, unknown> = {};
    const bridge = new ContextVmSdkBridge({
      setAnnouncementExtraTags: (tags: string[][]) => { configured.extra = tags; },
      setAnnouncementPricingTags: (tags: string[][]) => { configured.pricing = tags; },
      setSupportedPaymentInteraction: (mode: string) => { configured.interaction = mode; },
    } as never);
    bridge.configureAnnouncement(buildContextVmAnnouncement(fixture.announcement));
    const canonical = bridge.canonicalInvocation(fixture.requests.verifiedPubkey, "tools/call", { name: "top_up", _meta: { progressToken: "changes" } });
    expect(configured).toEqual({
      extra: [["payment_interaction", "explicit_gating"], ["payment_interaction", "transparent"], ["pmi", "bitcoin-cashu-v4-direct"], ["pmi", "bitcoin-lightning-bolt11"]],
      pricing: [["cap", "top_up", "1-1000000", "sat"]], interaction: "optional",
    });
    expect(canonical).toMatchObject({ clientPubkey: fixture.requests.verifiedPubkey, invocationHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  test("uses only SDK-verified sender identity and durable FundingService replay across adapter instances", async () => {
    const store = new TransactionalMemoryFundingStore();
    const service = new FundingService(store);
    await credit(service);
    const transport = new FakeContextVmTransport();
    const admissions = { admit: async () => ({ status: "accepted" as const, accountId: "account:verified", reference: "capacity:server-owned", approvedCap: "500", heldAmount: "500", unit: "sat" as const }) } as never;
    const adapter = new ContextVmFundingAdapter({ service, transport, admissions });
    const admission = envelope({
      request: { id: "request-0002", method: "tools/call", params: { name: "funded_admission", arguments: { idempotencyKey: "admission-0001", requestedCap: "700", unit: "sat" } } },
      rawEvent: { id: "event-0002", tags: [["payment_interaction", "transparent"]] }, requestEventId: "event-0002",
    });

    await adapter.handle(admission);
    const first = transport.responses.at(-1)?.response;
    expect(first).toMatchObject({ result: { status: "accepted", payment: { generationPriceWaivedForAdmission: true } } });
    expect(transport.notifications.at(-1)).toMatchObject({ requestEventId: "event-0002" });

    const secondTransport = new FakeContextVmTransport();
    const second = new ContextVmFundingAdapter({ service, transport: secondTransport, admissions });
    await second.handle(envelope({ ...admission, requestEventId: "event-0003", rawEvent: { id: "event-0003", tags: [["payment_interaction", "transparent"]] } }));
    expect(secondTransport.responses.at(-1)?.response).toEqual(first);
    await adapter.handle(admission);
    await adapter.handle(envelope({ ...admission, requestEventId: "event-0004", rawEvent: { id: "event-0004", tags: [["payment_interaction", "transparent"]] }, request: { ...admission.request, params: { name: "funded_admission", arguments: { idempotencyKey: "admission-0001", requestedCap: "701", unit: "sat", capacity: { reference: "forged", usable: true } } } } }));
    expect(transport.responses.at(-1)?.response).toMatchObject({ error: { code: -32602 } });
    // The adapter cannot manufacture a funding hold: only the injected
    // server-owned admission facade can do so.
    expect(store.activeHolds).toHaveLength(0);

    await adapter.handle(envelope({ request: { id: "request-0004", method: "tools/call", params: { name: "account_status", arguments: { pubkey: fixture.requests.forgedPubkey } } } }));
    expect(transport.responses.at(-1)?.response).toMatchObject({ error: { code: -32602 } });
    expect((await service.status({ pubkey: fixture.requests.verifiedPubkey })).accountId).not.toEqual((await service.status({ pubkey: fixture.requests.forgedPubkey })).accountId);
  });

  test("requires exact CEP-8 negotiation, protects bearer bytes, correlates redacted responses, and denies malformed wire facts", async () => {
    const service = new FundingService(new TransactionalMemoryFundingStore());
    const transport = new FakeContextVmTransport();
    const cashuCalls: unknown[] = [];
    const adapter = new ContextVmFundingAdapter({
      service, transport,
      topUps: { lightning: { begin: async () => ({ state: "pending" }) }, cashu: { submit: async (input) => { cashuCalls.push(input); return { state: "credited", topUpId: "cashu:one", token: "must-not-leak", invoice: "must-not-leak", proof: "must-not-leak" }; } } },
    });
    await adapter.handle(envelope());
    expect(cashuCalls).toHaveLength(0);
    await adapter.handle(envelope({ request: { id: "request-0001b", method: "tools/call", params: { name: "top_up", arguments: { idempotencyKey: "topup-0001b", pmi: fixture.requests.cashuPmi, mode: "explicit_gating", amount: "21", topUpId: "cashu:one" } } } }));
    expect(cashuCalls).toHaveLength(1);
    expect(transport.responses.at(-1)).toMatchObject({ clientPubkey: fixture.requests.verifiedPubkey, requestEventId: "event-0001", response: { result: { state: "credited", topUpId: "cashu:one" } } });
    expect(transport.notifications.at(-1)).toMatchObject({ requestEventId: "event-0001", notification: { method: "notifications/top_up" } });
    expect(JSON.stringify(transport.responses)).not.toContain(fixture.requests.directPayment);
    expect(JSON.stringify(transport.responses)).not.toMatch(/must-not-leak|token|proof|invoice/i);
    expect(transport.canonicalCalls).toEqual([{ clientPubkey: fixture.requests.verifiedPubkey, method: "tools/call", params: { name: "top_up", arguments: { idempotencyKey: "topup-0001b", pmi: fixture.requests.cashuPmi, mode: "explicit_gating", amount: "21", topUpId: "cashu:one" } } }]);

    await adapter.handle(envelope({ rawEvent: { id: "event-0001", tags: [["pmi", fixture.requests.cashuPmi], ["direct_payment", fixture.requests.cashuPmi, "one"], ["direct_payment", fixture.requests.cashuPmi, "two"]] } }));
    await adapter.handle(envelope({ verifiedClientPubkey: fixture.requests.forgedPubkey.toUpperCase() }));
    await adapter.handle(envelope({ requestEventId: "wrong-event" }));
    expect(transport.responses.slice(-3).every((entry) => "error" in entry.response)).toBe(true);
    expect(cashuCalls).toHaveLength(1);
  });

  test("account_status returns owner-scoped durable rail lifecycle states through ContextVM", async () => {
    const store = new TransactionalMemoryFundingStore();
    const service = new FundingService(store);
    const transport = new FakeContextVmTransport();
    const ownerAccountId = await accountIdForPrincipal({ pubkey: fixture.requests.verifiedPubkey });
    const accountStatus = new AccountStatusService({
      store,
      sessions: { list: async () => ({ active: [], resumable: [], pendingActions: [] }) },
      rails: { list: async ({ accountId }) => accountId === ownerAccountId ? [
        { topUpId: "lightning:pending", rail: "lightning", state: "pending", amount: "20", unit: "sat", createdAt: "2026-08-04T00:00:00.000Z", safeDisplayReference: "lightning:…pending" },
        { topUpId: "cashu:failed", rail: "cashu", state: "failed", amount: "21", unit: "sat", createdAt: "2026-08-04T00:01:00.000Z" },
        { topUpId: "cashu:unknown", rail: "cashu", state: "reconciliation_pending", amount: "22", unit: "sat", createdAt: "2026-08-04T00:02:00.000Z" },
      ] : [] },
    });
    const adapter = new ContextVmFundingAdapter({ service, transport, accountStatus });
    await adapter.handle(envelope({ request: { id: "status-1", method: "tools/call", params: { name: "account_status", arguments: {} } }, rawEvent: { id: "status-event", tags: [] }, requestEventId: "status-event" }));
    expect(transport.responses.at(-1)?.response).toMatchObject({ result: { topUps: [
      { topUpId: "lightning:pending", state: "pending" }, { topUpId: "cashu:failed", state: "failed" }, { topUpId: "cashu:unknown", state: "reconciliation_pending" },
    ] } });
    expect(JSON.stringify(transport.responses.at(-1))).not.toMatch(/token|proof|preimage|invoice|secret|private/iu);
  });

  test("keeps ContextVM and CEP-8 imports out of financial core modules", async () => {
    const corePaths = ["src/funding/funding-service.ts", "src/persistence/funding-store.ts", "src/phase-03/contracts.ts"];
    for (const path of corePaths) {
      const source = await Bun.file(path).text();
      expect(source).not.toMatch(/@contextvm\/sdk|nostr|cep-?8|pmi/i);
    }
  });
});
