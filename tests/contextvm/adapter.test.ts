import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/contextvm-phase-03.json";
import { buildContextVmAnnouncement } from "../../src/contextvm/announcement";
import { ContextVmFundingAdapter } from "../../src/contextvm/adapter";
import type { ContextVmInboundEnvelope, ContextVmTransportPort, ContextVmWireNotification, ContextVmWireResponse } from "../../src/contextvm/sdk-bridge";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

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
      { name: "generation", available: false, planned: true, invocable: false },
      { name: "preview", available: false, planned: true, invocable: false },
      { name: "publication", available: false, planned: true, invocable: false },
      { name: "session", available: false, planned: true, invocable: false },
      { name: "top_up", available: true, planned: false, invocable: true },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/x402|l402|private|secret|invoice|preimage/i);
    expect(first.metadata.generationPrice).toBeUndefined();
  });
});

describe("verified ContextVM funding adapter", () => {
  test("uses only SDK-verified sender identity and durable FundingService replay across adapter instances", async () => {
    const store = new TransactionalMemoryFundingStore();
    const service = new FundingService(store);
    await credit(service);
    const transport = new FakeContextVmTransport();
    const adapter = new ContextVmFundingAdapter({ service, transport });
    const admission = envelope({
      request: { id: "request-0002", method: "tools/call", params: { name: "funded_admission", arguments: { idempotencyKey: "admission-0001", requestedCap: "700", unit: "sat", capacity: { reference: "ready-0001", usable: true } } } },
      rawEvent: { id: "event-0002", tags: [["payment_interaction", "transparent"]] }, requestEventId: "event-0002",
    });

    await adapter.handle(admission);
    const first = transport.responses.at(-1)?.response;
    expect(first).toMatchObject({ result: { status: "accepted", payment: { generationPriceWaivedForAdmission: true } } });
    expect(transport.notifications.at(-1)).toMatchObject({ requestEventId: "event-0002" });

    const secondTransport = new FakeContextVmTransport();
    const second = new ContextVmFundingAdapter({ service, transport: secondTransport });
    await second.handle(envelope({ ...admission, requestEventId: "event-0003", rawEvent: { id: "event-0003", tags: [["payment_interaction", "transparent"]] } }));
    expect(secondTransport.responses.at(-1)?.response).toEqual(first);
    expect(store.activeHolds).toHaveLength(1);

    await adapter.handle(envelope({ request: { id: "request-0004", method: "tools/call", params: { name: "account_status", arguments: { pubkey: fixture.requests.forgedPubkey } } } }));
    expect(transport.responses.at(-1)?.response).toMatchObject({ error: { code: -32602 } });
    expect((await service.status({ pubkey: fixture.requests.verifiedPubkey })).accountId).not.toEqual((await service.status({ pubkey: fixture.requests.forgedPubkey })).accountId);
  });

  test("requires exact CEP-8 negotiation, protects bearer bytes, correlates redacted responses, and denies malformed wire facts", async () => {
    const service = new FundingService(new TransactionalMemoryFundingStore());
    const transport = new FakeContextVmTransport();
    const protectedMaterial: Array<{ pmi: string; payload: string }> = [];
    const adapter = new ContextVmFundingAdapter({
      service, transport,
      protectedMaterial: { protect: async (input) => { protectedMaterial.push(input); return { reference: "protected:cashu:0001" }; } },
    });
    await adapter.handle(envelope());
    expect(protectedMaterial).toEqual([{ pmi: fixture.requests.cashuPmi, payload: fixture.requests.directPayment }]);
    expect(transport.responses.at(-1)).toMatchObject({ clientPubkey: fixture.requests.verifiedPubkey, requestEventId: "event-0001", response: { result: { status: "top_up_pending", pmi: fixture.requests.cashuPmi } } });
    expect(JSON.stringify(transport.responses)).not.toContain(fixture.requests.directPayment);
    expect(transport.canonicalCalls).toEqual([{ clientPubkey: fixture.requests.verifiedPubkey, method: "tools/call", params: envelope().request.params }]);

    await adapter.handle(envelope({ rawEvent: { id: "event-0001", tags: [["pmi", fixture.requests.cashuPmi], ["direct_payment", fixture.requests.cashuPmi, "one"], ["direct_payment", fixture.requests.cashuPmi, "two"]] } }));
    await adapter.handle(envelope({ verifiedClientPubkey: fixture.requests.forgedPubkey.toUpperCase() }));
    await adapter.handle(envelope({ requestEventId: "wrong-event" }));
    expect(transport.responses.slice(-3).every((entry) => "error" in entry.response)).toBe(true);
    expect(protectedMaterial).toHaveLength(1);
  });

  test("keeps ContextVM and CEP-8 imports out of financial core modules", async () => {
    const corePaths = ["src/funding/funding-service.ts", "src/persistence/funding-store.ts", "src/phase-03/contracts.ts"];
    for (const path of corePaths) {
      const source = await Bun.file(path).text();
      expect(source).not.toMatch(/@contextvm\/sdk|nostr|cep-?8|pmi/i);
    }
  });
});
