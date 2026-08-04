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

test("PostgreSQL-wire waits and serialization retries have a bounded deadline", async () => {
  const store = new PostgresSqlFundingStore({ connect: () => new Promise(() => undefined) }, { maxAttempts: 100, deadlineMs: 10 });
  const observed = await Promise.race([
    store.findRecordedResult("account:one", "command:one").then(() => "resolved", (error) => error instanceof Error ? error.message : "rejected"),
    Bun.sleep(50).then(() => "unbounded"),
  ]);
  expect(observed).toBe("POSTGRES_OPERATION_DEADLINE_EXCEEDED");
});

test("rail repositories expose narrow ports and leave SQL ownership to the database adapter", async () => {
  const lightning = await Bun.file("src/funding/lightning-top-up.ts").text();
  const cashu = await Bun.file("src/funding/cashu-top-up.ts").text();
  expect(`${lightning}\n${cashu}`).not.toContain("PostgresSqlPool");
  expect(lightning).not.toContain("class PostgresLightningTopUpRepository");
  expect(cashu).not.toContain("class PostgresCashuTopUpRepository");
  const database = await Bun.file("src/persistence/postgres-funding-database.ts").text();
  expect(database).toContain("class PostgresFundingDatabase");
  expect(database).toContain("ProtectedRailMaterialRepository");
});

test("durable protected material schema stores AES-GCM metadata rather than plaintext", async () => {
  const migration = await Bun.file("migrations/phase-03/001_funding.sql").text();
  expect(migration).toMatch(/protected_rail_material[\s\S]*account_id text NOT NULL/);
  expect(migration).toMatch(/protected_rail_material[\s\S]*nonce bytea NOT NULL/);
  expect(migration).toMatch(/protected_rail_material[\s\S]*payload_digest char\(64\) NOT NULL/);
  expect(migration).not.toMatch(/protected_rail_material[\s\S]*plaintext/);
});
