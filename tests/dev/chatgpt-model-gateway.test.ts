import { loadAuthoringSkills } from "../../infra/dev-ui/authoring-skills";
import { expect, spyOn, test } from "bun:test";
import type { ChatGptDiagnostic } from "../../src/dev/chatgpt-diagnostic";
import { ChatGptModelGateway, readChatGptResponse, type ChatGptOperations } from "../../src/dev/chatgpt-model-gateway";
import { priceReceipt, PriceCardSchema, maximumOperationCharge } from "../../src/model/price-card";
import { ProviderOperationIntentSchema, type ModelDispatchObservation } from "../../src/model/model-gateway";
import { chatGptFixture } from "../fixtures/chatgpt";

function setup() {
  const fixture = chatGptFixture(); const records = new Map<string, { intent: string; observation?: ModelDispatchObservation; diagnostic?: ChatGptDiagnostic }>(); const proposals: any[] = []; const observations: any[] = [];
  const operations: ChatGptOperations = {
    async claim(intent) { if (records.has(intent.operationId)) return false; records.set(intent.operationId, { intent: JSON.stringify(intent) }); return true; },
    async read(intent) { const row = records.get(intent.operationId); if (row && row.intent !== JSON.stringify(intent)) throw new Error("OPERATION_BINDING_MISMATCH"); return row?.observation; },
    async complete(intent, observation, diagnostic) { Object.assign(records.get(intent.operationId)!, { observation, diagnostic }); },
    async diagnostic(intent) { return records.get(intent.operationId)?.diagnostic; },
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
  expect(request.input[0].content).toContain((await loadAuthoringSkills()).guidance);
  expect(request.input[0].content).toContain("SERVICE EXECUTION CONTRACT");
  expect(request.input[0].content).toContain("runtimeHasDomain(domain: string): boolean");
  expect(request.input[0].content).toContain("void runtimeHasDomain('storage');");
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

test("a missing content type still parses SSE completion and preserves the replay fence", async () => {
  const { options, intent, fixture } = setup();
  const gateway = new ChatGptModelGateway({ ...options, fetch: async (url, init) => {
    expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
    const response = await fixture.fetch(url, init);
    return new Response(response.body);
  } });
  const result = await gateway.dispatch(intent, signal());
  expect(result.status).toBe("completed");
  expect(await gateway.dispatch(intent, signal())).toEqual(result);
  expect(fixture.counts().inferences).toBe(1);
});

test("headerless SSE usage-limit errors remain visible and are never redispatched", async () => {
  const { options, intent, fixture } = setup(); fixture.setInferenceMode("limit");
  const gateway = new ChatGptModelGateway({ ...options, fetch: async (url, init) => new Response((await fixture.fetch(url, init)).body) });
  expect((await gateway.dispatch(intent, signal())).status).toBe("usage_unknown");
  expect(gateway.diagnostic()).toBe("CHATGPT_USAGE_LIMIT_REACHED");
  expect((await gateway.dispatch(intent, signal())).status).toBe("usage_unknown");
  expect(fixture.counts().inferences).toBe(1);
});

test("subscription completion assembles completed output items when the terminal output is empty", async () => {
  const { options, intent, fixture, proposals } = setup(); fixture.setSparseCompletion(true);
  const gateway = new ChatGptModelGateway({ ...options, fetch: async (url, init) => new Response((await fixture.fetch(url, init)).body) });
  const result = await gateway.dispatch(intent, signal());
  expect(result.status).toBe("completed");
  expect(proposals[0].proposal.files).toEqual(fixture.files(1));
  expect(await gateway.dispatch(intent, signal())).toEqual(result);
  expect(fixture.counts().inferences).toBe(1);
});

test("completed items require a matching terminal response and valid usage", async () => {
  const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] };
  const terminal = { id: "resp_one", model: "fixture-codex", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } };
  const itemEvent = { type: "response.output_item.done", output_index: 1, item };
  const response = (events: unknown[]) => new Response(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
  await expect(readChatGptResponse(response([itemEvent]), signal())).rejects.toThrow("STREAM_INTERRUPTED");
  await expect(readChatGptResponse(response([itemEvent, { type: "response.completed", response: { ...terminal, usage: undefined } }]), signal())).rejects.toThrow();
  await expect(readChatGptResponse(response([{ type: "response.created", response: { id: "resp_other" } }, itemEvent, { type: "response.completed", response: terminal }]), signal())).rejects.toThrow("STREAM_FAILED");
  await expect(readChatGptResponse(response([itemEvent, { ...itemEvent, item: { ...item, role: "user" } }]), signal())).rejects.toThrow("STREAM_FAILED");
  const result = await readChatGptResponse(response([itemEvent, { type: "response.completed", response: { ...terminal, output: [item] } }]), signal());
  expect(result.output).toEqual([item]);
});

test("headerless JSON, partial streams and malformed receipts cannot claim completion", async () => {
  for (const body of [JSON.stringify({ status: "completed", usage: { input_tokens: 1, output_tokens: 1 } }), 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n', 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n']) {
    await expect(readChatGptResponse(new Response(new TextEncoder().encode(body)), signal())).rejects.toThrow();
  }
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
  await expect(readChatGptResponse(response, signal())).rejects.toThrow("STREAM_REQUIRED");
  expect(cancelled).toBe(true);
});


test("stream observations expose byte counts only and observer failure cannot interrupt completion", async () => {
  const { options, intent } = setup(); const bytes: number[] = [];
  const gateway = new ChatGptModelGateway({ ...options, onResponseBytes: (count) => { bytes.push(count); throw new Error("observer unavailable"); } });
  expect((await gateway.dispatch(intent, signal())).status).toBe("completed");
  expect(bytes.length).toBeGreaterThan(0); expect(bytes.every((value) => Number.isSafeInteger(value) && value > 0 && value <= 2000000)).toBe(true);
});

test("a slow model can complete after the old two-minute cutoff", async () => {
  const controller = new AbortController(); let deadline = 0;
  const clock = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { deadline = ms; return controller.signal; });
  try {
    const { options, intent, fixture } = setup();
    const gateway = new ChatGptModelGateway({ ...options, fetch: async (url, init) => {
      // Advance a virtual provider clock past two minutes, without a wall-clock wait.
      if (deadline <= 121_000) controller.abort(new DOMException("private timeout detail", "TimeoutError"));
      init?.signal?.throwIfAborted(); return fixture.fetch(url, init);
    } });
    expect((await gateway.dispatch(intent, signal())).status).toBe("completed");
    expect(deadline).toBe(300_000);
    expect(gateway.pricing.profile.id).toStartWith("development-chatgpt-v2-");
  } finally { clock.mockRestore(); }
});

test("deadline expiry is classified, retained across restart, and never redispatched", async () => {
  const controller = new AbortController();
  const clock = spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
  try {
    const { options, intent, operations } = setup(); let calls = 0;
    const gateway = new ChatGptModelGateway({ ...options, fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"fixture"}}\n\n'));
        setTimeout(() => controller.abort(new DOMException("private timeout body", "TimeoutError")), 5);
      } }), { headers: { "content-type": "text/event-stream" } });
    } });
    expect(await gateway.dispatch(intent, signal())).toMatchObject({ status: "usage_unknown", reason: "accepted_timeout" });
    expect(gateway.diagnostic()).toBe("CHATGPT_GENERATION_TIMEOUT");
    const diagnostic = await operations.diagnostic!(intent);
    expect(diagnostic).toMatchObject({ code: "CHATGPT_GENERATION_TIMEOUT", phase: "stream", httpStatus: 200 });
    expect(diagnostic!.receivedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic)).not.toContain("private");
    const restarted = new ChatGptModelGateway({ ...options, fetch: async () => { calls++; throw new Error("must not redispatch"); } });
    expect((await restarted.dispatch(intent, signal())).status).toBe("usage_unknown");
    expect(restarted.diagnostic()).toBe("CHATGPT_GENERATION_TIMEOUT");
    expect((await restarted.lookup(intent, signal())).status).toBe("unresolved");
    expect(calls).toBe(1);
  } finally { clock.mockRestore(); }
});

for (const failure of ["network", "malformed", "persistence"] as const) test(`${failure} failures retain only safe operational diagnostics`, async () => {
  const { options, intent, operations, fixture } = setup();
  const gateway = new ChatGptModelGateway({ ...options,
    fetch: async (url, init) => {
      if (failure === "network") throw new TypeError("secret Bearer fixture-access https://private.invalid");
      if (failure === "malformed") return new Response(new TextEncoder().encode('data: {private-not-json}\n\n'));
      return fixture.fetch(url, init);
    },
    store: { ...options.store, persist: async (input) => { if (failure === "persistence") throw new Error("private SQL with source"); return options.store.persist(input); } },
  });
  expect((await gateway.dispatch(intent, signal())).status).toBe("usage_unknown");
  expect(gateway.diagnostic()).toBe({ network: "CHATGPT_CONNECTION_FAILED", malformed: "CHATGPT_RESPONSE_INVALID", persistence: "CHATGPT_RESULT_RECORDING_FAILED" }[failure]);
  const diagnostic = await operations.diagnostic!(intent);
  for (const secret of ["private", "Bearer", "fixture-access", "https://", "SQL"]) expect(JSON.stringify(diagnostic)).not.toContain(secret);
});

test("large SSE delta traffic can finish with bounded source without a second model request", async () => {
  const { options, intent, fixture } = setup();
  const gateway = new ChatGptModelGateway({ ...options, fetch: async (url, init) => {
    const response = await fixture.fetch(url, init);
    const terminal = await response.text();
    const delta = 'data: ' + JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'x'.repeat(1000) }) + '\n\n';
    let count = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (count++ < 2400) controller.enqueue(new TextEncoder().encode(delta));
      else { controller.enqueue(new TextEncoder().encode(terminal)); controller.close(); }
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  expect((await gateway.dispatch(intent, signal())).status).toBe("completed");
  expect((await gateway.dispatch(intent, signal())).status).toBe("completed");
  expect(fixture.counts().inferences).toBe(1);
});

test("stream bounds repeated completed items and total traffic even without terminal output", async () => {
  const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
  const items = Array.from({ length: 3 }, (_, output_index) => event({ type: 'response.output_item.done', output_index, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(800_000) }] } })).join('');
  await expect(readChatGptResponse(new Response(items), signal())).rejects.toThrow("RESPONSE_TOO_LARGE");
  let count = 0;
  const delta = new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: 'x'.repeat(100_000) }));
  await expect(readChatGptResponse(new Response(new ReadableStream({ pull(controller) {
    if (count++ < 330) controller.enqueue(delta); else controller.close();
  } })), signal())).rejects.toThrow("RESPONSE_TOO_LARGE");
});
