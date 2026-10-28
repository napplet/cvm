import { expect, test } from "bun:test";
import { z } from "zod";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort, type VertexOperationJournal } from "../../src/release/deployment/vertex-client";
import { delayedResponse } from "../fixtures/model/delayed-response";
const price = { sourceUrl: "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", sourceDocumentSha256: "a".repeat(64), quoteSha256: "b".repeat(64), observedAtMs: 1000, freshUntilMs: 2000, effectiveFromMs: 900, effectiveUntilMs: 3000, currency: "USD", inputMicrosPerMillion: 4000000, cachedInputMicrosPerMillion: 200000, outputAndThoughtMicrosPerMillion: 20000000 };
const command = { operationId: "operation:creation-budget", idea: "One synthetic counter", systemInstruction: "JSON only", maximumInputTokens: 2000, maximumOutputTokens: 200 };
function fixture(creationTimeoutMs: number) {
  const records = new Map<string, unknown>(); let posts = 0, reads = 0, input: unknown;
  const response = (stored: boolean) => Response.json({ id: "original", model: "gemini-4-argon", status: "completed", created: new Date(1500).toISOString(), steps: [...(stored ? [{ type: "user_input", content: input }] : []), { type: "model_output", content: [{ type: "text", text: '{"files":[]}' }] }], usage: { total_input_tokens: 1000, total_cached_tokens: 200, total_output_tokens: 100, total_thought_tokens: 10, total_tool_use_tokens: 0, total_tokens: 1110 } });
  const journal: VertexOperationJournal = { async read(id) { return records.get(id); }, async claim(entry) { const existing = records.get(entry.operationId); if (existing) return { claimed: false, entry: existing }; records.set(entry.operationId, structuredClone(entry)); return { claimed: true, entry }; }, async write(entry) { records.set(entry.operationId, structuredClone(entry)); } };
  const port = createVertexInteractionsHttpPort({ timeoutMs: 1000, creationTimeoutMs, accessToken: async () => "a".repeat(32), fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "POST") { posts++; input = z.object({ input: z.unknown() }).passthrough().parse(JSON.parse(String(init.body))).input; return delayedResponse(1200, init.signal, response(false)); }
    reads++;
    if (String(url).includes("page_size=")) return Response.json({ interaction_metadatas: [{ id: "original" }] });
    return response(true);
  }, { preconnect() {} }) });
  const open = () => createVertexDeploymentClient({ candidateSha256: "c".repeat(64), projectId: "napplet-cvm-test", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:test", price, journal, interactions: port, now: () => 1500 });
  return { open, counts: () => ({ posts, reads }) };
}

test("creation can finish after the lookup timeout within its own approved budget", async () => {
  const value = fixture(2500);
  expect(await value.open().dispatch(command)).toMatchObject({ status: "completed", cost: { micros: 5440 } });
  expect(value.counts()).toEqual({ posts: 1, reads: 0 });
});

test("over-budget creation stays unknown and later observes the same original without repeating POST", async () => {
  const value = fixture(1000);
  expect(await value.open().dispatch(command)).toMatchObject({ status: "unknown", reason: "lost_response" });
  expect(await value.open().reconcileOriginal({ operationId: command.operationId })).toMatchObject({ status: "completed", cost: { micros: 5440 } });
  expect(value.counts()).toEqual({ posts: 1, reads: 2 });
});

test("a longer creation budget does not extend an original GET timeout", async () => {
  let aborts = 0;
  const port = createVertexInteractionsHttpPort({ timeoutMs: 1000, creationTimeoutMs: 2500, accessToken: async () => "a".repeat(32), fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => aborts++, { once: true });
    return delayedResponse(1200, init?.signal, Response.json({ status: "in_progress" }));
  }, { preconnect() {} }) });
  await expect(port.get({ projectId: "napplet-cvm-test", location: "global", id: "original" })).rejects.toThrow("Fixture request aborted");
  expect(aborts).toBe(1);
});

test.each([0, -1, 999, 540001, 1.5, NaN, Infinity])("invalid creation budget %s is rejected before credential or HTTP access", creationTimeoutMs => {
  let calls = 0;
  expect(() => createVertexInteractionsHttpPort({ creationTimeoutMs, accessToken: async () => { calls++; return "a".repeat(32); } })).toThrow("VERTEX_HTTP_CONFIGURATION_INVALID");
  expect(calls).toBe(0);
});
