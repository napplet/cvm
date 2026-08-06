import { expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { createNativeContextVmProvider } from "../../src/release/native/contextvm";

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
