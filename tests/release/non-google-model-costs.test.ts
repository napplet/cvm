import { expect, test } from "bun:test";
import {
  NON_GOOGLE_COST_ROLES,
  createNonGoogleCostBound,
  createOpenAiResponsesRateSnapshot,
  priceOpenAiResponsesUsage,
} from "../../src/release/costs/non-google-cost-bound";
import {
  createOpenAiResponsesClient,
  createOpenAiResponsesHttpPort,
  type OpenAiResponsesOperationJournal,
} from "../../src/release/deployment/openai-responses-client";
import { captureOpenAiResponsesPricingDocument, OPENAI_RESPONSES_PRICING_URL } from "../../src/release/costs/official-sources";
import { createNonGoogleModelCostCatalog } from "../../src/release/costs/production-catalog";
import { createAuthoritativeUsageReportEnvelopeV2, verifyAuthoritativeUsageReportArtifactV2 } from "../../src/release/authoritative-usage-report";
import { OpenAiResponsesCandidateModelGateway } from "../../src/production/openai-responses-model-gateway";

const hex = (character: string) => character.repeat(64);
const now = 1_000_000;
const source = new TextEncoder().encode(JSON.stringify({
  schema: "openai-responses-pricing-capture-v1",
  currency: "USD",
  models: {
    "gpt-4.1-2025-04-14": {
      input_usd_per_million: "2.000000",
      cached_input_usd_per_million: "0.200000",
      output_usd_per_million: "8.000000",
    },
  },
}));
const document = Object.freeze({ sourceUrl: OPENAI_RESPONSES_PRICING_URL, bytes: source, observedAtMs: now - 1, freshUntilMs: now + 60_000 });

const rate = async () => createOpenAiResponsesRateSnapshot({ document, model: "gpt-4.1-2025-04-14" });

test("the v2 inventory names every non-Google accounting role and never uses historic fixed sixteen-family facts", async () => {
  expect(NON_GOOGLE_COST_ROLES).toEqual([
    "authoritative_native_usage",
    "documented_scoped_zero",
    "included_parent",
    "explicit_approved_shared_standing",
    "unknown_held",
  ]);
  const bound = createNonGoogleCostBound({
    maximumChargeMicros: 10_000,
    facts: [
      { role: "authoritative_native_usage", costType: "model_api_usage", provider: "openai_responses", status: "available", rate: await rate() },
      { role: "documented_scoped_zero", costType: "contextvm_protocol", provider: "contextvm", status: "available", documentedScope: "public signed ContextVM event transport only" },
      { role: "included_parent", costType: "database_authority", provider: "homelab_postgres", status: "available", parentCostType: "approved_homelab_service" },
      { role: "explicit_approved_shared_standing", costType: "homelab_host", provider: "operator_homelab", status: "available", approvalReference: "D-141" },
      { role: "unknown_held", costType: "funding_rail_fee", provider: "cashu", status: "held", holdReason: "account arrangement not verified" },
    ],
  });
  expect(bound.maximumChargeMicros).toBe(10_000);
  expect(bound.heldCostTypes).toEqual(["funding_rail_fee"]);
  expect(() => createNonGoogleCostBound({ maximumChargeMicros: 1, facts: [] })).toThrow("NON_GOOGLE_COST_ROLE_COVERAGE_REQUIRED");
});

test("native token pricing charges input/cache/output once and holds unsupported cache writes", async () => {
  const priced = priceOpenAiResponsesUsage({
    rate: await rate(),
    usage: { inputTokens: 1_000_000, cachedInputTokens: 200_000, cacheWriteTokens: 0, outputTokens: 100_000, reasoningTokens: 80_000 },
  });
  expect(priced).toMatchObject({ status: "priced", costMicros: 2_440_000 });
  expect(priced).not.toHaveProperty("reasoningChargeMicros");
  expect(priceOpenAiResponsesUsage({
    rate: await rate(),
    usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 1, outputTokens: 1, reasoningTokens: 0 },
  })).toMatchObject({ status: "held", reason: "cache_write_rate_unknown" });
});

test("non-Google catalog accepts only a fresh parsed source-bound model rate and pricing capture rejects redirects", async () => {
  const catalog = createNonGoogleModelCostCatalog({ rates: { readOpenAiResponsesRate: rate }, now: () => now });
  expect(await catalog.readModelRate()).toMatchObject({ model: "gpt-4.1-2025-04-14", currency: "USD" });
  const document = await captureOpenAiResponsesPricingDocument({ now: () => now, freshnessMs: 60_000, fetch: async (url) => {
    expect(url).toBe(OPENAI_RESPONSES_PRICING_URL);
    return new Response(source, { status: 200 });
  } });
  expect(document).toMatchObject({ sourceUrl: OPENAI_RESPONSES_PRICING_URL, observedAtMs: now });
  await expect(captureOpenAiResponsesPricingDocument({ now: () => now, fetch: async () => Response.redirect("https://example.test/", 302) })).rejects.toThrow("OPENAI_PRICE_SOURCE_RESPONSE_REJECTED");
  await expect(createOpenAiResponsesRateSnapshot({ document: { ...document, bytes: new TextEncoder().encode(JSON.stringify({ schema: "openai-responses-pricing-capture-v1", currency: "USD", models: {} })) }, model: "gpt-4.1-2025-04-14" })).rejects.toThrow("OPENAI_PRICE_SOURCE_MODEL_HELD");
});

test("versioned report v2 uses an opaque store identity rather than a forged gs URI", async () => {
  const bytes = new TextEncoder().encode("provider usage export");
  const envelope = await createAuthoritativeUsageReportEnvelopeV2({
    version: 2,
    originalOperationId: "operation:openai-report",
    originalOperationSha256: hex("b"),
    rawArtifact: { version: 2, storageKind: "opaque-external", objectIdentitySha256: hex("c") },
    coverage: "unknown",
    currency: "USD",
    grossMeteredMicros: null,
    creditsMicros: null,
    adjustmentsMicros: null,
    netInvoiceMicros: null,
    observedAtMs: now,
    rawReportBytes: bytes,
  });
  await expect(verifyAuthoritativeUsageReportArtifactV2(envelope, bytes)).resolves.toEqual(envelope);
  expect(JSON.stringify(envelope)).not.toContain("gs://");
});

test("Responses client writes the exact original before one bounded POST, hashes native bytes, and only GETs a known response id after ambiguity", async () => {
  const entries = new Map<string, unknown>();
  const journal: OpenAiResponsesOperationJournal = {
    async claim(entry) { const existing = entries.get(entry.operationId); if (existing) return { claimed: false, entry: existing }; entries.set(entry.operationId, structuredClone(entry)); return { claimed: true, entry }; },
    async read(operationId) { return entries.get(operationId); },
    async write(entry) { entries.set(entry.operationId, structuredClone(entry)); },
  };
  let posts = 0;
  let gets = 0;
  let retrievedResponseId = "resp_123";
  const port = createOpenAiResponsesHttpPort({
    authorization: async () => "Bearer fixture-only-secret",
    fetch: async (url, init) => {
      if (init?.method === "POST") {
        posts += 1;
        expect(String(url)).toBe("https://api.openai.com/v1/responses");
        expect(init.headers).toMatchObject({ "x-client-request-id": expect.stringMatching(/^napplet-cvm-/u) });
        return new Response(JSON.stringify({ id: "resp_123", model: "gpt-4.1-2025-04-14", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"files\":[]}" }] }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      gets += 1;
      return new Response(JSON.stringify({ id: retrievedResponseId, model: "gpt-4.1-2025-04-14", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"files\":[]}" }] }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } } }), { status: 200 });
    },
  });
  const client = createOpenAiResponsesClient({ candidateSha256: hex("a"), credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", rate: await rate(), maximumChargeMicros: 10_000_000, journal, port, now: () => now });
  const result = await client.dispatch({ operationId: "operation:openai-1", idea: "One focused counter", systemInstruction: "Return JSON only", maximumInputTokens: 1_000, maximumOutputTokens: 200 });
  expect(result).toMatchObject({ status: "completed", responseId: "resp_123", cost: { currency: "USD" } });
  expect((result as { rawResponseSha256?: string }).rawResponseSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(posts).toBe(1);
  expect(gets).toBe(0);
  expect(await client.reconcileOriginal({ operationId: "operation:openai-1" })).toEqual(result);
  expect(posts).toBe(1);
  expect(gets).toBe(0);
  const original = entries.get("operation:openai-1") as Record<string, unknown>;
  entries.set("operation:openai-1", { ...original, completedReceipt: { ...(original.completedReceipt as Record<string, unknown>), rateQuoteSha256: hex("f") } });
  expect(await client.reconcileOriginal({ operationId: "operation:openai-1" })).toMatchObject({ status: "unknown", reason: "receipt_invalid" });
  expect(gets).toBe(0);
  entries.set("operation:openai-1", { ...original, completedReceipt: undefined });
  retrievedResponseId = "resp_other";
  expect(await client.reconcileOriginal({ operationId: "operation:openai-1" })).toMatchObject({ status: "unknown", reason: "receipt_invalid" });
  expect(gets).toBe(1);
});

test("missing response identity remains held and is never resent", async () => {
  const entries = new Map<string, unknown>();
  const journal: OpenAiResponsesOperationJournal = {
    async claim(entry) { const existing = entries.get(entry.operationId); if (existing) return { claimed: false, entry: existing }; entries.set(entry.operationId, structuredClone(entry)); return { claimed: true, entry }; },
    async read(operationId) { return entries.get(operationId); },
    async write(entry) { entries.set(entry.operationId, structuredClone(entry)); },
  };
  let posts = 0;
  const port = createOpenAiResponsesHttpPort({ authorization: async () => "Bearer fixture-only-secret", fetch: async (_url, init) => { if (init?.method === "POST") { posts += 1; throw new Error("fixture timeout"); } throw new Error("GET_MUST_NOT_RUN_WITHOUT_ID"); } });
  const client = createOpenAiResponsesClient({ candidateSha256: hex("a"), credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14", rate: await rate(), maximumChargeMicros: 10_000_000, journal, port, now: () => now });
  expect(await client.dispatch({ operationId: "operation:openai-2", idea: "One focused counter", systemInstruction: "Return JSON only", maximumInputTokens: 1_000, maximumOutputTokens: 200 })).toMatchObject({ status: "unknown", reason: "response_id_unknown", originalOperationOnly: true });
  expect(await client.reconcileOriginal({ operationId: "operation:openai-2" })).toMatchObject({ status: "unknown", reason: "response_id_unknown" });
  expect(posts).toBe(1);
});

test("stale and cap refusal never claims an operation or reports paid ambiguity", async () => {
  let journalCalls = 0;
  let httpCalls = 0;
  const client = createOpenAiResponsesClient({
    candidateSha256: hex("a"), credentialReference: "openai:api-key:production-reference", model: "gpt-4.1-2025-04-14",
    rate: await rate(), maximumChargeMicros: 10_000_000,
    journal: {
      async claim() { journalCalls += 1; throw new Error("JOURNAL_MUST_NOT_RUN"); },
      async read() { journalCalls += 1; throw new Error("JOURNAL_MUST_NOT_RUN"); },
      async write() { journalCalls += 1; throw new Error("JOURNAL_MUST_NOT_RUN"); },
    },
    port: {
      async create() { httpCalls += 1; throw new Error("HTTP_MUST_NOT_RUN"); },
      async get() { httpCalls += 1; throw new Error("HTTP_MUST_NOT_RUN"); },
    },
    now: () => now + 60_001,
  });
  const gateway = new OpenAiResponsesCandidateModelGateway(client);
  const observation = await gateway.dispatch({
    operationId: "operation:openai-stale", providerRequestId: "request:openai-stale", accountId: "account:fixture", sessionId: "session:fixture", actionId: "action:fixture", expectedVersion: 0,
    actionBudgetReference: "budget:fixture", profileId: "openai-responses-candidate", priceCardId: "openai-source-bound", requestFingerprint: hex("b"), prompt: "One focused counter",
    maximumUnits: [{ dimension: "input_tokens", units: "1000" }, { dimension: "output_tokens", units: "200" }], selection: "unselected",
  }, new AbortController().signal);
  expect(observation).toMatchObject({ status: "definitive_not_accepted", reason: "pre_dispatch_rejected" });
  expect({ journalCalls, httpCalls }).toEqual({ journalCalls: 0, httpCalls: 0 });
});
