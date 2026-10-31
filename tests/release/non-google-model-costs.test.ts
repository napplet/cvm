import { expect, test } from "bun:test";
import {
  NON_GOOGLE_COST_ROLES,
  assertNonGoogleCostBoundAuthorizable,
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
/** Bounded card ownership shape observed in the retained official ModelView.
 * Production captures retain the full page; the fixture preserves its decoded
 * model identity, semantic cards, and exact seven-div ancestry. */
const cards = `<div class="flex flex-col gap-2 md:flex-row">
<div class="flex flex-1 flex-col gap-1 rounded-lg border border-solid border-default bg-surface-secondary px-3 py-4"><div>Input</div><div class="text-2xl font-semibold">$2.00</div></div>
<div class="flex flex-1 flex-col gap-1 rounded-lg border border-solid border-default bg-surface-secondary px-3 py-4"><div>Cached input</div><div class="text-2xl font-semibold">$0.50</div></div>
<div class="flex flex-1 flex-col gap-1 rounded-lg border border-solid border-default bg-surface-secondary px-3 py-4"><div>Output</div><div class="text-2xl font-semibold">$8.00</div></div>
</div>`;
const modelView = (body: string) => `<astro-island component-export="ModelView" component-url="/_astro/ModelView.react.abc.js" props="{&quot;modelName&quot;:[0,&quot;gpt-4.1&quot;]}">${body}</astro-island>`;
const primaryCards = `<div class="relative"><div class="relative mx-4 flex flex-col gap-4 overflow-hidden px-4 pt-8 pb-10 sm:mx-8 md:mx-auto md:w-full md:max-w-6xl md:px-12 xl:px-4"><div></div><div class="flex flex-col gap-8"><div></div><div class="flex flex-col gap-4 lg:flex-row"><div></div><div></div><div></div><div></div><div class="flex flex-1 flex-col gap-4"><div></div><div class="flex flex-col gap-4"><div></div>${cards}</div></div></div></div></div></div>`;
const source = new TextEncoder().encode(`<!doctype html><html><body>${modelView(`<code class="text-xs">gpt-4.1-2025-04-14</code>${primaryCards}`)}</body></html>`);
const document = Object.freeze({ sourceUrl: OPENAI_RESPONSES_PRICING_URL, bytes: source, observedAtMs: now - 1, freshUntilMs: now + 60_000 });

const rate = async () => createOpenAiResponsesRateSnapshot({ document, model: "gpt-4.1-2025-04-14" });
const publicSourceIntegration = process.env.NAPPLET_RUN_OPENAI_PUBLIC_SOURCE === "1" ? test : test.skip;

test("the v2 inventory names every non-Google accounting role and never uses historic fixed sixteen-family facts", async () => {
  expect(NON_GOOGLE_COST_ROLES).toEqual([
    "authoritative_native_usage",
    "documented_scoped_zero",
    "included_parent",
    "explicit_approved_shared_standing",
    "unknown_held",
  ]);
  const candidateSha256 = hex("a");
  const topologySha256 = hex("d");
  const nativeRate = await rate();
  const artifacts = new Map<string, Readonly<{ sourceUrl: string; bytes: Uint8Array }>>();
  const evidence = async (scope: string, sourceKind: "official_openai_model" | "contextvm_transport_policy" | "operator_homelab_policy" | "operator_approval_policy" | "unknown", sourceUrl: string) => {
    const reference = `evidence:${sourceKind}`;
    const bytes = sourceKind === "official_openai_model" ? source : new TextEncoder().encode(`${sourceKind}:${scope}`);
    const digest = sourceKind === "official_openai_model" ? nativeRate.sourceDocumentSha256 : Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    artifacts.set(reference, { sourceUrl, bytes });
    return {
    artifactReference: reference,
    sourceKind,
    sourceUrl,
    sourceArtifactSha256: digest,
    sourceDocumentSha256: digest,
    observedAtMs: nativeRate.observedAtMs,
    freshUntilMs: nativeRate.freshUntilMs,
    currency: "USD" as const,
    fx: { kind: "native_usd" as const, sourceDocumentSha256: digest, numerator: 1 as const, denominator: 1 as const },
    unit: "usd-per-million-tokens",
    precision: 6,
    scope,
    candidateSha256,
    topologySha256,
  }; };
  const bound = createNonGoogleCostBound({
    maximumChargeMicros: 10_000,
    candidateSha256,
    topologySha256,
    facts: [
      { role: "authoritative_native_usage", costType: "model_api_usage", provider: "openai_responses", status: "available", rate: nativeRate, evidence: await evidence("OpenAI Responses model generation for this candidate", "official_openai_model", OPENAI_RESPONSES_PRICING_URL) },
      { role: "documented_scoped_zero", costType: "contextvm_protocol", provider: "contextvm", status: "available", documentedScope: "public signed ContextVM event transport only", evidence: await evidence("ContextVM signed event transport for this candidate", "contextvm_transport_policy", "https://docs.contextvm.org/") },
      { role: "included_parent", costType: "database_authority", provider: "homelab_postgres", status: "available", parentCostType: "approved_homelab_service", evidence: await evidence("PostgreSQL authority used for this candidate", "operator_homelab_policy", "https://napplet-cvm.invalid/policy/homelab") },
      { role: "explicit_approved_shared_standing", costType: "homelab_host", provider: "operator_homelab", status: "available", approvalReference: "D-141", evidence: await evidence("Approved homelab standing for this candidate", "operator_approval_policy", "https://napplet-cvm.invalid/policy/approval") },
      { role: "unknown_held", costType: "funding_rail_fee", provider: "cashu", status: "held", holdReason: "account arrangement not verified", evidence: await evidence("Funding fee evidence remains unavailable for this candidate", "unknown", "https://napplet-cvm.invalid/policy/unknown") },
      { role: "unknown_held", costType: "worker_sandbox_usage", provider: "modal", status: "held", holdReason: "worker contract availability not verified", evidence: await evidence("Worker evidence remains unavailable for this candidate", "unknown", "https://napplet-cvm.invalid/policy/worker") },
      { role: "unknown_held", costType: "object_authority", provider: "homelab_object", status: "held", holdReason: "object authority availability not verified", evidence: await evidence("Object evidence remains unavailable for this candidate", "unknown", "https://napplet-cvm.invalid/policy/object") },
      { role: "unknown_held", costType: "publication_transport", provider: "napplet", status: "held", holdReason: "publication transport availability not verified", evidence: await evidence("Publication evidence remains unavailable", "unknown", "https://napplet-cvm.invalid/policy/publication") },
    ],
  });
  expect(bound.maximumChargeMicros).toBe(10_000);
  expect(bound.heldCostTypes).toEqual(["funding_rail_fee", "worker_sandbox_usage", "object_authority", "publication_transport"]);
  const resolver = { async read(reference: string) { const artifact = artifacts.get(reference); if (!artifact) throw new Error("MISSING_FIXTURE"); return artifact; } };
  await expect(assertNonGoogleCostBoundAuthorizable({ bound, candidateSha256, topologySha256, nowMs: now, evidence: resolver })).rejects.toThrow("NON_GOOGLE_COST_BOUND_HELD");
  await expect(assertNonGoogleCostBoundAuthorizable({ bound, candidateSha256, topologySha256, nowMs: now, evidence: { async read(reference) { const artifact = await resolver.read(reference); return reference === "evidence:operator_homelab_policy" ? { ...artifact, bytes: new TextEncoder().encode("tampered") } : artifact; } } })).rejects.toThrow("NON_GOOGLE_COST_EVIDENCE_ARTIFACT_INVALID");
  await expect(assertNonGoogleCostBoundAuthorizable({ bound, candidateSha256: hex("b"), topologySha256, nowMs: now, evidence: resolver })).rejects.toThrow("NON_GOOGLE_COST_CANDIDATE_MISMATCH");
  expect(() => createNonGoogleCostBound({ maximumChargeMicros: 10_000, candidateSha256, topologySha256, facts: bound.facts.map((fact) => fact.role === "documented_scoped_zero" ? { ...fact, evidence: { ...fact.evidence, sourceKind: "official_openai_model" as const, sourceUrl: OPENAI_RESPONSES_PRICING_URL } } : fact) })).toThrow("NON_GOOGLE_COST_EVIDENCE_POLICY_MISMATCH");
  expect(() => createNonGoogleCostBound({ maximumChargeMicros: 1, candidateSha256, topologySha256, facts: [] })).toThrow("NON_GOOGLE_COST_COMPONENT_COVERAGE_REQUIRED");
});

test("native token pricing charges input/cache/output once and holds unsupported cache writes", async () => {
  const priced = priceOpenAiResponsesUsage({
    rate: await rate(),
    usage: { inputTokens: 1_000_000, cachedInputTokens: 200_000, cacheWriteTokens: 0, outputTokens: 100_000, reasoningTokens: 80_000 },
  });
  expect(priced).toMatchObject({ status: "priced", costMicros: 2_500_000 });
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
  await expect(createOpenAiResponsesRateSnapshot({ document: { ...document, bytes: new TextEncoder().encode("<!doctype html><html><body>changed document</body></html>") }, model: "gpt-4.1-2025-04-14" })).rejects.toThrow("OPENAI_PRICE_SOURCE_MODEL_HELD");
  await expect(createOpenAiResponsesRateSnapshot({ document: { ...document, bytes: new TextEncoder().encode("<!doctype html><html><body><code>gpt-4.1-2025-04-14</code></body></html>") }, model: "gpt-4.1-2025-04-14" })).rejects.toThrow("OPENAI_PRICE_SOURCE_MODEL_HELD");
  const otherCards = '<code>other-2025-04-14</code><div>Input</div><div>$1.00</div></div><div><div>Cached input</div><div>$0.10</div></div><div><div>Output</div><div>$2.00</div></div>';
  await expect(createOpenAiResponsesRateSnapshot({ document: { ...document, bytes: new TextEncoder().encode(`<!doctype html><html><body><code>gpt-4.1-2025-04-14</code>${otherCards}</body></html>`) }, model: "gpt-4.1-2025-04-14" })).rejects.toThrow("OPENAI_PRICE_SOURCE_MODEL_HELD");
  await expect(createOpenAiResponsesRateSnapshot({ document: { ...document, bytes: new TextEncoder().encode(`<!doctype html><html><body>${new TextDecoder().decode(source)}${new TextDecoder().decode(source)}</body></html>`) }, model: "gpt-4.1-2025-04-14" })).rejects.toThrow("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  const navigationSelectedOtherHeading = `<!doctype html><html><body><nav><code>gpt-4.1-2025-04-14</code></nav><article data-openai-model="other-2025-04-14"><h2>other-2025-04-14</h2><div>Input</div><div>$1.00</div></div><div><div>Cached input</div><div>$0.10</div></div><div><div>Output</div><div>$2.00</div></div></article></body></html>`;
  await expect(createOpenAiResponsesRateSnapshot({ document: { ...document, bytes: new TextEncoder().encode(navigationSelectedOtherHeading) }, model: "gpt-4.1-2025-04-14" })).rejects.toThrow("OPENAI_PRICE_SOURCE_MODEL_HELD");
  for (const nested of [
    modelView(`<section data-openai-model="other-2025-04-14"><code>gpt-4.1-2025-04-14</code>${cards}</section>`),
    modelView(`<article data-openai-model="other-2025-04-14"><code>gpt-4.1-2025-04-14</code>${cards}</article>`),
    modelView(`<code>gpt-4.1-2025-04-14</code><div>${cards}</div>`),
    modelView(`<code>gpt-4.1-2025-04-14</code><div><code>other-2025-04-14</code>${cards}</div>`),
    modelView(`<code>gpt-4.1-2025-04-14</code>${modelView(`<code>other-2025-04-14</code>${cards}`)}`),
  ]) {
    await expect(createOpenAiResponsesRateSnapshot({ document: { ...document, bytes: new TextEncoder().encode(`<!doctype html><html><body>${nested}</body></html>`) }, model: "gpt-4.1-2025-04-14" })).rejects.toThrow("OPENAI_PRICE_SOURCE_PARSER_DRIFT");
  }
});

publicSourceIntegration("the retained fixed OpenAI HTML source reaches source-bound native receipt math", async () => {
  const captured = await captureOpenAiResponsesPricingDocument({ fetch, freshnessMs: 60_000, timeoutMs: 20_000 });
  const capturedRate = await createOpenAiResponsesRateSnapshot({ document: captured, model: "gpt-4.1-2025-04-14" });
  expect(capturedRate).toMatchObject({ sourceUrl: OPENAI_RESPONSES_PRICING_URL, inputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 500_000, outputMicrosPerMillion: 8_000_000 });
  const entries = new Map<string, unknown>();
  const journal: OpenAiResponsesOperationJournal = { async claim(entry) { const previous = entries.get(entry.operationId); if (previous) return { claimed: false, entry: previous }; entries.set(entry.operationId, structuredClone(entry)); return { claimed: true, entry }; }, async read(operationId) { return entries.get(operationId); }, async write(entry) { entries.set(entry.operationId, structuredClone(entry)); } };
  const native = new TextEncoder().encode(JSON.stringify({ id: "resp_source", model: capturedRate.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"files":[]}' }] }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } } }));
  const client = createOpenAiResponsesClient({ candidateSha256: hex("a"), credentialReference: "openai:api-key:production-reference", model: capturedRate.model, rate: capturedRate, maximumChargeMicros: 10_000_000, journal, port: { async create() { return { bytes: native }; }, async get() { return { bytes: native }; } } });
  const gateway = new OpenAiResponsesCandidateModelGateway(client);
  const result = await gateway.dispatch({ operationId: "operation:source-html", providerRequestId: "request:source-html", accountId: "account:fixture", sessionId: "session:fixture", actionId: "action:fixture", expectedVersion: 0, actionBudgetReference: "budget:fixture", profileId: "openai-responses-candidate", priceCardId: "openai-source-bound", requestFingerprint: hex("b"), prompt: "One focused counter", maximumUnits: [{ dimension: "input_tokens", units: "1000" }, { dimension: "output_tokens", units: "200" }], selection: "unselected" }, new AbortController().signal);
  expect(result).toMatchObject({ status: "completed", receipt: { model: "gpt-4.1-2025-04-14", usage: [{ dimension: "input_tokens", units: "100" }, { dimension: "cached_tokens", units: "20" }, { dimension: "output_tokens", units: "10" }, { dimension: "reasoning_tokens", units: "0" }] } });
}, 30_000);

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

test("a non-claiming journal collision cannot observe another immutable original", async () => {
  let calls = 0;
  const baseline = await rate();
  const client = createOpenAiResponsesClient({ candidateSha256: hex("a"), credentialReference: "openai:api-key:production-reference", model: baseline.model, rate: baseline, maximumChargeMicros: 10_000_000,
    journal: { async claim(entry) { return { claimed: false, entry: { ...entry, candidateSha256: hex("e") } }; }, async read() { calls++; throw new Error("GET_JOURNAL_MUST_NOT_RUN"); }, async write() { calls++; throw new Error("WRITE_JOURNAL_MUST_NOT_RUN"); } },
    port: { async create() { calls++; throw new Error("POST_MUST_NOT_RUN"); }, async get() { calls++; throw new Error("GET_MUST_NOT_RUN"); } }, now: () => now });
  expect(await client.dispatch({ operationId: "operation:collision", idea: "One focused counter", systemInstruction: "Return JSON only", maximumInputTokens: 1_000, maximumOutputTokens: 200 })).toMatchObject({ status: "unknown", reason: "receipt_invalid", originalOperationOnly: true });
  expect(calls).toBe(0);
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
