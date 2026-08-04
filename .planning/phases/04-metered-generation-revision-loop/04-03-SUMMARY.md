---
phase: 04-metered-generation-revision-loop
plan: 03
subsystem: metered-generation-reconciliation
tags: [billing, reconciliation, model-gateway, exact-once, zod]
dependency_graph:
  requires: [04-02]
  provides: [deterministic-model-gateway, usage-unknown-fence, original-operation-reconciliation]
  affects: [metered-generation-service, metered-funding-store, phase-04-session-status]
tech_stack:
  added: []
  patterns: [strict-normalized-receipts, protected-evidence-references, lookup-only-reconciliation, serialized-reconciliation-claims]
key_files:
  created: [src/model/deterministic-model-gateway.ts, src/model/reconciliation.ts, tests/model/reconciliation.test.ts]
  modified: [src/model/model-gateway.ts, src/phase-04/metered-generation-service.ts, src/persistence/funding-store.ts, src/persistence/postgres-funding-store.ts, src/persistence/postgres-sql-funding-store.ts]
decisions:
  - "Ambiguous dispatches persist usage_unknown and retain their original provider operation instead of being retried."
  - "A late authoritative receipt finalizes as a charged failed action when artifact completion is unknown; a definitive non-acceptance settles zero usage."
metrics:
  duration: 8m 21s
  completed_date: 2026-08-04
status: complete
---

# Phase 04 Plan 03: Original-Operation Reconciliation Summary

The metered loop now records deterministic provider ambiguity durably and resolves it only by looking up the original billable operation, preserving exact-once settlement and protected evidence boundaries.

## Completed Tasks

1. Defined strict dispatch/lookup observations and added the deterministic fixture gateway with protected evidence digests, correlation IDs, fault scenarios, and separate invocation counters.
2. Added `usage_unknown` persistence, serialized reconciliation claims, lookup-only finalization, and service-side handling for ambiguous and definitive zero-use dispatch outcomes.

## Verification

- `bun test tests/model/reconciliation.test.ts --test-name-pattern='gateway' --timeout 10000` — passed (4 tests).
- `bun test tests/model/reconciliation.test.ts tests/billing/operation-finalization.test.ts --timeout 10000` — passed.
- `bun test tests/model/reconciliation.test.ts tests/billing/operation-finalization.test.ts tests/phase-04/tracer.test.ts --timeout 10000` — passed (9 tests).
- `bun test tests/persistence/postgres-funding-store.test.ts tests/persistence/postgres-sql-funding-store.test.ts --timeout 10000` — passed (12 tests).
- `git diff --check` — passed.
- Targeted TypeScript check found no new Phase 04/model errors; the pre-existing missing `pg` declaration remains outside this plan's scope.
- Stub-pattern scan over all plan files — no stubs found.

## Commits

- `e50199b` — RED: failing gateway ambiguity tests.
- `dacbecb` — GREEN: deterministic model gateway.
- `5c648e2` — RED: failing reconciliation contracts.
- `c742dba` — GREEN: lookup-only reconciliation and session ambiguity fence.
- `3c70d2c` — Refined the late-receipt truth assertion to retain the failed action state.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical persistence] Added reconciliation storage primitives missing from the Plan 02 interface**
- **Found during:** Task 2
- **Issue:** The planned reconciliation claim, durable `usage_unknown` record, and operation lookup were not exposed by the metered funding store.
- **Fix:** Extended memory, deterministic PostgreSQL, and PostgreSQL-wire store implementations with owner-scoped operation lookup, ambiguity persistence, and one reconciliation claim.
- **Files modified:** `src/persistence/funding-store.ts`, `src/persistence/postgres-funding-store.ts`, `src/persistence/postgres-sql-funding-store.ts`
- **Verification:** Reconciliation, persistence, and exact-finalization suites pass.
- **Commit:** `c742dba`

**2. [Rule 1 - Compatibility] Preserved existing receipt provenance while requiring fixture digest evidence**
- **Found during:** Task 2 integration
- **Issue:** The expanded provenance schema rejected the established Phase 04 tracer's reference-only normalized receipt before any receipt pricing could occur.
- **Fix:** Kept the digest mandatory for deterministic fixture emissions while allowing legacy normalized receipt producers to supply the already-required protected reference.
- **Files modified:** `src/model/model-gateway.ts`, `src/model/deterministic-model-gateway.ts`
- **Verification:** Gateway and funded-start tracer suites pass.
- **Commit:** `c742dba`

**Total deviations:** 2 auto-fixed (1 missing critical persistence, 1 compatibility bug).

## Self-Check: PASSED

- Required gateway, reconciliation service, metered-generation service, and reconciliation tests exist.
- All five plan commits exist in git history.
