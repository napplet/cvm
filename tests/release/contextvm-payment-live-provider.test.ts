import { expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { CashuMintPolicyRegistry } from "../../src/funding/cashu-mint-policy";
import { FakeCashuSettlementPort } from "../../src/funding/cashu-provider";
import { CashuTopUpCoordinator, InMemoryCashuTopUpRepository } from "../../src/funding/cashu-top-up";
import { FakeLightningReceiptPort } from "../../src/funding/lightning-provider";
import { InMemoryLightningTopUpRepository, LightningTopUpCoordinator } from "../../src/funding/lightning-top-up";
import { InMemoryProtectedRailMaterialRepository, ProtectedRailMaterialVault } from "../../src/funding/protected-rail-material";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { createNativeContextVmProvider } from "../../src/release/native/contextvm";
import { createNativeCep8LightningProvider } from "../../src/release/native/cep8-lightning";
import { createNativeCashuProvider } from "../../src/release/native/cashu";
import { createProtectedLiveContextVmPaymentObservationPort } from "../../src/certification/live/payment-ports";
import { runLiveContextVmPaymentModelCertification } from "../../src/certification/live/contextvm-payment-model";

const digest = (letter: string) => letter.repeat(64);
const pubkey = "a".repeat(64);

function contextVmTransport() {
  const responses: unknown[] = [];
  return {
    responses,
    onInbound: (_handler: unknown) => {},
    configureAnnouncement: () => {},
    sendResponse: async (_clientPubkey: string, response: unknown) => { responses.push(response); },
    sendNotification: async () => {},
    canonicalInvocation: (clientPubkey: string, method: string, params: unknown) => ({ clientPubkey, invocationHash: digest("b"), method, params }),
  };
}

test("native ContextVM composition has no relay effect before an exact receipt, preserves the signed principal, and reconciles the original event", async () => {
  const transport = contextVmTransport();
  const provider = createNativeContextVmProvider({
    config: {
      relaySetReference: "relay-set:primary",
      relaySetSha256: digest("c"),
      serverPubkey: "d".repeat(64),
      protocolVersion: "contextvm-0.13",
      sdkPackageVersion: "0.13.10",
      reconnectPolicy: "reconcile_original_event",
    },
    transport,
    adapterOptions: { service: new FundingService(new TransactionalMemoryFundingStore()) },
  });

  expect(transport.responses).toEqual([]);
  expect(provider.discovery()).toEqual({
    relaySetReference: "relay-set:primary",
    relaySetSha256: digest("c"),
    serverPubkey: "d".repeat(64),
    protocolVersion: "contextvm-0.13",
    sdkPackageVersion: "0.13.10",
    reconnectPolicy: "reconcile_original_event",
  });
  expect(JSON.stringify(provider.discovery())).not.toMatch(/private|nsec|secret/i);

  const invocation = {
    verifiedClientPubkey: pubkey,
    requestEventId: "event-contextvm-1",
    rawEvent: { id: "event-contextvm-1", tags: [] },
    request: { id: "rpc-contextvm-1", method: "tools/call", params: { name: "account_status", arguments: {} } },
  };
  const receipt = { originalEventId: "event-contextvm-1", invocationSha256: digest("b") };
  const first = await provider.invokeAfterReceipt({ receipt, invocation });
  const replay = await provider.invokeAfterReceipt({ receipt, invocation });

  expect(first).toEqual({ originalEventId: "event-contextvm-1", replayed: false });
  expect(replay).toEqual({ originalEventId: "event-contextvm-1", replayed: true });
  expect(transport.responses).toHaveLength(1);
  expect(transport.responses[0]).toMatchObject({ result: { accountId: expect.any(String) } });
  await expect(provider.invokeAfterReceipt({ receipt: { ...receipt, originalEventId: "other-event" }, invocation })).rejects.toThrow("CONTEXTVM_RECEIPT_MISMATCH");
  expect(() => createNativeContextVmProvider({
    config: { relaySetReference: "relay-set:primary", relaySetSha256: digest("c"), serverPubkey: "d".repeat(64), protocolVersion: "contextvm-0.13", sdkPackageVersion: "0.13.10", reconnectPolicy: "reconcile_original_event", privateKey: "nsec-canary" },
    transport,
    adapterOptions: { service: new FundingService(new TransactionalMemoryFundingStore()) },
  } as never)).toThrow();
});

test("native CEP-8 rail composition uses original operations, existing coordinators, and redacted protected-suite observations", async () => {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  const lightningReceiver = new FakeLightningReceiptPort({
    create: { status: "created", topUpId: "", serviceReference: "lightning:service:one", invoice: "lnbc-private-canary", invoiceIdentity: "invoice-one", paymentHash: "hash-one", amount: "21", unit: "sat", expiresAt: "2026-08-07T00:10:00.000Z", safeDisplayReference: "lightning:…one" },
  });
  const lightning = createNativeCep8LightningProvider({
    config: { endpointReference: "lightning:endpoint", endpointSha256: digest("e"), accountReference: "lightning:account", accountSha256: digest("f") },
    receiver: lightningReceiver,
    coordinator: new LightningTopUpCoordinator({
      funding, receiver: lightningReceiver, repository: new InMemoryLightningTopUpRepository(),
      vault: new ProtectedRailMaterialVault({ key: new Uint8Array(32).fill(1), repository: new InMemoryProtectedRailMaterialRepository() }),
      now: () => "2026-08-07T00:00:00.000Z",
    }),
  });
  const cashuSettlement = new FakeCashuSettlementPort();
  cashuSettlement.nextSettlement({ status: "verified", externalReference: "cashu:operation:one", settlementReference: "cashu:settlement:one", verifiedAt: "2026-08-07T00:00:00.000Z" });
  const cashu = createNativeCashuProvider({
    config: { mintPolicyReference: "cashu:policy", mintPolicySha256: digest("1"), accountReference: "cashu:account", accountSha256: digest("2") },
    settlement: cashuSettlement,
    walletOperations: { settle: async () => {}, observe: async () => "spent" as const },
    coordinator: new CashuTopUpCoordinator({
      policies: new CashuMintPolicyRegistry({ version: "cashu-policy-v1", activeFrom: "2026-08-07T00:00:00.000Z", activeUntil: null, mints: [
        { url: "https://mint-a.example", keysetIds: ["keyset-a"], requireDleq: true, proofConditions: ["none"] },
        { url: "https://mint-b.example", keysetIds: ["keyset-b"], requireDleq: true, proofConditions: ["none"] },
      ] }),
      provider: cashuSettlement, vault: { seal: async () => ({ id: "cashu:protected", payloadDigest: digest("3") }), expire: async () => {} }, funding, repository: new InMemoryCashuTopUpRepository(), now: () => "2026-08-07T00:00:00.000Z",
    }),
  });

  expect(lightningReceiver.createCalls).toBe(0);
  expect(cashuSettlement.settleCalls).toBe(0);
  const lightningInput = { principal: { pubkey }, idempotencyKey: "lightning-original-op", amount: "21", unit: "sat" as const, policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1" };
  const cashuInput = { principal: { pubkey }, idempotencyKey: "cashu-original-op", topUpId: "cashu-original-op", amount: "21", unit: "sat" as const, pmi: "bitcoin-cashu-v4-direct" as const, token: new TextEncoder().encode("cashu-private-proof-canary") };
  const lightningPending = await lightning.beginAfterReceipt({ receipt: { originalOperationId: "lightning-original-op", requestSha256: digest("4") }, input: lightningInput });
  lightningReceiver.queryMode = "settled";
  const lightningSettled = await lightning.reconcileOriginal({ principal: { pubkey }, topUpId: lightningPending.topUpId });
  const cashuSettled = await cashu.submitAfterReceipt({ receipt: { originalOperationId: "cashu-original-op", requestSha256: digest("5") }, input: cashuInput });
  expect(lightningSettled).toMatchObject({ status: "credited", state: "credited" });
  expect(cashuSettled).toMatchObject({ state: "credited" });
  expect(store.postings).toHaveLength(2);
  expect(await lightning.beginAfterReceipt({ receipt: { originalOperationId: "lightning-original-op", requestSha256: digest("4") }, input: lightningInput })).toMatchObject({ status: "credited" });
  expect(lightningReceiver.createCalls).toBe(1);

  const port = createProtectedLiveContextVmPaymentObservationPort({
    contextvm: { evidenceClass: "protected_live", exercise: async () => ({ status: "passed", verifiedPrincipalAccountBinding: true, replayReturnsDurablePriorResult: true, redeliveryPreservesAction: true, reconnectPreservesAction: true }) },
    lightning, cashu,
    model: { reconcileOriginalModelOperation: async () => ({ status: "passed", operationId: "model-original-op", lookupUsesOriginalOperationOnly: true, dispatchCount: 1, debitCount: 1, cancellationOrAmbiguityVisible: true }) },
  });
  expect(await port.exerciseCep8Settlement({ candidateId: digest("6") })).toEqual({ status: "passed", lightningCreditedExactlyOnce: true, cashuCreditedExactlyOnce: true, ambiguityUsesOriginalSettlementOnly: true });
  expect(await runLiveContextVmPaymentModelCertification({
    candidate: { id: digest("6"), provider: "modal", image: `registry.example/worker@sha256:${digest("7")}`, sourceSha256: digest("8") },
    observationPort: port,
  })).toMatchObject({ status: "passed", reasonCode: "OBSERVATION_COMPLETE" });
  expect(JSON.stringify({ discovery: [lightning.discovery(), cashu.discovery()], evidence: await port.exerciseCep8Settlement({ candidateId: digest("6") }) })).not.toMatch(/private|proof|preimage|credential|invoice/i);
});
