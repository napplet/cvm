import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CvmOperator } from "../../src/dev/cvm-operator";
import { chatGptDevelopmentPricing } from "../../src/dev/chatgpt-model-gateway";

test("operator authority, secret projection, replay, busy guard and private restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cvm-admin-unit-"));
  let receiptChecks = 0;
  let queries = 0; let busy = false; let fail = false;
  const pricing = chatGptDevelopmentPricing("fixture-account", "fixture-model");
  const options = { checkReceipt: async () => { receiptChecks++; return { outcome: "missing" }; }, pool: { query: async () => { queries++; return { rows: [] }; } }, busy: () => busy, pricing: () => pricing,
    configure: async () => { if (fail) throw new Error("provider failed with private-api-key"); }, chatgpt: async () => ({ accounts: ["private-account"] }) };
  try {
    const operator = await CvmOperator.open(directory, options);
    let quoteCalls = 0;
    operator.exchangeRates.read = async () => { quoteCalls++; return { status: "unavailable" }; };
    for (const action of ["status", "exchange_rate", "jobs", "job", "check_receipt", "chatgpt", "add_api"]) expect(await operator.handle({ action }, "f".repeat(64))).toEqual({ status: "denied", code: "OPERATOR_REQUIRED" });
    expect(quoteCalls).toBe(0);
    busy = true;
    expect(await operator.handle({ action: "exchange_rate" }, operator.pubkey)).toEqual({ status: "ok", exchangeRate: { status: "unavailable" } });
    expect(quoteCalls).toBe(1); busy = false;
    expect(queries).toBe(0); expect(receiptChecks).toBe(0);
    expect(await operator.handle({ action: "check_receipt", id: "some-job" }, operator.pubkey)).toEqual({ status: "ok", recovery: { outcome: "missing" } });
    expect(receiptChecks).toBe(1);
    expect(await operator.handle({ action: "jobs" }, operator.pubkey)).toMatchObject({ status: "ok", jobs: [] });
    const rates = structuredClone(pricing.card.rates); rates.input_tokens.denominator = "2000";
    busy = true;
    expect(await operator.handle({ action: "save_rates", rates }, operator.pubkey)).toEqual({ status: "rejected", code: "CONFIGURATION_BUSY" });
    expect(operator.rates()).toBeUndefined(); busy = false;
    expect(await operator.handle({ action: "save_rates", rates }, operator.pubkey)).toEqual({ status: "ok" });
    fail = true;
    expect(JSON.stringify(await operator.handle({ action: "save_rates", rates: pricing.card.rates }, operator.pubkey))).not.toContain("private-api-key");
    expect(operator.rates()?.input_tokens.denominator).toBe("2000"); fail = false;
    const source = "fixture captured pricing";
    const sha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex");
    const provenance = { url: "https://example.test/fixture-price", capturedBytesSha256: sha256, observedAt: "2026-01-01T00:00:00.000Z", effectiveAt: "2026-01-01T00:00:00.000Z", freshUntil: "2030-01-01T00:00:00.000Z" };
    const account = { id: crypto.randomUUID(), label: "Test API", apiKey: "private-api-key", model: "gpt-5-mini",
      profile: { ...pricing.profile, id: "api-fixture", provider: "openai_responses", model: "gpt-5-mini", priceCardId: "api-fixture-card" },
      priceCard: { ...pricing.card, id: "api-fixture-card", kind: "source_attributed_provider", provider: "openai_responses", sources: { provider: provenance, conversion: provenance } },
      priceSources: { provider: { url: provenance.url, capturedBytes: source, sha256 }, conversion: { url: provenance.url, capturedBytes: source, sha256 } },
    };
    expect(await operator.handle({ action: "add_api", account }, operator.pubkey)).toEqual({ status: "ok" });
    expect(await operator.handle({ action: "add_api", account }, operator.pubkey)).toEqual({ status: "ok" });
    const status: any = await operator.handle({ action: "status" }, operator.pubkey);
    expect(status.apiAccounts).toHaveLength(1); expect(status.apiAccounts[0].keyConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(account.apiKey);
    expect(await operator.handle({ action: "select_api", id: account.id }, operator.pubkey)).toEqual({ status: "ok" });
    expect(operator.selectedApi()?.apiKey).toBe(account.apiKey);
    const restored = await CvmOperator.open(directory, options);
    expect(restored.pubkey).toBe(operator.pubkey); expect(restored.selectedApi()?.id).toBe(account.id);
    expect(restored.rates()?.input_tokens.denominator).toBe("2000");
    expect((await stat(join(directory, "operator.json"))).mode & 0o077).toBe(0);
    expect((await readFile(join(directory, "operator.json"), "utf8"))).toContain(account.apiKey);
    await restored.clearApiSelection();
    expect(await restored.handle({ action: "remove_api", id: account.id }, restored.pubkey)).toEqual({ status: "ok" });
    expect(await readFile(join(directory, "operator.json"), "utf8")).not.toContain(account.apiKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
