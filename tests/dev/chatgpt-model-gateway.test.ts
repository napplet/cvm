import { expect, test } from "bun:test";
import { ChatGptModelGateway, readChatGptResponse, type ChatGptOperations } from "../../src/dev/chatgpt-model-gateway";
import { priceReceipt, PriceCardSchema, maximumOperationCharge } from "../../src/model/price-card";
import { ProviderOperationIntentSchema, type ModelDispatchObservation } from "../../src/model/model-gateway";
import { chatGptFixture } from "../fixtures/chatgpt";

function setup() {
  const fixture = chatGptFixture(); const records = new Map<string, { intent: string; observation?: ModelDispatchObservation }>(); const proposals: any[] = []; const observations: any[] = [];
  const operations: ChatGptOperations = {
    async claim(intent) { if (records.has(intent.operationId)) return false; records.set(intent.operationId, { intent: JSON.stringify(intent) }); return true; },
    async read(intent) { const row = records.get(intent.operationId); if (row && row.intent !== JSON.stringify(intent)) throw new Error("OPERATION_BINDING_MISMATCH"); return row?.observation; },
    async complete(intent, observation) { records.get(intent.operationId)!.observation = observation; },
  };
  const store = {
    async persist(input: any) { const proposal = { reference: `proposal:sha256:${"a".repeat(64)}`, sha256: "a".repeat(64), ...input.proposal }; proposals.push(input); return { proposal } as any; },
    async recordProviderObservation(input: any) { observations.push(input); },
    async lookupProviderObservation(intent: any) { return observations.find((item) => item.intent.operationId === intent.operationId); },
  };
  const options = { accountId: "test-account", model: "fixture-codex", auth: { accessToken: async () => "fixture-access" }, store, operations, fetch: fixture.fetch };
  const gateway = new ChatGptModelGateway(options);
  const intent = ProviderOperationIntentSchema.parse({ operationId: "op", providerRequestId: "request", accountId: "account", sessionId: "session", actionId: "action", expectedVersion: 0, actionBudgetReference: "budget", profileId: gateway.pricing.profile.id, priceCardId: gateway.pricing.card.id, requestFingerprint: "a".repeat(64), prompt: "Make a counter", maximumUnits: gateway.pricing.profile.maximumUnits, selection: "unselected" });
  return { fixture, operations, proposals, observations, options, gateway, intent };
}
const signal = () => new AbortController().signal;

test("streamed completion records real usage, synthetic pricing, supported request shape and replay", async () => {
  const { gateway, fixture, intent, proposals, options } = setup();
  const result = await gateway.dispatch(intent, signal()); expect(result.status).toBe("completed"); if (result.status !== "completed") throw new Error("missing completion");
  expect(result.receipt.usage).toEqual([{ dimension: "input_tokens", units: "1200" }, { dimension: "output_tokens", units: "800" }]);
  expect(priceReceipt({ receipt: result.receipt, ...gateway.pricing })).toMatchObject({ status: "priced", total: "3" }); expect(maximumOperationCharge(gateway.pricing)).toBe("395");
  const request = JSON.parse(String(fixture.calls.find((call) => call.url.endsWith("/responses"))!.init!.body));
  expect(request).toMatchObject({ store: false, stream: true, model: "fixture-codex" });
  for (const field of ["metadata", "max_output_tokens", "previous_response_id", "temperature", "background"]) expect(request[field]).toBeUndefined();
  expect(proposals).toHaveLength(1); expect(proposals[0].provider).toBe("openai_chatgpt_development");
  const restarted = new ChatGptModelGateway({ ...options, auth: { accessToken: async () => { throw new Error("must not need token for replay"); } } });
  expect(await restarted.dispatch(intent, signal())).toEqual(result); expect(await restarted.lookup(intent, signal())).toMatchObject({ status: "receipt_found", receipt: result.receipt }); expect(fixture.counts().inferences).toBe(1);
});

for (const mode of ["cut", "limit"] as const) test(`${mode} stream stays ambiguous after restart with zero redispatch`, async () => {
  const { gateway, fixture, intent, options } = setup(); fixture.setInferenceMode(mode);
  expect((await gateway.dispatch(intent, signal())).status).toBe("usage_unknown");
  const restarted = new ChatGptModelGateway(options); expect((await restarted.dispatch(intent, signal())).status).toBe("usage_unknown"); expect((await restarted.lookup(intent, signal())).status).toBe("unresolved");
  expect(fixture.counts().inferences).toBe(1); expect(gateway.diagnostic()).toBe(mode === "limit" ? "CHATGPT_USAGE_LIMIT_REACHED" : "CHATGPT_STREAM_INTERRUPTED");
});

test("a persisted pre-request claim survives a crash and cannot issue another request", async () => {
  const { gateway, operations, intent, fixture } = setup(); await operations.claim(intent);
  expect((await gateway.dispatch(intent, signal())).status).toBe("usage_unknown"); expect(fixture.counts().inferences).toBe(0);
});

test("concurrent original requests consume the provider once and reject changed intent", async () => {
  const { gateway, intent, fixture } = setup();
  const results = await Promise.all([gateway.dispatch(intent, signal()), gateway.dispatch(intent, signal())]); expect(results.some((item) => item.status === "completed")).toBe(true); expect(fixture.counts().inferences).toBe(1);
  await expect(gateway.dispatch({ ...intent, prompt: "changed" }, signal())).rejects.toThrow("BINDING_MISMATCH");
});

test("invalid source still records actual completed usage and failed action", async () => {
  const { gateway, intent, fixture, proposals } = setup(); fixture.setInferenceMode("bad-source"); const result = await gateway.dispatch(intent, signal());
  expect(result.status).toBe("failed"); expect(proposals).toHaveLength(0); expect((await gateway.lookup(intent, signal())).status).toBe("receipt_found");
});

test("revision needs owner-authorized prior source before any network request", async () => {
  const { gateway, options, intent, fixture } = setup(); const revision = { ...intent, authorizedPriorArtifactReference: "artifact:prior" };
  expect((await gateway.dispatch(revision, signal())).status).toBe("definitive_not_accepted"); expect(fixture.calls).toHaveLength(0);
  const withPrior = new ChatGptModelGateway({ ...options, priorSource: async (input) => { expect(input).toEqual({ accountId: intent.accountId, sessionId: intent.sessionId, authorizedPriorArtifactReference: "artifact:prior" }); return fixture.files(0); } });
  expect((await withPrior.dispatch(revision, signal())).status).toBe("completed");
  const body = JSON.parse(String(fixture.calls.at(-1)!.init!.body)); expect(body.input[1].content).toContain("authorizedPriorSource");
});

test("ChatGPT prices cannot claim API provenance or fixture identity", () => {
  const { gateway } = setup(); expect(PriceCardSchema.safeParse({ ...gateway.pricing.card, kind: "source_attributed_provider" }).success).toBe(false); expect(PriceCardSchema.safeParse({ ...gateway.pricing.card, kind: "deterministic_fixture" }).success).toBe(false);
});

test("stream enforces abort, size and terminal completion", async () => {
  const controller = new AbortController();
  const pending = readChatGptResponse(new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }), controller.signal);
  controller.abort(); await expect(pending).rejects.toThrow();
  await expect(readChatGptResponse(new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }), signal())).rejects.toThrow("STREAM_INTERRUPTED");
  await expect(readChatGptResponse(new Response("x".repeat(2_000_001), { headers: { "content-type": "text/event-stream" } }), signal())).rejects.toThrow("TOO_LARGE");
});


test("stream observations expose byte counts only and observer failure cannot interrupt completion", async () => {
  const { options, intent } = setup(); const bytes: number[] = [];
  const gateway = new ChatGptModelGateway({ ...options, onResponseBytes: (count) => { bytes.push(count); throw new Error("observer unavailable"); } });
  expect((await gateway.dispatch(intent, signal())).status).toBe("completed");
  expect(bytes.length).toBeGreaterThan(0); expect(bytes.every((value) => Number.isSafeInteger(value) && value > 0 && value <= 2000000)).toBe(true);
});
