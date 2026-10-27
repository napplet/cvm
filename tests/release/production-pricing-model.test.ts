import { expect, test } from "bun:test";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort, type VertexInteractionsPort, type VertexOperationJournal } from "../../src/release/deployment/vertex-client";
import { createOfficialPricingSources, VERTEX_GEMINI_PRICING_URL } from "../../src/release/costs/official-sources";
import { convertUsdMicrosToSats } from "../../src/model/price-card";

const digest = (letter: string) => letter.repeat(64);
const price = Object.freeze({ sourceUrl: "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", sourceDocumentSha256: digest("a"), quoteSha256: digest("b"), observedAtMs: 1_000, freshUntilMs: 2_000, effectiveFromMs: 900, effectiveUntilMs: 3_000, currency: "USD" as const, inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 });
const interaction = (input: unknown, overrides: Record<string, unknown> = {}) => ({ id: "original", model: "gemini-4-argon", input, status: "completed", created: "2026-10-27T00:00:00.000Z", steps: [{ model_output: { content: [{ type: "text", text: '{"files":[]}' }] } }], usage: { input_tokens: 1_000, cached_input_tokens: 200, output_tokens: 1_000, thought_tokens: 100, tool_use_tokens: 0 }, ...overrides });
const dispatch = (subject: ReturnType<typeof createVertexDeploymentClient>, operationId = "vertex-original-op") => subject.dispatch({ operationId, idea: "A one-purpose napplet", systemInstruction: "Return only the requested JSON object.", maximumOutputTokens: 2_048 });

function journal(): [VertexOperationJournal, Map<string, unknown>] {
  const values = new Map<string, unknown>();
  return [Object.freeze({ async claim(entry) { const prior = values.get(entry.operationId); if (prior) return { claimed: false, entry: prior }; values.set(entry.operationId, structuredClone(entry)); return { claimed: true, entry }; }, async read(operationId) { return values.get(operationId); }, async write(entry) { values.set(entry.operationId, structuredClone(entry)); } }), values];
}
function client(input: Readonly<{ port: VertexInteractionsPort; journal?: VertexOperationJournal; now?: () => number }> ) {
  const [defaultJournal] = journal();
  return createVertexDeploymentClient({ candidateSha256: digest("c"), projectId: "napplet-cvm-run-1", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:release", price, journal: input.journal ?? defaultJournal, interactions: input.port, now: input.now ?? (() => 1_500) });
}

test("uses the documented global Interactions REST paths and snake_case payload without a retried paid POST", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const port = createVertexInteractionsHttpPort({ accessToken: async () => "a".repeat(32), fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(interaction([], { usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thought_tokens: 0, tool_use_tokens: 0 } })));
  } });
  await port.create({ projectId: "napplet-cvm-run-1", location: "global", model: "gemini-4-argon", store: true, input: [], systemInstruction: "Only JSON", responseMimeType: "application/json", responseFormat: { type: "json_schema" }, generationConfig: { maxOutputTokens: 512, thinkingLevel: "low" } });
  expect(calls.map((call) => call.url)).toEqual([
    "https://aiplatform.googleapis.com/v1beta1/projects/napplet-cvm-run-1/locations/global/interactions",
  ]);
  expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${"a".repeat(32)}` } });
  expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ model: "gemini-4-argon", input: [], system_instruction: "Only JSON", response_mime_type: "application/json", response_format: { type: "json_schema" }, generation_config: { max_output_tokens: 512, thinking_level: "low" }, store: true, stream: false, background: false, tools: [] });
});

test("uses the Plan 63 ADC source directly without accepting a caller-supplied bearer string", async () => {
  let tokenReads = 0;
  const port = createVertexInteractionsHttpPort({ tokenSource: { async getAccessToken() { tokenReads += 1; return { token: "a".repeat(32), projectId: "napplet-cvm-run-1", quotaProjectId: "napplet-cvm-run-1", principal: "release@example.com", scopes: ["https://www.googleapis.com/auth/cloud-platform"], accountScopeSha256: digest("a"), expiresAtMs: 2_000_000 }; } }, fetch: async (_url, init) => {
    expect(init.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${"a".repeat(32)}` }));
    return new Response(JSON.stringify(interaction([], { usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thought_tokens: 0, tool_use_tokens: 0 } })));
  } });
  await port.create({ projectId: "napplet-cvm-run-1", location: "global", model: "gemini-4-argon", store: true, input: [], systemInstruction: "Only JSON", responseMimeType: "application/json", responseFormat: { type: "json_schema" }, generationConfig: { maxOutputTokens: 512, thinkingLevel: "low" } });
  expect(tokenReads).toBe(1);
  expect(() => createVertexInteractionsHttpPort({ accessToken: async () => "a".repeat(32), tokenSource: { async getAccessToken() { throw new Error("not used"); } } })).toThrow("VERTEX_HTTP_CONFIGURATION_INVALID");
});

test("captures only the current global gross Gemini price table and rejects pricing-page drift", async () => {
  const sources = createOfficialPricingSources({ now: () => 1_000, fetch: async (url) => {
    if (String(url) !== VERTEX_GEMINI_PRICING_URL) return new Response("no", { status: 404 });
    return new Response("Gemini 4 Argon* through November 30, 2026 Input (text, image, video, audio) Global $2.00 $0.10 Non-global $2.20 $0.11 Text output (response and reasoning) Global $10.00 $10.00 Non-global $11.00 $11.00 Gemini 4 Argon (Starting December 1, 2026), Gemini 4 Argon Cyber Permissive Input (text, image, video, audio) Global $4.00 $0.20 Non-global $4.40 $0.22 Text output (response and reasoning) Global $20.00 $20.00 Non-global $22.00 $22.00 Promotional pricing provided through 50% credits back on net spend");
  }, google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] }, workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } } });
  await expect(sources.sources.readVertexGeminiPrice()).resolves.toMatchObject({ sourceUrl: VERTEX_GEMINI_PRICING_URL, location: "global", model: "gemini-4-argon", currency: "USD", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 });
  const drift = createOfficialPricingSources({ now: () => 1_000, fetch: async () => new Response("Gemini 4 Argon Global $2.00 / 1M"), google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] }, workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } } });
  await expect(drift.sources.readVertexGeminiPrice()).rejects.toThrow("VERTEX_PRICE_SOURCE_GROSS_UNPROVEN");
});

test("USD receipt settlement requires fresh source-attributed conversion and always rounds against the service", () => {
  const conversion = { source: { url: "https://example.com/fixed-usd-sat", capturedBytesSha256: digest("e"), observedAt: "2026-10-27T00:00:00.000Z", effectiveAt: "2026-10-27T00:00:00.000Z", freshUntil: "2026-10-27T01:00:00.000Z" }, satsPerUsd: { numerator: "100", denominator: "1" } };
  expect(convertUsdMicrosToSats({ usdMicros: 4_740_001, conversion, at: "2026-10-27T00:30:00.000Z" })).toMatchObject({ currency: "sat", amount: "475" });
  expect(() => convertUsdMicrosToSats({ usdMicros: 1, conversion, at: "2026-10-27T01:00:00.001Z" })).toThrow("USD_SAT_CONVERSION_STALE");
});

test("Gemini production receipt prices gross input, cached input, output, and thought tokens from one immutable source snapshot", async () => {
  const [store, records] = journal(); let creates = 0;
  const subject = client({ journal: store, port: { async create(value) { creates += 1; return interaction(value.input); }, async get() { throw new Error("not used"); }, async list() { throw new Error("not used"); } } });
  const result = await dispatch(subject);
  expect(result).toMatchObject({ status: "completed", model: "gemini-4-argon", cost: { currency: "USD", micros: 25_240 }, usage: { inputTokens: 800, cachedInputTokens: 200, outputTokens: 1_000, thoughtTokens: 100 }, price: { sourceDocumentSha256: digest("a"), quoteSha256: digest("b") } });
  expect(creates).toBe(1);
  const persisted = records.get("vertex-original-op") as Record<string, unknown>;
  expect(persisted.requestSha256).toMatch(/^[a-f0-9]{64}$/u); expect(persisted.price).toEqual(price);
});

test("an incomplete cap-truncated interaction still records billed usage but never returns an artifact", async () => {
  const subject = client({ port: { async create(value) { return interaction(value.input, { status: "incomplete", steps: undefined, usage: { input_tokens: 1_000, cached_input_tokens: 0, output_tokens: 2_000, thought_tokens: 48, tool_use_tokens: 0 } }); }, async get() { throw new Error("not used"); }, async list() { throw new Error("not used"); } } });
  await expect(dispatch(subject, "vertex-incomplete-op")).resolves.toMatchObject({ status: "incomplete", operationId: "vertex-incomplete-op", cost: { currency: "USD", micros: 44_960 }, usage: { inputTokens: 1_000, outputTokens: 2_000, thoughtTokens: 48 } });
});

test("lost interaction creation is query-only on retry and a bounded nonce match can recover the original", async () => {
  const [store] = journal(); let creates = 0;
  const subject = client({ journal: store, port: {
    async create() { creates += 1; throw new Error("connection lost"); },
    async get() { throw new Error("not used"); },
    async list() { return { interaction_metadatas: [] }; },
  } });
  await expect(dispatch(subject)).resolves.toMatchObject({ status: "unknown", reason: "lost_response" });
  await expect(dispatch(subject)).resolves.toMatchObject({ status: "unknown", reason: "unmatched_original" });
  expect(creates).toBe(1);
});

test("missing, duplicate, tool, or identity-mismatched interaction evidence remains unknown and cannot send another POST", async () => {
  const [store] = journal(); let creates = 0;
  const subject = client({ journal: store, port: {
    async create(value) { creates += 1; throw new Error(`lost:${JSON.stringify(value.input)}`); }, async get() { throw new Error("not used"); }, async list() { return { interaction_metadatas: [] }; },
  } });
  await dispatch(subject);
  await expect(subject.reconcileOriginal({ operationId: "vertex-original-op" })).resolves.toMatchObject({ status: "unknown", reason: "unmatched_original" });
  await expect(subject.dispatch({ operationId: "vertex-original-op", requestSha256: digest("e"), idea: "A one-purpose napplet", systemInstruction: "Return only the requested JSON object.", maximumOutputTokens: 2_048 })).rejects.toThrow("VERTEX_REQUEST_DIGEST_MISMATCH");
  expect(creates).toBe(1);
  const [toolStore] = journal();
  const toolClient = client({ journal: toolStore, port: { async create(value) { return interaction(value.input, { usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, thought_tokens: 0, tool_use_tokens: 1 } }); }, async get() { return undefined; }, async list() { return { interaction_metadatas: [] }; } } });
  await expect(dispatch(toolClient, "vertex-tool-op")).resolves.toMatchObject({ status: "unknown", reason: "receipt_invalid" });
  await expect(toolClient.reconcileOriginal({ operationId: "vertex-absent-op" })).resolves.toMatchObject({ status: "unknown", reason: "unmatched_original" });
});

test("production construction rejects retired, development, stale, and non-source-priced configurations", async () => {
  const [store] = journal(); const port = { async create() { return undefined; }, async get() { return undefined; }, async list() { return { interaction_metadatas: [] }; } };
  expect(() => createVertexDeploymentClient({ candidateSha256: digest("c"), projectId: "napplet-cvm-run-1", location: "europe-west1", model: "gemini-2.5-pro", credentialReference: "gcp:adc:release", price, journal: store, interactions: port })).toThrow("VERTEX_PRODUCTION_MODEL_REQUIRED");
  await expect(dispatch(client({ journal: store, port, now: () => 2_000 }), "vertex-stale-op")).rejects.toThrow("VERTEX_PRICE_SNAPSHOT_STALE");
});
