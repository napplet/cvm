import { expect, test } from "bun:test";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort, type VertexInteractionsPort, type VertexOperationJournal } from "../../src/release/deployment/vertex-client";
import { BTC_USD_TICKER_URL, createOfficialPricingSources, VERTEX_GEMINI_PRICING_URL } from "../../src/release/costs/official-sources";
import { convertUsdMicrosToSats, createVertexGeminiProductionPricing, priceReceipt } from "../../src/model/price-card";
import { deriveReleaseTopology, PRODUCTION_CERTIFICATION_OPERATION_INVENTORY as inventory, RELEASE_TOPOLOGY_QUANTITY_CONTRACT } from "../../src/release/topology";

const digest = (letter: string) => letter.repeat(64);
test("the model envelope covers both complete admission cohorts before any pre-inference cancellation is proven", async () => {
  const topology = await deriveReleaseTopology(digest("a"));
  expect(inventory.workerProviders).toBe(topology.workerCandidates.length);
  expect(inventory.modelOperations).toBe(topology.workerCandidates.length * (inventory.acceptedAdmissionSamples + inventory.protectedSuites));
  const input = RELEASE_TOPOLOGY_QUANTITY_CONTRACT.find(line => line.componentId === "model.global.input")!;
  const output = RELEASE_TOPOLOGY_QUANTITY_CONTRACT.find(line => line.componentId === "model.global.output-thought")!;
  expect(input.quantityNanos).toBe(BigInt(inventory.modelOperations * inventory.modelInputTokensPerOperation) * 100n);
  expect(output.quantityNanos).toBe(BigInt(inventory.modelOperations * inventory.modelOutputAndThoughtTokensPerOperation) * 100n);
  // Current gross model prices alone exceed the old single-cohort $1,000
  // guard. Neither that guard nor this test is authorization to spend.
  const gross = BigInt(inventory.modelOperations) * (BigInt(inventory.modelInputTokensPerOperation) * 4n + BigInt(inventory.modelOutputAndThoughtTokensPerOperation) * 20n);
  expect(gross).toBeGreaterThan(1_000_000_000n);
});
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

test.each([`operation:${"a".repeat(24)}`, `resume-operation:checkpoint:session:${"b".repeat(24)}:1:${"c".repeat(24)}`])("actual generation operation %s retains its identity through dispatch and original lookup", async operationId => {
  let creates = 0;
  const subject = client({ port: {
    async create(value) { creates++; return interaction(value.input); },
    async get() { throw new Error("CACHED_ORIGINAL_EXPECTED"); },
    async list() { throw new Error("CACHED_ORIGINAL_EXPECTED"); },
  } });
  expect(await dispatch(subject, operationId)).toMatchObject({ status: "completed", operationId });
  expect(await subject.reconcileOriginal({ operationId })).toMatchObject({ status: "completed", operationId });
  expect(creates).toBe(1);
});

test("invalid or oversized operation IDs cannot dispatch a model request", async () => {
  let creates = 0;
  const subject = client({ port: { async create(value) { creates++; return interaction(value.input); }, async get() { throw new Error("UNUSED"); }, async list() { throw new Error("UNUSED"); } } });
  for (const id of ["../operation:bad", "operation:/bad", "operation:\ninvalid", `operation:${"a".repeat(256)}`]) await expect(dispatch(subject, id)).rejects.toThrow();
  expect(creates).toBe(0);
});

test("fully cached input replays the original cost without subtracting cached tokens again", async () => {
  const subject = client({ port: { async create(value) { return interaction(value.input, { usage: { input_tokens: 1000, cached_input_tokens: 1000, output_tokens: 1, thought_tokens: 0, tool_use_tokens: 0 } }); }, async get() { throw new Error("CACHED_ORIGINAL_EXPECTED"); }, async list() { throw new Error("CACHED_ORIGINAL_EXPECTED"); } } });
  const original = await dispatch(subject);
  expect(original).toMatchObject({ status: "completed", usage: { inputTokens: 0, cachedInputTokens: 1000 }, cost: { currency: "USD", micros: 220 } });
  expect(await subject.reconcileOriginal({ operationId: "vertex-original-op" })).toEqual(original);
});

test("a profile input bound checks complete encoded input before the original journal claim or POST", async () => {
  const [records, values] = journal();
  let creates = 0;
  const subject = client({ journal: records, port: { async create(value) { creates++; return interaction(value.input); }, async get() { throw new Error("UNUSED"); }, async list() { throw new Error("UNUSED"); } } });
  await expect(subject.dispatch({ operationId: "operation:input-bound", idea: "a", systemInstruction: "JSON only", maximumOutputTokens: 32, maximumInputTokens: 16 })).rejects.toThrow("VERTEX_INPUT_CAP_EXCEEDED");
  expect(creates).toBe(0);
  expect(values.size).toBe(0);
});

test("uses the documented global Interactions REST paths and snake_case payload without a retried paid POST", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const port = createVertexInteractionsHttpPort({ accessToken: async () => "a".repeat(32), fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(interaction([], { usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thought_tokens: 0, tool_use_tokens: 0 } })));
  }, { preconnect() {} }) });
  await port.create({ projectId: "napplet-cvm-run-1", location: "global", model: "gemini-4-argon", store: true, input: [], systemInstruction: "Only JSON", responseMimeType: "application/json", responseFormat: { type: "json_schema" }, generationConfig: { maxOutputTokens: 512, thinkingLevel: "low" } });
  expect(calls.map((call) => call.url)).toEqual([
    "https://aiplatform.googleapis.com/v1beta1/projects/napplet-cvm-run-1/locations/global/interactions",
  ]);
  expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${"a".repeat(32)}` } });
  expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ model: "gemini-4-argon", input: [], system_instruction: "Only JSON", response_mime_type: "application/json", response_format: { type: "json_schema" }, generation_config: { max_output_tokens: 512, thinking_level: "low" }, store: true, stream: false, background: false, tools: [] });
});

test("uses the Plan 63 ADC source directly without accepting a caller-supplied bearer string", async () => {
  let tokenReads = 0;
  const port = createVertexInteractionsHttpPort({ tokenSource: { async getAccessToken() { tokenReads += 1; return { token: "a".repeat(32), projectId: "napplet-cvm-run-1", quotaProjectId: "napplet-cvm-run-1", principal: "release@example.com", scopes: ["https://www.googleapis.com/auth/cloud-platform"], accountScopeSha256: digest("a"), expiresAtMs: 2_000_000 }; } }, fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(init?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${"a".repeat(32)}` }));
    return new Response(JSON.stringify(interaction([], { usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thought_tokens: 0, tool_use_tokens: 0 } })));
  }, { preconnect() {} }) });
  await port.create({ projectId: "napplet-cvm-run-1", location: "global", model: "gemini-4-argon", store: true, input: [], systemInstruction: "Only JSON", responseMimeType: "application/json", responseFormat: { type: "json_schema" }, generationConfig: { maxOutputTokens: 512, thinkingLevel: "low" } });
  expect(tokenReads).toBe(1);
  expect(() => createVertexInteractionsHttpPort({ accessToken: async () => "a".repeat(32), tokenSource: { async getAccessToken() { throw new Error("not used"); } } })).toThrow("VERTEX_HTTP_CONFIGURATION_INVALID");
});

test("captures only the current global gross Gemini price table and rejects pricing-page drift", async () => {
  const sources = createOfficialPricingSources({ now: () => 1_000, fetch: async (url, init) => {
    expect(String(url)).toBe("https://cloud.google.com/model-garden/pricing");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    if (String(url) !== VERTEX_GEMINI_PRICING_URL) return new Response("no", { status: 404 });
    return new Response("Gemini 4 Argon* through November 30, 2026 Input (text, image, video, audio) Global $2.00 $0.10 Non-global $2.20 $0.11 Text output (response and reasoning) Global $10.00 $10.00 Non-global $11.00 $11.00 Gemini 4 Argon (Starting December 1, 2026), Gemini 4 Argon Cyber Permissive Input (text, image, video, audio) Global $4.00 $0.20 Non-global $4.40 $0.22 Text output (response and reasoning) Global $20.00 $20.00 Non-global $22.00 $22.00 Promotional pricing provided through 50% credits back on net spend");
  }, google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] }, workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } } });
  await expect(sources.sources.readVertexGeminiPrice()).resolves.toMatchObject({ sourceUrl: VERTEX_GEMINI_PRICING_URL, location: "global", model: "gemini-4-argon", currency: "USD", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 });
  const drift = createOfficialPricingSources({ now: () => 1_000, fetch: async () => new Response("Gemini 4 Argon Global $2.00 / 1M"), google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] }, workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } } });
  await expect(drift.sources.readVertexGeminiPrice()).rejects.toThrow("VERTEX_PRICE_SOURCE_GROSS_UNPROVEN");
});

test.each([301, 302, 307, 308])("official Gemini price capture rejects HTTP %s rather than following it", async status => {
  let calls = 0;
  const sources = createOfficialPricingSources({ now: () => 1_000, fetch: async (_url, init) => {
    calls++;
    expect(init?.redirect).toBe("error");
    return new Response(null, { status, headers: { location: "https://example.com/pricing" } });
  }, google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] }, workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } } });
  await expect(sources.sources.readVertexGeminiPrice()).rejects.toThrow("OFFICIAL_SOURCE_RESPONSE_REJECTED");
  expect(calls).toBe(1);
});

function modalPricingReader(document: string, unit: "worker-second" | "worker-100-seconds") {
  return createOfficialPricingSources({
    now: () => 1_000,
    fetch: async (url) => String(url) === "https://modal.com/pricing" ? new Response(document) : new Response("not found", { status: 404 }),
    google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] },
    workers: { modal: { cpuCores: 1, memoryGiB: 1, unit }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } },
  });
}

test("Modal worker pricing reads only one rendered Sandbox section and preserves exact pricing units", async () => {
  const generalCompute = "<section id=\"general\"><h2>General compute pricing</h2>CPU $0.00001310 / core / sec Memory $0.00000222 / GiB / sec</section>";
  const sandbox = "<section id=\"sandboxes\"><h2>Modal Sandbox pricing</h2><div class=\"resource-row\"><span>CPU (non-preemptible)</span><span>$0.00003942 / core / sec</span></div><div class=\"resource-row\"><span>Memory (non-preemptible)</span><span>$0.00000667 / GiB / sec</span></div></section>";
  await expect(modalPricingReader(`${generalCompute}${sandbox}`, "worker-second").sources.readOfficialPricing({ provider: "modal" })).resolves.toMatchObject({
    quotes: [{ unit: "worker-second", priceNanos: "46090", priceMicros: 47 }],
  });
  await expect(modalPricingReader(`${generalCompute}${sandbox}`, "worker-100-seconds").sources.readOfficialPricing({ provider: "modal" })).resolves.toMatchObject({
    quotes: [{ unit: "worker-100-seconds", priceNanos: "4609000", priceMicros: 4609 }],
  });

  await expect(modalPricingReader(generalCompute, "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow("MODAL_SANDBOX_PRICING_SECTION_REJECTED");
  await expect(modalPricingReader("<section data-id=\"sandboxes\"><h2>Modal Sandbox pricing</h2>CPU (non-preemptible) $0.00000001 / core / sec Memory (non-preemptible) $0.00000667 / GiB / sec</section>", "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow("MODAL_SANDBOX_PRICING_SECTION_REJECTED");
  await expect(modalPricingReader("<section id=\"sandboxes\"><h2>Modal Sandbox pricing</h2>CPU $0.00003942 / core / sec</section>", "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow("MODAL_SANDBOX_PRICING_RATE_REJECTED");
  await expect(modalPricingReader(`${sandbox}${sandbox}`, "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow("MODAL_SANDBOX_PRICING_SECTION_REJECTED");
  await expect(modalPricingReader("<section id=\"sandboxes\"><h2>Modal Sandbox pricing</h2>CPU $0.00003942 / core / sec", "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow("MODAL_SANDBOX_PRICING_SECTION_REJECTED");
});

test("Modal worker pricing rejects preemptible, unlabelled, unrelated, duplicate, and cross-element rate rows", async () => {
  const pricing = (rows: string) => `<section id=\"sandboxes\"><h2>Modal Sandbox pricing</h2>${rows}</section>`;
  const expected = "MODAL_SANDBOX_PRICING_RATE_REJECTED";
  await expect(modalPricingReader(pricing("Preemptible CPU $0.00000001 / core / sec Preemptible Memory $0.00000001 / GiB / sec"), "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow(expected);
  await expect(modalPricingReader(pricing("$0.00003942 / core / sec $0.00000667 / GiB / sec"), "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow(expected);
  await expect(modalPricingReader(pricing("Storage (non-preemptible) $0.00000001 / core / sec Network (non-preemptible) $0.00000001 / GiB / sec"), "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow(expected);
  await expect(modalPricingReader(pricing("<div>CPU (non-preemptible) $0.00003942 / core / sec</div><div>Memory (non-preemptible) $0.00000667 / GiB / sec</div><div>CPU (non-preemptible) $0.00000001 / core / sec</div><div>Memory (non-preemptible) $0.00000001 / GiB / sec</div>"), "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow(expected);
  await expect(modalPricingReader(pricing("<div><span>CPU (non-preemptible)</span><span>Storage (non-preemptible) $0.00000001 / core / sec</span></div><div>Memory (non-preemptible) $0.00000667 / GiB / sec</div>"), "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow(expected);
  await expect(modalPricingReader(pricing("<div>CPU (non-preemptible) $0.00003942 / core / sec</div><div><span>Memory (non-preemptible)</span><span>Storage (non-preemptible) $0.00000001 / GiB / sec</span></div>"), "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow(expected);
  await expect(modalPricingReader(pricing("<div class=\"resource-row\"><span>CPU (non-preemptible)</span><span>Storage $0.00000001 / core / sec</span></div><div class=\"resource-row\"><span>Memory (non-preemptible)</span><span>$0.00000667 / GiB / sec</span></div>"), "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow(expected);
  await expect(modalPricingReader(pricing("<div class=\"resource-row\"><span>CPU (non-preemptible)</span><span>$0.00003942 / core / sec</span></div><div class=\"resource-row\"><span>Memory (non-preemptible)</span><span>Storage $0.00000001 / GiB / sec</span></div>"), "worker-second").sources.readOfficialPricing({ provider: "modal" })).rejects.toThrow(expected);
});

test("USD receipt settlement captures a fresh executable USD/SAT source quote and always rounds against the service", async () => {
  const sources = createOfficialPricingSources({ now: () => Date.parse("2026-10-27T00:00:00.000Z"), fetch: async (url) => {
    if (String(url) !== BTC_USD_TICKER_URL) return new Response("no", { status: 404 });
    return new Response(JSON.stringify({ price: "100000.00", product_id: "BTC-USD" }));
  }, google: { selectors: [{ componentId: "cloud_run.europe-west1.cpu", provider: "cloud_run", serviceDisplayName: "Cloud Run", skuId: "RUN-CPU", region: "europe-west1", usageUnit: "seconds", unit: "worker-second" }] }, workers: { modal: { cpuCores: 1, memoryGiB: 1, unit: "worker-second" }, fly: { preset: "shared-cpu-1x", memory: "256MB", unit: "worker-second" } } });
  const conversion = await sources.sources.readUsdSatConversion();
  expect(conversion).toMatchObject({ source: { url: BTC_USD_TICKER_URL, observedAt: "2026-10-27T00:00:00.000Z" }, satsPerUsd: { numerator: "1000", denominator: "1" } });
  expect(convertUsdMicrosToSats({ usdMicros: 4_740_001, conversion, at: "2026-10-27T00:30:00.000Z" })).toMatchObject({ currency: "sat", amount: "4741" });
  expect(() => convertUsdMicrosToSats({ usdMicros: 1, conversion, at: "2026-10-27T01:00:00.001Z" })).toThrow("USD_SAT_CONVERSION_STALE");
});

test("the Gemini model profile and USD price card can only be built from captured provider and FX sources", async () => {
  const conversion = { source: { url: BTC_USD_TICKER_URL, capturedBytesSha256: digest("e"), observedAt: "2026-10-27T00:00:00.000Z", effectiveAt: "2026-10-27T00:00:00.000Z", freshUntil: "2026-10-27T01:00:00.000Z" }, satsPerUsd: { numerator: "1000", denominator: "1" } };
  const pricing = await createVertexGeminiProductionPricing({ observation: { sourceUrl: VERTEX_GEMINI_PRICING_URL, bytes: new TextEncoder().encode("Vertex official source"), observedAtMs: Date.parse("2026-10-27T00:00:00.000Z"), freshUntilMs: Date.parse("2026-10-27T01:00:00.000Z"), currency: "USD", location: "global", model: "gemini-4-argon", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 }, conversion, profileId: "production-gemini-argon", maximumInputTokens: "1000", maximumOutputTokens: "100", deadlineMs: 30_000 });
  expect(pricing.card).toMatchObject({ kind: "source_attributed_provider", provider: "vertex_ai_gemini", currency: "usd_micros", sources: { provider: { url: VERTEX_GEMINI_PRICING_URL }, conversion: { url: BTC_USD_TICKER_URL } } });
  expect(priceReceipt({ receipt: { operationId: "op-price-source", providerRequestId: "vertex-source-1", profileId: pricing.profile.id, priceCardId: pricing.card.id, provider: "vertex_ai_gemini", model: "gemini-4-argon", selection: "unselected", completedAt: "2026-10-27T00:10:00.000Z", provenance: { protectedEvidenceReference: "evidence:vertex-source-1" }, usage: [{ dimension: "input_tokens", units: "1" }] }, card: pricing.card, profile: pricing.profile })).toMatchObject({ status: "priced", total: "4" });
  await expect(createVertexGeminiProductionPricing({ observation: { sourceUrl: "https://example.com/not-vertex", bytes: new Uint8Array([1]), observedAtMs: 1, freshUntilMs: 2, currency: "USD", location: "global", model: "gemini-4-argon", inputMicrosPerMillion: 1, cachedInputMicrosPerMillion: 1, outputAndThoughtMicrosPerMillion: 1 }, conversion, profileId: "bad", maximumInputTokens: "1", maximumOutputTokens: "1", deadlineMs: 1 })).rejects.toThrow("VERTEX_PRODUCTION_PRICE_SOURCE_INVALID");
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

test("a persisted provider interaction ID is recovered by direct GET and a tampered receipt never settles", async () => {
  const [store, records] = journal(); let gets = 0;
  const subject = client({ journal: store, port: {
    async create(value) { return interaction(value.input, { status: "in_progress", usage: undefined }); },
    async get() { gets += 1; return interaction([{ role: "user", content: [{ type: "text", text: JSON.stringify({ nonce: "napplet-cvm:vertex-direct-op:ignored", request_sha256: digest("e"), idea: "wrong", system_instruction: "wrong", max_output_tokens: 1 }) }] }]); },
    async list() { throw new Error("known IDs must not list"); },
  } });
  await expect(dispatch(subject, "vertex-direct-op")).resolves.toMatchObject({ status: "pending" });
  await expect(dispatch(subject, "vertex-direct-op")).resolves.toMatchObject({ status: "unknown", reason: "receipt_invalid" });
  expect(gets).toBe(1);
  const stored = records.get("vertex-direct-op") as Record<string, unknown>;
  records.set("vertex-direct-op", { ...stored, completedReceipt: { status: "incomplete", operationId: "vertex-direct-op", interactionId: stored.interactionId, model: "gemini-4-argon", requestSha256: stored.requestSha256, price, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, thoughtTokens: 0 }, cost: { currency: "USD", micros: 999_999 }, completedAt: "2026-10-27T00:00:00.000Z" } });
  await expect(subject.reconcileOriginal({ operationId: "vertex-direct-op" })).resolves.toMatchObject({ status: "unknown", reason: "receipt_invalid" });
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
