import { expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import type { NostrServerTransport } from "@contextvm/sdk/transport";
import { ContextVmFundingAdapter } from "../../src/contextvm/adapter";
import { ContextVmSdkBridge, type ContextVmWireResponse } from "../../src/contextvm/sdk-bridge";
import { buildContextVmAnnouncement } from "../../src/contextvm/announcement";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { adapterCreditGrants } from "../../src/payments/credits";
import { PaymentAdapterRegistry } from "../../src/payments/registry";
import { FreeCreditAccess } from "../../src/payments/free-access";
import { FundedAdmissionService, type CapacityReservation } from "../../src/funding/funded-admission";
import { HmacAdmissionReceiptAuthority } from "../../src/funding/admission-receipt";

function signedTransport() {
  const events = new Map<string, Event>();
  const responses: ContextVmWireResponse[] = [];
  const port = {
    onmessage: undefined,
    onmessageWithContext: undefined as ((message: unknown, context: { clientPubkey: string }) => void) | undefined,
    getNostrRequestEvent: (id: string) => events.get(id),
    sendTargetedResponse: async (_pubkey: string, response: ContextVmWireResponse) => { responses.push(response); },
    sendNotification: async () => undefined,
    setAnnouncementExtraTags: () => undefined,
    setAnnouncementPricingTags: () => undefined,
    setSupportedPaymentInteraction: () => undefined,
  };
  const bridge = new ContextVmSdkBridge(port as unknown as NostrServerTransport);
  const key = generateSecretKey();
  return {
    bridge, pubkey: getPublicKey(key),
    async call(name: string, args: unknown, pmi?: string) {
      const id = crypto.randomUUID();
      const event = finalizeEvent({ kind: 5900, created_at: Math.floor(Date.now() / 1000), content: id,
        tags: pmi ? [["pmi", pmi], ["payment_interaction", "transparent"]] : [] }, key);
      events.set(event.id, event);
      const count = responses.length;
      port.onmessageWithContext!({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { requestEventId: event.id } } }, { clientPubkey: event.pubkey });
      const deadline = Date.now() + 2000;
      while (responses.length === count && Date.now() < deadline) await Bun.sleep(1);
      expect(responses.length).toBe(count + 1);
      return { response: responses.at(-1)!, pubkey: event.pubkey };
    },
  };
}

test("signed ContextVM supports independent payment adapters, one credit per event and no client-supplied credit authority", async () => {
  const funding = new FundingService(new TransactionalMemoryFundingStore());
  const transport = signedTransport();
  let verified = 0;
  const modules = ["card", "membership"].map(id => {
    const credits = adapterCreditGrants(funding, id);
    return { id, methods: [{ id: `${id}-checkout`, label: id, input: "external" as const }],
      request: async (input: import("../../src/payments/contracts").PaymentRequest) => {
        verified++;
        await credits.grant({ principal: input.principal, reference: "verified-event-1", credits: input.amount, policyVersion: "credit-price-v1", verifiedAt: new Date().toISOString() });
        return { state: "credited", topUpId: `${id}-1`, amount: input.amount, unit: "sat", secret: "private" };
      } };
  });
  const payments = new PaymentAdapterRegistry(modules);
  new ContextVmFundingAdapter({ service: funding, transport: transport.bridge, payments });
  const args = { idempotencyKey: "purchase-1", credits: "100", pmi: "card-checkout", mode: "transparent" };
  const original = await transport.call("top_up", args, args.pmi);
  expect(original.response).not.toHaveProperty("error");
  expect(JSON.stringify(original.response)).not.toContain("private");
  await transport.call("top_up", args, args.pmi);
  expect((await funding.status({ pubkey: original.pubkey })).available).toBe("100");
  await transport.call("top_up", { ...args, pmi: "membership-checkout" }, "membership-checkout");
  expect((await funding.status({ pubkey: original.pubkey })).available).toBe("200");
  const forged = await transport.call("top_up", { ...args, principal: { pubkey: "cd".repeat(32) } }, args.pmi);
  expect(forged.response).toHaveProperty("error"); expect(verified).toBe(3);
  const unavailable = await transport.call("top_up", { ...args, pmi: "other-method" }, "other-method");
  expect(unavailable.response).toHaveProperty("error");
  const status = await transport.call("account_status", {});
  expect(status.response).toHaveProperty("result.available", "200");
});

test("payment-free ContextVM rejects payment calls and unlisted owners without loading an adapter", async () => {
  const funding = new FundingService(new TransactionalMemoryFundingStore());
  const transport = signedTransport();
  const freeAccess = new FreeCreditAccess(funding, { allowlist: ["ab".repeat(32)], maximumCredits: "1000" });
  new ContextVmFundingAdapter({ service: funding, transport: transport.bridge, freeAccess });
  expect((await transport.call("account_status", {})).response).toHaveProperty("error");
  expect((await transport.call("top_up", { idempotencyKey: "free-pay", amount: "1", pmi: "card-checkout", mode: "transparent" }, "card-checkout")).response).toHaveProperty("error");
});

test("discovery supports zero, one or multiple payment methods without requiring a specific provider", () => {
  const tools = ["account_status", "top_up", "funded_admission", "start_session", "revise_session", "resume_session", "session_status", "preview", "publication"].map(name => ({ name, available: true, planned: false }));
  for (const pmis of [[], ["card-checkout"], ["card-checkout", "membership-checkout", "bank-transfer"]]) {
    const announcement = buildContextVmAnnouncement({ topUpCap: { minimum: "1", maximum: "1000", unit: "sat" }, pmis, paymentInteraction: ["transparent", "explicit_gating"], tools });
    expect(announcement.tags.filter(tag => tag[0] === "pmi").length).toBe(pmis.length);
    expect(announcement.metadata.topUp.available).toBe(pmis.length > 0);
  }
});

test("an allowlisted signed owner obtains free admission through the existing ledger without a payment adapter", async () => {
  const store = new TransactionalMemoryFundingStore(); const funding = new FundingService(store);
  const transport = signedTransport(); const receiptAuthority = new HmacAdmissionReceiptAuthority({ secret: new Uint8Array(32).fill(7) });
  const reservations = new Map<string, CapacityReservation>();
  const admissions = new FundedAdmissionService({ funding, store, receiptAuthority, capacity: {
    async reserveNow(input) {
      const reservation: CapacityReservation = { status: "available", reference: `free-ready:${input.intentReference}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), usable: true,
        ready: { intentReference: input.intentReference, leaseReference: `free-ready:${input.intentReference}`, sessionBindingDigest: input.expectedSessionBindingDigest,
          imageDigest: `sha256:${"b".repeat(64)}`, readinessProbeDigest: `sha256:${"c".repeat(64)}`, readyMonotonicMs: Math.floor(performance.now()) } };
      reservations.set(input.intentReference, reservation); return reservation;
    },
    async observe(input) { return reservations.get(input.intentReference) ?? { status: "unknown" }; },
    async release() {},
  } });
  const freeAccess = new FreeCreditAccess(funding, { allowlist: [transport.pubkey], maximumCredits: "1000" });
  new ContextVmFundingAdapter({ service: funding, transport: transport.bridge, freeAccess, admissions, admissionReceipts: receiptAuthority });
  const args = { idempotencyKey: "free-admission-1", requestedCap: "500", unit: "sat" };
  expect((await transport.call("funded_admission", args)).response).toHaveProperty("result.status", "accepted");
  expect((await transport.call("funded_admission", args)).response).toHaveProperty("result.status", "accepted");
  expect((await funding.status({ pubkey: transport.pubkey })).held).toBe("500");
  expect((await funding.status({ pubkey: transport.pubkey })).available).toBe("0");
  const invalid = await transport.call("funded_admission", { ...args, idempotencyKey: "invalid", principal: { pubkey: "cd".repeat(32) } });
  expect(invalid.response).toHaveProperty("error");
  expect((await funding.status({ pubkey: transport.pubkey })).available).toBe("0");
});
