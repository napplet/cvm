import { expect, test } from "bun:test";
import { summarizeGenerationEstimates, readGenerationEstimates } from "../../src/dev/generation-estimates";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { ServiceInfoArgumentsSchema } from "../../src/dev-ui/extension-schemas";
import { GenerationEstimatesSchema } from "../../src/dev-ui/generation-estimates-contract";

const sample = (cost: string, seconds: number, version = 0) => ({ receipt_charge: cost, seconds, expected_session_version: version });
test("empty and invalid history do not invent estimates", () => {
  expect(summarizeGenerationEstimates([], "1000")).toEqual({ unit: "test_sat", windowDays: 30, create: null, revise: null });
  expect(summarizeGenerationEstimates([sample("2000", 1), sample("100", -1), sample("100", Infinity), sample("100", 3601), sample("bad", 10)], "1000").create).toBeNull();
});
test("ranges distinguish creation/revision, pad history and respect the ceiling", () => {
  const result = summarizeGenerationEstimates([sample("800", 100), sample("600", 60), sample("200", 30, 1)], "900");
  expect(result.create).toEqual({ samples: 2, basis: "create", cost: { low: "450", high: "900" }, seconds: { low: 45, high: 125 } });
  expect(result.revise).toEqual({ samples: 1, basis: "revise", cost: { low: "150", high: "250" }, seconds: { low: 20, high: 40 } });
});
test("fallback is labeled, history is bounded and money stays exact above Number.MAX_SAFE_INTEGER", () => {
  const result = summarizeGenerationEstimates([sample("9007199254740993", 1)], "9999999999999999");
  expect(result.revise?.basis).toBe("all");
  expect(result.create?.cost).toEqual({ low: "6755399441055744", high: "9999999999999999" });
  expect(result.create?.seconds).toEqual({ low: 5, high: 10 });
  expect(summarizeGenerationEstimates(Array(60).fill(sample("0", 20)), "100").create?.samples).toBe(30);
});
test("CVM history is scoped to verified identity and current pricing; owner spoofing is rejected", async () => {
  const calls: unknown[][] = [];
  const pool: any = { query: async (sql: string, values: unknown[]) => { calls.push([sql, values]); return { rows: [] }; } };
  await readGenerationEstimates(pool, "a".repeat(64), { profile: { id: "profile" }, card: { id: "card" } }, "1000");
  expect(calls[0]![1]).toEqual([await accountIdForPrincipal({ pubkey: "a".repeat(64) }), "profile", "card"]);
  const sql = String(calls[0]![0]);
  for (const predicate of ["a.account_id=$1", "a.profile_id=$2", "a.price_card_id=$3", "a.state='verified'", "interval '30 days'", "provider_reconciliations", "LIMIT 60"]) expect(sql).toContain(predicate);
  await expect(readGenerationEstimates(pool, "unverified", { profile: { id: "profile" }, card: { id: "card" } }, "1000")).rejects.toThrow();
  expect(calls).toHaveLength(1);
  for (const input of [{ pubkey: "b".repeat(64) }, { accountId: "other" }, { owner: "other" }]) expect(ServiceInfoArgumentsSchema.safeParse(input).success).toBe(false);
});
test("browser contract rejects malformed ranges and unintended private fields", () => {
  const value = summarizeGenerationEstimates([sample("100", 20)], "1000");
  expect(GenerationEstimatesSchema.safeParse({ ...value, account: "private" }).success).toBe(false);
  expect(GenerationEstimatesSchema.safeParse({ ...value, create: { ...value.create, cost: { low: "200", high: "100" } } }).success).toBe(false);
});
