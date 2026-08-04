---
phase: 04-metered-generation-revision-loop
reviewed: 2026-08-04T22:48:15Z
depth: standard
files_reviewed: 31
files_reviewed_list:
  - migrations/phase-04/001_metered_generation.sql
  - package.json
  - scripts/verify-phase-04-design-slice.ts
  - src/contextvm/adapter.ts
  - src/contextvm/announcement.ts
  - src/model/deterministic-model-gateway.ts
  - src/model/model-gateway.ts
  - src/model/price-card.ts
  - src/model/reconciliation.ts
  - src/persistence/funding-store.ts
  - src/persistence/postgres-funding-database.ts
  - src/persistence/postgres-funding-store.ts
  - src/persistence/postgres-sql-funding-store.ts
  - src/phase-03/funded-core.ts
  - src/phase-04/metered-generation-service.ts
  - src/phase-04/napplet-harness.ts
  - src/phase-04/repair-policy.ts
  - src/phase-04/session-status.ts
  - src/verification/phase-04-design-evidence.ts
  - tests/billing/line-items.test.ts
  - tests/billing/operation-finalization.test.ts
  - tests/billing/price-card.test.ts
  - tests/contextvm/adapter.test.ts
  - tests/evals/phase-04-reference-set.test.ts
  - tests/fixtures/phase-04-reference-set.json
  - tests/model/reconciliation.test.ts
  - tests/phase-04/artifact-outcome.test.ts
  - tests/phase-04/repair.test.ts
  - tests/phase-04/revision.test.ts
  - tests/phase-04/session-status.test.ts
  - tests/phase-04/tracer.test.ts
findings:
  critical: 3
  warning: 1
  info: 0
  total: 4
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-08-04T22:48:15Z
**Depth:** standard
**Files Reviewed:** 31
**Status:** issues_found

## Summary

The iteration fixes the earlier pre-dispatch ceiling, duplicate-dispatch, reservation-release, reconciliation-claim, cursor-secret, and SQL-column defects. However, the real PostgreSQL path cannot create its first metered action because its referenced pricing records are never seeded. Successful artifacts and revision lineage are still replaced with process-configured or synthesized placeholders, and durable replays retain fake zero balance/cap values. The focused Phase 04 suite passes (45 tests), but it does not exercise these production/restart contracts.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Production metered sessions reference profile/card rows that are never created

**Classification:** BLOCKER

**File:** `migrations/phase-04/001_metered_generation.sql:4-16`; `src/persistence/postgres-sql-funding-store.ts:179-181`

**Issue:** `metered_sessions`, `metered_actions`, and `provider_operations` have foreign keys to `model_profile_versions` and `price_card_versions`. The migration only creates those tables; neither it nor any reviewed application code inserts the pinned `code-proposal` profile or `phase-04-deterministic-card-2026-08-04` card. `prepareMeteredAction()` therefore fails at its first `INSERT INTO metered_sessions` in a freshly migrated production database, before any action can be dispatched. The passing finalization test uses the in-memory store and cannot expose this.

**Fix:** Add an idempotent, canonical seed/promotion step for the exact pinned profile and price-card JSON (with hashes), run it before accepting generation work, and add a PostgreSQL migration integration test for prepare → claim → finalization on an empty migrated database.

### CR-02: Finalization discards the verifier-issued artifact and session-bound workspace/snapshot lineage

**Classification:** BLOCKER

**File:** `src/phase-04/metered-generation-service.ts:52,195-204,211`; `src/persistence/postgres-sql-funding-store.ts:233-234`; `src/phase-04/session-status.ts:156`

**Issue:** The harness returns the server-verifier's actual `artifactId` at `src/phase-04/napplet-harness.ts:88`, but the generation service reduces that to a boolean and finalizes only an incremented artifact version. It obtains `snapshotReference` and `priorArtifactId` from service-wide constructor configuration, not durable session state. SQL then writes a fabricated artifact ID (`artifact:${actionId}`) and fabricated lineage (`workspace:${sessionId}`), while status fabricates a different ID (`artifact:${sessionId}:${version}`). There is no persisted checkpoint/snapshot reference or verifier identity that a restart, revision, repair, or failed-artifact-retention decision can validate. Thus separate sessions can be supplied the same configured prior artifact/snapshot, and a displayed/persisted successful artifact need not be the verified artifact.

**Fix:** Extend the metered-session/action finalization contract to carry the verifier-issued artifact ID plus immutable validation evidence and the actual session-owned workspace/checkpoint lineage. Persist those values atomically with the debit/version update; load them for revision/repair; return the stored artifact identity from status. Make repair derive and validate failed-artifact/report references from the same durable records. Add production-backed restart and two-session isolation tests.

### CR-03: Stored terminal results retain placeholder cap and balance values, so replay lies after a restart

**Classification:** BLOCKER

**File:** `src/phase-04/metered-generation-service.ts:208-212`; `src/persistence/postgres-sql-funding-store.ts:223-236`; `src/model/reconciliation.ts:74-92`

**Issue:** The service persists `SessionActionResult` with `remainingCap: "0"` and `remainingBalance: "0"`. `finalizeMeteredAction()` calculates the real values, but only returns them on its transient return object; it serializes the original placeholder result into `terminal_result`. The initial response patches its local result from that return value, while an idempotent retry after the process map is lost reads and returns the durable zero values at `startSession()`/`reviseSession()` lines 61-63 and 82-84. Reconciliation persists the same placeholders and does not patch its returned result. This makes the durable receipt/cap result inconsistent with the actual hold and account projection.

**Fix:** Construct the canonical terminal response inside the serializable finalization transaction after `nextCap` and `nextBalance` are known, persist exactly that result, and return the same object for first response, replay, and reconciliation. Add restart/replay tests for completed, failed, and receipt-found reconciliation actions that compare all spend/cap/balance fields.

## Warnings

### WR-01: Design evidence marks self-declared effects as passed without observing them

**Classification:** WARNING

**File:** `scripts/verify-phase-04-design-slice.ts:26-39`; `tests/evals/phase-04-reference-set.test.ts:79-83`

**Issue:** Each referenced test is executed only for an exit code. The verifier then copies `caseResults: passed` and sums effect counts from the fixture itself. No test emits runtime dispatch, receipt, debit, or release observations for comparison to those fixture counts, so a passing test with weakened/missing assertions can still produce a design-ready evidence record claiming the original effects.

**Fix:** Have every reference case expose structured effects from its actual store/gateway/worker double, parse those results in the evaluator, and compare every observed field against the fixture before setting the case or aggregate evidence to passed.

---

_Reviewed: 2026-08-04T22:48:15Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
