---
phase: 05-funding-interruption-durable-resume
plan: 06
subsystem: continuity
tags: [retention, expiry, tombstone, checkpoint, postgres, status]
requires:
  - phase: 05-02
    provides: durable checkpoint claim, tombstone, and deletion transitions
  - phase: 05-03
    provides: per-checkpoint envelope key and exact object-generation ports
  - phase: 05-05
    provides: explicit signed resume and restore authority
provides:
  - exact 30-day, server-clock tombstone and deletion reconciliation
  - tombstone-first exact key/object cleanup with coarse durable audit
  - owner-safe terminal expired continuation status with no action surface
affects: [05-07, continuation, checkpoint-retention, contextvm]
tech-stack:
  added: []
  patterns: [tombstone-before-delete, exact-generation-cleanup, terminal-status-projection]
key-files:
  created: [tests/phase-05/retention-expiry.test.ts]
  modified: [src/continuity/checkpoint-envelope.ts, src/continuity/deadline-reconciler.ts, src/continuity/continuation-service.ts, src/continuity/contracts.ts, src/phase-04/session-status.ts, src/persistence/funding-store.ts, src/persistence/postgres-sql-funding-store.ts]
key-decisions:
  - "Retention expiry is a server-owned nowMs >= checkpointCommittedAtMs + 2592000000 comparison; a pre-expiry claim wins only its existing fenced restore transition."
  - "The committed tombstone and scheduled deletion audit always precede per-checkpoint key destruction and exact object-generation scheduling."
  - "Expired status exposes only a safe checkpoint reference, immutable retention deadline, and coarse deletion state; it never exposes a resume or top-up action."
metrics:
  duration: 7 min
  completed: 2026-08-05
status: complete
---

# Phase 05 Plan 06: Retention Expiry Summary

**Checkpoint retention now expires exactly after thirty server-owned days, with a terminal tombstone that safely coordinates immutable key/object cleanup and cannot be resurrected.**

## Performance

- **Duration:** 7 min
- **Tasks:** 2/2
- **Files modified:** 8

## Accomplishments

- Added injected-clock retention scanning that elects a terminal tombstone before destroying the committed checkpoint key or scheduling deletion of its exact object generation.
- Added concurrent-reaper coalescing, retryable unknown deletion observation, and durable coarse audit state without targeting mutable or successor objects.
- Moved the explicit resume claim ahead of budget reservation, so terminal expiry rejects late commands before any budget, allocation, or restore effect.
- Added a strict owner-safe `expired` continuation projection with no protected storage metadata and no possible resume/top-up next action.

## Task Commits

1. **Task 1: Tombstone at the exact retention deadline before key/object deletion** — `be3d01c` (RED), `91e0a1c` (GREEN), `771d13a` (type-safe correction)
2. **Task 2: Expose terminal expired status without a resurrection path** — `a85ef7c` (RED), `87ed79f` (GREEN)

## Verification

- `bun test tests/phase-05/retention-expiry.test.ts tests/phase-05/continuation-status.test.ts tests/persistence/continuation-store.test.ts --timeout 10000` — passed (9 tests).
- `bun test --timeout 10000` — passed (344 tests, 0 failures).
- Targeted TypeScript scan found no diagnostics in Plan 05-06 source files. The repository-wide `bunx tsc --noEmit` still reports pre-existing errors outside this plan's scope (notably Bun ambient-type and older BufferSource typing errors).

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 2 - Missing critical functionality] Added durable checkpoint/deletion reads and exact envelope deletion forwarding.**
   - **Found during:** Task 1 implementation.
   - **Issue:** The existing transition authority could tombstone records but did not expose a durable owner-scoped terminal checkpoint/deletion audit projection or an envelope-level exact deletion operation.
   - **Fix:** Added exact-generation/key forwarding, coarse deletion outcome reads, and PostgreSQL outcome reconciliation while keeping protected storage details inside the persistence/envelope boundary.
   - **Files modified:** `src/continuity/checkpoint-envelope.ts`, `src/persistence/funding-store.ts`, `src/persistence/postgres-sql-funding-store.ts`.

2. **[Rule 1 - Bug] Claimed terminal authority before reserving a resume budget.**
   - **Found during:** Task 2 implementation.
   - **Issue:** A resume command attempted its action-budget reservation before the claim transition could reject an expired checkpoint.
   - **Fix:** Preserved affordability checks but moved `claimResume` before `reserveActionBudget` in the one serialized transaction.
   - **Files modified:** `src/continuity/continuation-service.ts`.

**Total deviations:** 2 auto-fixed (Rule 1 and Rule 2).

## Known Stubs

None.

## Self-Check: PASSED

- All declared production and test artifacts exist on disk.
- Task commits `be3d01c`, `91e0a1c`, `a85ef7c`, `87ed79f`, and `771d13a` exist in git history.
- The final full test suite passed with 344 tests and 0 failures.
