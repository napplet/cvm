import { expect, test } from "bun:test";
import { chatGptDevelopmentPricing } from "../../src/dev/chatgpt-model-gateway";
import { extractStandardPrices, satsPerToken, syncDevelopmentRates } from "../../src/dev/openai-price-sync";

const markdown = `# Pricing
### Standard pricing data
| Model | Short context input | Short context output | Long context input |
| --- | --- | --- | --- |
| gpt-6.1-sol | $2.00 | $10.00 | $4.00 |
| gpt-6.1-sol-mini | $0.25 | $2.00 | $0.50 |
| gpt-6-luna | $0.10 | $0.50 | $0.20 |

### Batch pricing data
| Model | Short context input | Short context output |
| --- | --- | --- |
| gpt-6.1-sol | $1.00 | $5.00 |
`;

test("strictly extracts exact Standard short-context model prices", () => {
  expect(extractStandardPrices(markdown, "gpt-6.1-sol")).toEqual({ inputUsdPerMillion: "2.00", outputUsdPerMillion: "10.00" });
  expect(() => extractStandardPrices(markdown, "gpt-6.1")).toThrow("MODEL_PRICE_NOT_LISTED");
  expect(() => extractStandardPrices(markdown.replace("$2.00", "—"), "gpt-6.1-sol")).toThrow("MODEL_PRICE_UNAVAILABLE");
  expect(() => extractStandardPrices(markdown.replace("### Standard pricing data", "### Other"), "gpt-6.1-sol")).toThrow("STANDARD_PRICING_TABLE_MISSING");
  expect(() => extractStandardPrices(markdown.replace("| gpt-6.1-sol-mini", "| gpt-6.1-sol"), "gpt-6.1-sol")).toThrow("MODEL_PRICE_AMBIGUOUS");
});

test("converts dollars per million tokens into exact rational sats per token", () => {
  expect(satsPerToken("2.00", "80000")).toEqual({ numerator: "1", denominator: "400" });
  expect(satsPerToken("0.25", "81250.50")).toEqual({ numerator: "50", denominator: "162501" });
  expect(() => satsPerToken("0", "80000")).toThrow("PRICE_DECIMAL_INVALID");
});

function fixture() {
  let pricing = chatGptDevelopmentPricing("fixture-account", "gpt-6.1-sol");
  let modelRates: Record<string, any> = {};
  let models = ["gpt-6.1-sol", "gpt-6-luna"];
  let saves = 0;
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  const client = { callTool: async (_tool: "cvm_admin", args: Record<string, unknown>) => {
    if (args.action === "status") return { status: "ok", pricing, modelRates };
    if (args.action === "chatgpt" && args.operation === "status") return { accounts: [{ id: "fixture-account", signedIn: true, planEnabled: true }] };
    if (args.action === "chatgpt" && args.operation === "models") return { models: models.map(slug => ({ slug })) };
    if (args.action === "exchange_rate") return { status: "ok", exchangeRate: { status: "fresh", quote: { source: "Kraken", usdPerBtc: "80000", fetchedAt: now } } };
    if (args.action === "save_model_rates") { saves++; modelRates = { ...modelRates, ...args.modelRates as object }; pricing = chatGptDevelopmentPricing("fixture-account", "gpt-6.1-sol", modelRates["gpt-6.1-sol"]); return { status: "ok" }; }
    throw new Error("unexpected admin call");
  } };
  const fetcher = (async () => new Response(markdown, { headers: { "content-type": "text/markdown" } })) as unknown as typeof fetch;
  return { client, fetcher, now: () => now, get saves() { return saves; }, get modelRates() { return modelRates; }, setModels(next: string[]) { models = next; } };
}

test("dry run makes no change; apply saves once and subsequent sync is idempotent", async () => {
  const state = fixture();
  const options = { fetcher: state.fetcher, now: state.now };
  const preview = await syncDevelopmentRates(state.client, { ...options, dryRun: true });
  expect(preview.result).toBe("dry_run"); expect(preview.modelCount).toBe(2); expect(state.saves).toBe(0);
  const applied = await syncDevelopmentRates(state.client, options);
  expect(applied.result).toBe("updated"); expect(state.saves).toBe(1);
  expect(applied.models.find(item => item.model === "gpt-6.1-sol")?.input.testSatsPerThousandTokens).toBe("2.5");
  expect(applied.models.find(item => item.model === "gpt-6-luna")?.output.testSatsPerThousandTokens).toBe("0.625");
  expect(state.modelRates["gpt-6-luna"].input_tokens).not.toEqual(state.modelRates["gpt-6.1-sol"].input_tokens);
  expect((await syncDevelopmentRates(state.client, options)).result).toBe("unchanged");
  expect(state.saves).toBe(1);
});

test("missing catalog price, stale quote and malformed table leave every model unchanged", async () => {
  const state = fixture(); const options = { fetcher: state.fetcher, now: state.now };
  await expect(syncDevelopmentRates(state.client, { ...options, now: () => state.now() + 6 * 60_000 })).rejects.toThrow("FRESH_BTC_USD_QUOTE_REQUIRED");
  await expect(syncDevelopmentRates(state.client, { ...options, fetcher: (async () => new Response("missing", { headers: { "content-type": "text/markdown" } })) as unknown as typeof fetch })).rejects.toThrow("STANDARD_PRICING_TABLE_MISSING");
  state.setModels(["gpt-6.1-sol", "unpriced-model"]);
  await expect(syncDevelopmentRates(state.client, options)).rejects.toThrow("MODEL_PRICE_NOT_LISTED");
  expect(state.saves).toBe(0);
});
