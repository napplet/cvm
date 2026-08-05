import { expect, test } from "bun:test";

test("Phase 05 migration keeps continuation identity, leases, claims, and expiry in one authority without a generation queue", async () => {
  const [migration, store] = await Promise.all([
    Bun.file("migrations/phase-05/001_continuation.sql").text(),
    Bun.file("src/persistence/postgres-sql-funding-store.ts").text(),
  ]);
  for (const table of ["continuation_pauses", "continuation_checkpoints", "continuation_resume_commands", "continuation_tombstones", "continuation_deletions"] as const) expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  for (const field of ["pause_generation", "live_lease_token", "object_generation", "object_checksum", "retention_deadline_ms", "allocation_intent_reference"] as const) expect(migration).toContain(field);
  expect(migration).toContain("intent_json jsonb NOT NULL");
  expect(migration).toContain("'needs_top_up'");
  expect(migration).toContain("attempt integer NOT NULL");
  expect(migration).toContain("'unknown'");
  expect(migration).not.toContain("continuation_deletions_append_only");
  expect(migration).toContain("2592000000");
  expect(migration).not.toMatch(/CREATE TABLE[^;]*(generation_queue|request_queue)/is);
  for (const method of ["pauseForFunding", "wakePausedAction", "beginDeadlineCheckpoint", "commitDeadlineCheckpoint", "claimResume", "tombstoneExpiredCheckpoint", "recordDeletionOutcome"] as const) expect(store).toContain(method);
  expect(store).toContain("PendingActionIntentSchema.parse");
  expect(store).toContain("INSERT INTO metered_sessions");
  expect(store).toContain("CONTINUATION_SESSION_IDENTITY_CONFLICT");
  expect(store).toContain("COALESCE(MAX(attempt),0)+1");
});
