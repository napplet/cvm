import { expect, test } from "bun:test";
import { PostgresSqlFundingStore, type PostgresSqlClient } from "../../src/persistence/postgres-sql-funding-store";
import { SerializationFailure } from "../../src/persistence/postgres-funding-store";

class ScriptedClient implements PostgresSqlClient {
  readonly sql: string[] = []; released = 0;
  async query(text: string): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.sql.push(text);
    if (text.startsWith("SELECT fingerprint_sha256")) return { rows: [{ fingerprint_sha256: "f".repeat(64), result_json: { status: "credited", accountId: "account:one", topUpId: "topup:one", creditedAmount: "21", unit: "sat", settlementReference: "settlement:one" } }] };
    return { rows: [] };
  }
  release(): void { this.released += 1; }
}

test("PostgresSqlFundingStore issues real serializable SQL transaction protocol and maps SQLSTATE 40001", async () => {
  const client = new ScriptedClient();
  const store = new PostgresSqlFundingStore({ connect: async () => client }, { maxAttempts: 2 });
  expect(await store.findRecordedResult("account:one", "command:one")).toMatchObject({ result: { status: "credited", creditedAmount: "21" } });
  await expect(store.transact("account:one", async () => { throw Object.assign(new Error("serialization"), { code: "40001" }); })).rejects.toBeInstanceOf(SerializationFailure);
  expect(client.sql.filter((sql) => sql === "BEGIN ISOLATION LEVEL SERIALIZABLE")).toHaveLength(2);
  expect(client.sql.filter((sql) => sql === "ROLLBACK")).toHaveLength(2);
  expect(client.released).toBe(3);
});
