import { expect, test } from "bun:test";

test("Phase 04 migration declares every finalized action field queried by the SQL store", async () => {
  const [migration, store] = await Promise.all([
    Bun.file("migrations/phase-04/001_metered_generation.sql").text(),
    Bun.file("src/persistence/postgres-sql-funding-store.ts").text(),
  ]);
  for (const column of ["admission_reference", "receipt_charge", "provider_receipt_reference", "session_version", "artifact_version", "remaining_cap_sat", "remaining_balance_sat"] as const) {
    expect(store).toContain(column);
    expect(migration).toMatch(new RegExp(`(?:CREATE TABLE[^;]*metered_actions[^;]*\\b${column}\\b|ALTER TABLE metered_actions ADD COLUMN IF NOT EXISTS ${column}\\b)`, "s"));
  }
});
