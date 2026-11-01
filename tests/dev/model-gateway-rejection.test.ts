import { expect, test } from "bun:test";
import { DevelopmentModelGateway } from "../../src/dev/development-model-gateway";
import type { SourceProposalStore } from "../../src/dev/source-proposal-store";
import { ProviderOperationIntentSchema } from "../../src/model/model-gateway";

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const now = Date.now();
const source = (url: string, bytes: string) => ({ url, capturedBytesSha256: sha(bytes), observedAt: new Date(now - 60_000).toISOString(), effectiveAt: new Date(now - 60_000).toISOString(), freshUntil: new Date(now + 3_600_000).toISOString() });
const priceCard = { id: "card-test", version: "card-test", kind: "source_attributed_provider", provider: "openai_responses", currency: "sat", rounding: "ceil", supportedDimensions: ["input_tokens", "output_tokens"],
  rates: { input_tokens: { numerator: "1", denominator: "1000" }, output_tokens: { numerator: "1", denominator: "100" }, cached_tokens: { numerator: "1", denominator: "1000" }, reasoning_tokens: { numerator: "1", denominator: "100" } },
  ceilings: { inputTokens: "128000", outputTokens: "24000" }, validity: { notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 3_600_000).toISOString() },
  sources: { provider: source("https://prices.example/openai", "price-bytes"), conversion: source("https://prices.example/btc", "btc-bytes") } };
const profile = { id: "profile-test", provider: "openai_responses", model: "gpt-5-mini", priceCardId: "card-test", selection: "unselected", maximumUnits: [{ dimension: "input_tokens", units: "128000" }, { dimension: "output_tokens", units: "24000" }], deadlineMs: 30_000 };
const configured = { apiKey: "test-only", model: "gpt-5-mini", profile, priceCard, priceSources: { provider: { url: "https://prices.example/openai", capturedBytes: "price-bytes", sha256: sha("price-bytes") }, conversion: { url: "https://prices.example/btc", capturedBytes: "btc-bytes", sha256: sha("btc-bytes") } } };
const store = { lookupProviderObservation: async () => undefined, lookupUsageEvidence: async () => undefined } as unknown as SourceProposalStore;
const intent = ProviderOperationIntentSchema.parse({ operationId: "operation:test", providerRequestId: "operation:test", accountId: "account:test", sessionId: "session:test", actionId: "start:test", expectedVersion: 0, actionBudgetReference: "budget:test", profileId: "profile-test", priceCardId: "card-test", requestFingerprint: "a".repeat(64), prompt: "A tally counter.", maximumUnits: [{ dimension: "input_tokens", units: "128000" }, { dimension: "output_tokens", units: "24000" }], selection: "unselected" });

const respond = (status: number) => (async () => new Response(JSON.stringify({ error: { type: "insufficient_quota" } }), { status })) as unknown as typeof fetch;

test("an explicit OpenAI refusal is a definitive non-acceptance, not an uncertain billable outcome", async () => {
  for (const status of [400, 401, 429]) {
    const result = await new DevelopmentModelGateway({ store, configured, fetch: respond(status) }).dispatch(intent, new AbortController().signal);
    expect(result.status).toBe("definitive_not_accepted");
  }
});

test("server errors and transport failures stay uncertain and must reconcile before retry", async () => {
  for (const fetcher of [respond(500), respond(503), (async () => { throw new TypeError("network"); }) as unknown as typeof fetch]) {
    const result = await new DevelopmentModelGateway({ store, configured, fetch: fetcher }).dispatch(intent, new AbortController().signal);
    expect(result.status).toBe("usage_unknown");
  }
});
