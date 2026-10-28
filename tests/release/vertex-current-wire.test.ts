import { expect, test } from "bun:test";
import { z } from "zod";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort, parseVertexProviderReceipt, type VertexOperationJournal } from "../../src/release/deployment/vertex-client";

// Documented-shape synthetic protocol fixtures, not live provider/billing proof.
const price = { sourceUrl: "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", sourceDocumentSha256: "a".repeat(64), quoteSha256: "b".repeat(64), observedAtMs: 1000, freshUntilMs: 2000, effectiveFromMs: 900, effectiveUntilMs: 3000, currency: "USD", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 };
const usage = { total_input_tokens: 1000, total_cached_tokens: 200, total_output_tokens: 100, total_thought_tokens: 10, total_tool_use_tokens: 0, total_tokens: 1110 };
const output = { type: "model_output", content: [{ type: "text", text: '{"files":[]}' }] };
const current = (overrides: Record<string, unknown> = {}) => ({ id: "original", model: "gemini-4-argon", status: "completed", created: "2026-10-27T00:00:00.000Z", steps: [output], usage, ...overrides });
const Text = z.object({ type: z.literal("text"), text: z.string() }).strict();
function contents(input: unknown) {
  const flat = z.array(Text).safeParse(input);
  if (flat.success) return flat.data;
  return z.array(z.object({ role: z.literal("user"), content: z.array(Text) })).length(1).parse(input)[0]!.content;
}
function setup(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const records = new Map<string, unknown>();
  const journal: VertexOperationJournal = { async claim(entry) { const prior = records.get(entry.operationId); if (prior) return { claimed: false, entry: prior }; records.set(entry.operationId, structuredClone(entry)); return { claimed: true, entry }; }, async read(id) { return records.get(id); }, async write(entry) { records.set(entry.operationId, structuredClone(entry)); } };
  const interactions = createVertexInteractionsHttpPort({ accessToken: async () => "a".repeat(32), fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => fetcher(String(url), init), { preconnect() {} }) });
  const open = (now = 1500) => createVertexDeploymentClient({ candidateSha256: "c".repeat(64), projectId: "napplet-cvm-test", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:test", price, journal, interactions, now: () => now });
  return { open, records };
}
const request = { operationId: "operation:current-wire", idea: "One focused counter", systemInstruction: "Return JSON only", maximumInputTokens: 1000, maximumOutputTokens: 200 };

test("actual HTTP POST sends current text/JSON formats and accepts a current response without echoed input", async () => {
  let posts = 0, reads = 0; let sent: unknown;
  const { open } = setup(async (_url, init) => { if (init?.method !== "POST") { reads++; throw new Error("NO_PROVIDER_READ_EXPECTED"); } posts++; sent = JSON.parse(String(init.body)); return Response.json(current()); });
  const receipt = await open().dispatch(request);
  expect(receipt).toMatchObject({ status: "completed", usage: { inputTokens: 800, cachedInputTokens: 200, outputTokens: 100, thoughtTokens: 10 }, cost: { currency: "USD", micros: 5440 } });
  expect(sent).toMatchObject({ input: [{ type: "text", text: expect.any(String) }], response_format: { type: "text", mime_type: "application/json", schema: { type: "object", required: ["files"] } } });
  expect(await open(5000).reconcileOriginal({ operationId: request.operationId })).toEqual(receipt);
  expect({ posts, reads }).toEqual({ posts: 1, reads: 0 });
});

test("lost creation ACK matches typed stored input and skips an unrelated same-model resource without another POST", async () => {
  let posts = 0, reads = 0; let input: ReturnType<typeof contents> = [];
  const { open } = setup(async (url, init) => {
    if (init?.method === "POST") { posts++; input = contents(JSON.parse(String(init.body)).input); throw new Error("FIXTURE_LOST_ACK"); }
    reads++;
    if (url.includes("page_size=")) return Response.json({ interaction_metadatas: [{ id: "unrelated" }, { id: "original" }] });
    return Response.json(current({ id: url.endsWith("/unrelated") ? "unrelated" : "original", steps: [{ type: "user_input", content: url.endsWith("/unrelated") ? [{ type: "text", text: "foreign nonce" }] : input }, output] }));
  });
  expect(await open().dispatch(request)).toMatchObject({ status: "unknown", reason: "lost_response" });
  const receipt = await open(5000).reconcileOriginal({ operationId: request.operationId });
  expect(receipt).toMatchObject({ status: "completed", interactionId: "original", cost: { micros: 5440 } });
  expect(await open(5000).reconcileOriginal({ operationId: request.operationId })).toEqual(receipt);
  expect({ posts, reads }).toEqual({ posts: 1, reads: 3 });
});

test("known original ID still requires matching stored input and never infers identity from an unbound GET", async () => {
  let posts = 0, reads = 0; let input: ReturnType<typeof contents> = []; let echo = false;
  const { open } = setup(async (url, init) => {
    if (init?.method === "POST") { posts++; input = contents(JSON.parse(String(init.body)).input); return Response.json(current({ status: "in_progress", usage: undefined, steps: [] })); }
    if (url.includes("page_size=")) throw new Error("KNOWN_ID_MUST_NOT_LIST");
    reads++; return Response.json(current({ steps: echo ? [{ type: "user_input", content: input }, output] : [output] }));
  });
  expect(await open().dispatch(request)).toMatchObject({ status: "pending" });
  expect(await open().reconcileOriginal({ operationId: request.operationId })).toMatchObject({ status: "unknown" });
  echo = true;
  expect(await open().reconcileOriginal({ operationId: request.operationId })).toMatchObject({ status: "completed" });
  expect({ posts, reads }).toEqual({ posts: 1, reads: 2 });
});

test.each([
  { usage: { ...usage, total_cached_tokens: undefined } },
  { usage: { ...usage, input_tokens: 1000 } },
  { usage: { ...usage, total_tokens: 1000 } },
  { usage: { ...usage, input_tokens_by_modality: [{ modality: "image", tokens: 1000 }] } },
  { usage: { ...usage, output_tokens_by_modality: [{ modality: "text", tokens: 99 }] } },
  { usage: { ...usage, grounding_tool_count: [{ type: "google_search", count: 1 }] } },
  { usage: { ...usage, total_cached_tokens: 1001 } },
  { usage: { ...usage, total_tool_use_tokens: 1 } },
  { usage: { ...usage, total_output_tokens: 200, total_tokens: 1210 } },
  { usage: { ...usage, total_thought_tokens: -1 } },
  { steps: [{ type: "model_output", model_output: { content: output.content }, content: output.content }] },
  { steps: [{ type: "function_call", name: "foreign" }, output] },
  { input: [{ type: "text", text: "wrong nonce" }] },
  { steps: [{ type: "user_input", content: [{ type: "text", text: "wrong nonce" }] }, output] },
])("current malformed or mismatched evidence remains unknown without an unapproved debit: %j", async overrides => {
  let posts = 0;
  const { open } = setup(async (_url, init) => { if (init?.method === "POST") { posts++; return Response.json(current(overrides)); } return Response.json({ interaction_metadatas: [] }); });
  expect(await open().dispatch(request)).toMatchObject({ status: "unknown" });
  expect(posts).toBe(1);
});

test("current text chunks form one bounded JSON result while thought summaries are not app output", async () => {
  const { open } = setup(async () => Response.json(current({ steps: [{ type: "thought", summary: [{ type: "text", text: "private reasoning summary" }] }, { type: "model_output", content: [{ type: "text", text: '{"files":' }, { type: "text", text: '[]}' }] }] })));
  expect(await open().dispatch(request)).toMatchObject({ status: "completed", generatedResult: '{"files":[]}' });
});

test("current incomplete usage is debit-eligible without fabricating output", async () => {
  const { open } = setup(async () => Response.json(current({ status: "incomplete", steps: [] })));
  const receipt = await open().dispatch(request);
  expect(receipt).toMatchObject({ status: "incomplete", cost: { micros: 5440 } });
  expect(receipt).not.toHaveProperty("generatedResult");
});

test("the current reader replays the exact normalized original produced by mainline fca7ce5 without provider access or rewriting it", async () => {
  const raw: unknown = await Bun.file("tests/fixtures/model/legacy-vertex-original.json").json();
  const golden = z.object({ operationId: z.string(), completedReceipt: z.unknown() }).passthrough().parse(raw);
  let effects = 0;
  const { open, records } = setup(async () => { effects++; throw new Error("NO_LEGACY_PROVIDER_ACCESS"); });
  const receipt = parseVertexProviderReceipt(golden.completedReceipt);
  if (!receipt) throw new Error("LEGACY_RECEIPT_REQUIRED");
  records.set(golden.operationId, structuredClone(raw));
  expect(await open(5000).reconcileOriginal({ operationId: golden.operationId })).toEqual(receipt);
  expect(records.get(golden.operationId)).toEqual(raw);
  expect(effects).toBe(0);
});

test("fresh dispatch bounds the actual structured-output schema before journal claim or paid POST", async () => {
  let sent: unknown;
  const captured = setup(async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json(current()); });
  expect(await captured.open().dispatch(request)).toMatchObject({ status: "completed" });
  const wire = z.object({ input: z.array(Text), system_instruction: z.string(), response_format: z.unknown() }).passthrough().parse(sent);
  const limit = new TextEncoder().encode(JSON.stringify({ input: wire.input, system_instruction: wire.system_instruction })).byteLength + 64;
  expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeGreaterThan(limit);
  let posts = 0;
  const { open, records } = setup(async () => { posts++; return Response.json(current()); });
  await expect(open().dispatch({ ...request, maximumInputTokens: limit })).rejects.toThrow("VERTEX_INPUT_CAP_EXCEEDED");
  expect(records.size).toBe(0);
  expect(posts).toBe(0);
});


test("current text modality details agree with the complete usage totals without changing cached pricing", async () => {
  const { open } = setup(async () => Response.json(current({ usage: { ...usage, input_tokens_by_modality: [{ modality: "text", tokens: 1000 }], cached_tokens_by_modality: [{ modality: "text", tokens: 200 }], output_tokens_by_modality: [{ modality: "text", tokens: 100 }], tool_use_tokens_by_modality: [], grounding_tool_count: [] } })));
  expect(await open().dispatch(request)).toMatchObject({ status: "completed", cost: { micros: 5440 } });
});


test("even a legacy journal cannot select a native resource whose response ID differs from its requested ID", async () => {
  let input: ReturnType<typeof contents> = [], posts = 0;
  const { open } = setup(async (url, init) => {
    if (init?.method === "POST") { posts++; input = contents(JSON.parse(String(init.body)).input); throw new Error("FIXTURE_LOST_ACK"); }
    if (url.includes("page_size=")) return Response.json({ interaction_metadatas: [{ id: "listed" }] });
    return Response.json(current({ id: "different", steps: [{ type: "user_input", content: input }, output] }));
  });
  expect(await open().dispatch(request)).toMatchObject({ status: "unknown" });
  expect(await open().reconcileOriginal({ operationId: request.operationId })).toMatchObject({ status: "unknown", reason: "receipt_invalid" });
  expect(posts).toBe(1);
});
