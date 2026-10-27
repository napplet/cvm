import { expect, test } from "bun:test";
import { createVertexDeploymentClient, type VertexInteractionsPort, type VertexOperationJournal } from "../../src/release/deployment/vertex-client";
import { createOfficialPricingSources, VERTEX_GEMINI_PRICING_URL } from "../../src/release/costs/official-sources";
import { convertUsdMicrosToSats } from "../../src/model/price-card";

const digest = (letter: string) => letter.repeat(64);
const price = Object.freeze({ sourceUrl: "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", sourceDocumentSha256: digest("a"), quoteSha256: digest("b"), observedAtMs: 1_000, freshUntilMs: 2_000, effectiveFromMs: 900, effectiveUntilMs: 3_000, currency: "USD" as const, inputMicrosPerMillion: 1_500_000, cachedInputMicrosPerMillion: 150_000, outputAndThoughtMicrosPerMillion: 7_500_000 });
const interaction = (input: unknown, overrides: Record<string, unknown> = {}) => ({ id: "original", model: "gemini-3.8-flash", input, status: "completed", created: "2026-10-27T00:00:00.000Z", output_text: '{"files":[]}', usage: { totalInputTokens: 1_000_000, totalCachedTokens: 200_000, totalOutputTokens: 1_000_000, totalThoughtTokens: 100_000, totalToolUseTokens: 0 }, ...overrides });
const dispatch = (subject: ReturnType<typeof createVertexDeploymentClient>, operationId = "vertex-original-op", requestSha256 = digest("d")) => subject.dispatch({ operationId, requestSha256, idea: "A one-purpose napplet", systemInstruction: "Return only the requested JSON object.", maximumOutputTokens: 1_024 });

function journal(): [VertexOperationJournal, Map<string, unknown>] {
  const values = new Map<string, unknown>();
  return [Object.freeze({ async claim(entry) { const prior = values.get(entry.operationId); if (prior) return { claimed: false, entry: prior }; values.set(entry.operationId, structuredClone(entry)); return { claimed: true, entry }; }, async read(operationId) { return values.get(operationId); }, async write(entry) { values.set(entry.operationId, structuredClone(entry)); } }), values];
}
function client(input: Readonly<{ port: VertexInteractionsPort; journal?: VertexOperationJournal; now?: () => number }> ) {
  const [defaultJournal] = journal();
  return createVertexDeploymentClient({ candidateSha256: digest("c"), projectId: "napplet-cvm-run-1", location: "global", model: "gemini-3.8-flash", credentialReference: "gcp:adc:release", price, journal: input.journal ?? defaultJournal, interactions: input.port, now: input.now ?? (() => 1_500) });
}

test("captures only the current global gross Gemini price table and rejects pricing-page drift", async () => {
  const sources = createOfficialPricingSources({ now: () => 1_000, fetch: async (url) => {
    if (String(url) !== VERTEX_GEMINI_PRICING_URL) return new Response("no", { status: 404 });
    return new Response("Gemini 3.8 Flash* through December 31, 2026 Input (text, image, video, audio) Global $0.75 $0.75 $0.075 $0.075 Non-global Text output (response and reasoning) Global $3.75 $3.75 Gemini 3.8 Flash Starting January 1, 2027 Input (text, image, video, audio) Global $1.50 $1.50 $0.15 $0.15 Non-global Text output (response and reasoning) Global $7.50 $7.50 Promotional pricing provided through 50% credits back on net spend");
  }, google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] }, workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } } });
  await expect(sources.sources.readVertexGeminiPrice()).resolves.toMatchObject({ sourceUrl: VERTEX_GEMINI_PRICING_URL, location: "global", model: "gemini-3.8-flash", currency: "USD", inputMicrosPerMillion: 1_500_000, cachedInputMicrosPerMillion: 150_000, outputAndThoughtMicrosPerMillion: 7_500_000 });
  const drift = createOfficialPricingSources({ now: () => 1_000, fetch: async () => new Response("Gemini 3.8 Flash Global $0.75 / 1M"), google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] }, workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } } });
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
  expect(result).toMatchObject({ status: "completed", model: "gemini-3.8-flash", cost: { currency: "USD", micros: 9_480_000 }, usage: { inputTokens: 800_000, cachedInputTokens: 200_000, outputTokens: 1_000_000, thoughtTokens: 100_000 }, price: { sourceDocumentSha256: digest("a"), quoteSha256: digest("b") } });
  expect(creates).toBe(1);
  const persisted = records.get("vertex-original-op") as Record<string, unknown>;
  expect(persisted.requestSha256).toBe(digest("d")); expect(persisted.price).toEqual(price);
});

test("lost interaction creation is query-only on retry and a bounded nonce match can recover the original", async () => {
  const [store] = journal(); let creates = 0; let listed = 0; let gets = 0; let contents: unknown = undefined;
  const subject = client({ journal: store, port: {
    async create(value) { creates += 1; contents = value.input; throw new Error("connection lost"); },
    async list() { listed += 1; return { interaction_metadatas: [{ id: "original" }] }; },
    async get(value) { gets += 1; return interaction(contents, { id: value.id }); },
  } });
  await expect(dispatch(subject)).resolves.toMatchObject({ status: "unknown", reason: "lost_response" });
  await expect(dispatch(subject)).resolves.toMatchObject({ status: "completed", operationId: "vertex-original-op" });
  expect({ creates, listed, gets }).toEqual({ creates: 1, listed: 1, gets: 1 });
});

test("missing, duplicate, tool, or identity-mismatched interaction evidence remains unknown and cannot send another POST", async () => {
  const [store] = journal(); let creates = 0;
  const subject = client({ journal: store, port: {
    async create(value) { creates += 1; throw new Error(`lost:${JSON.stringify(value.input)}`); },
    async list() { return { interaction_metadatas: [] }; }, async get() { throw new Error("not used"); },
  } });
  await dispatch(subject);
  await expect(subject.reconcileOriginal({ operationId: "vertex-original-op" })).resolves.toMatchObject({ status: "unknown", reason: "unmatched_original" });
  await expect(dispatch(subject, "vertex-original-op", digest("e"))).rejects.toThrow("VERTEX_OPERATION_IDENTITY_CONFLICT");
  expect(creates).toBe(1);
  const [toolStore] = journal();
  const toolClient = client({ journal: toolStore, port: { async create(value) { return interaction(value.input, { usage: { totalInputTokens: 1, totalCachedTokens: 0, totalOutputTokens: 1, totalThoughtTokens: 0, totalToolUseTokens: 1 } }); }, async list() { return { interaction_metadatas: [] }; }, async get() { return undefined; } } });
  await expect(dispatch(toolClient, "vertex-tool-op")).resolves.toMatchObject({ status: "unknown", reason: "receipt_invalid" });
  await expect(toolClient.reconcileOriginal({ operationId: "vertex-absent-op" })).resolves.toMatchObject({ status: "unknown", reason: "unmatched_original" });
});

test("production construction rejects retired, development, stale, and non-source-priced configurations", async () => {
  const [store] = journal(); const port = { async create() { return undefined; }, async get() { return undefined; }, async list() { return { interactions: [] }; } };
  expect(() => createVertexDeploymentClient({ candidateSha256: digest("c"), projectId: "napplet-cvm-run-1", location: "europe-west1", model: "gemini-2.5-pro", credentialReference: "gcp:adc:release", price, journal: store, interactions: port })).toThrow("VERTEX_PRODUCTION_MODEL_REQUIRED");
  await expect(dispatch(client({ journal: store, port, now: () => 2_000 }), "vertex-stale-op")).rejects.toThrow("VERTEX_PRICE_SNAPSHOT_STALE");
});
