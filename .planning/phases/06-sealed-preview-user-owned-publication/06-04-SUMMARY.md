---
phase: 06-sealed-preview-user-owned-publication
plan: "04"
subsystem: database
tags: [publication, sqlite, postgresql, idempotency, reconciliation]
requires:
  - phase: 06-03
    provides: canonical publication intents and verified owner-manifest identities
provides:
  - Durable replay-safe publication command and effect state
  - SQLite restart-safe publication persistence
  - PostgreSQL serializable publication SQL contract
affects: [06-05, publication-service, reconciliation]
tech-stack:
  added: []
  patterns: [persist-before-effect child claims, immutable terminal observations, original-operation reconciliation]
key-files:
  created: [migrations/phase-06/001_publication.sql, src/persistence/sqlite-publication-store.ts, tests/phase-06/publication-store-parity.test.ts]
  modified: [src/persistence/publication-store.ts, src/persistence/funding-store.ts, src/persistence/postgres-sql-funding-store.ts]
key-decisions:
  - "Publication effects use one stable operation identity per intent and effect kind."
  - "Unknown observations remain reconciliation-pending and can never satisfy completion."
  - "Publication persistence composes with the funding authority without mutating monetary line items."
patterns-established:
  - "Claim a child effect in its durable authority before external I/O."
  - "Use immutable terminal observations and lookup-only original operation identities."
requirements-completed: [PUB-01, PUB-05]
coverage:
  - id: D1
    description: Durable replay, single-claim, immutable-observation, and restart behavior for memory and SQLite publication stores.
    requirement: PUB-01
    verification:
      - kind: unit
        ref: tests/phase-06/publication-store-parity.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: PostgreSQL serializable transaction, uniqueness, retry, and original-operation observation contract.
    requirement: PUB-05
    verification:
      - kind: unit
        ref: tests/phase-06/publication-store-parity.test.ts
        status: pass
      - kind: unit
        ref: tests/persistence/postgres-sql-funding-store.test.ts
        status: pass
    human_judgment: false
duration: 9 min
completed: 2026-08-05
status: complete
---

# Phase 06 Plan 04: Durable Publication State Summary

**Publication commands, child effect claims, and immutable observations now survive replay, concurrency, and SQLite restart without authorizing duplicate external effects.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-08-05T09:02:44Z
- **Completed:** 2026-08-05T09:11:32Z
- **Tasks:** 2/2
- **Files modified:** 6

## Accomplishments

- Added Phase 6 schema tables, identity/uniqueness checks, and terminal-observation immutability protection.
- Implemented deep-immutable memory and SQLite publication authorities with exact replay, compare-and-set effect claims, and restart-safe status reads.
- Composed the PostgreSQL-style publication contract with serializable transactions, bounded 40001/40P01 retries, and original-operation observation predicates.

## Task Commits

1. **Task 1: Persist intent, child effects, observations, and linked result in memory and SQLite** - `2bfda77` (test), `6c420a8` (feat)
2. **Task 2: Add PostgreSQL-style serializable publication parity** - `5123f58` (test), `f235c8c` (feat)

## Files Created/Modified

- `migrations/phase-06/001_publication.sql` - PostgreSQL publication command, intent, effect, and linked-record schema.
- `src/persistence/publication-store.ts` - Normalized durable state machine and transactional memory authority.
- `src/persistence/sqlite-publication-store.ts` - WAL-backed immediate-transaction implementation.
- `src/persistence/funding-store.ts` - Publication persistence composition without ledger mutation APIs.
- `src/persistence/postgres-sql-funding-store.ts` - Serializable publication SQL methods with bounded retry/deadline behavior.
- `tests/phase-06/publication-store-parity.test.ts` - Memory/SQLite behavior and PostgreSQL SQL-contract coverage.

## Decisions Made

- Persisted effect state uses `created`, `dispatching`, `unknown`, and immutable observed terminal states so ambiguous work stays pending for original-operation reconciliation.
- Completion requires all deploy, owner-manifest, and attestation observations to be complete; partial or unknown state cannot become terminal success.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Kept the Phase 6 migration aligned with PostgreSQL persistence inserts.**
- **Found during:** Task 2
- **Issue:** The initial migration lacked the `record_json` column used by durable intent replay reads.
- **Fix:** Added a JSON-object-constrained `record_json` column to `publication_intents`.
- **Files modified:** `migrations/phase-06/001_publication.sql`
- **Verification:** Phase 6 parity and PostgreSQL SQL-contract tests pass.
- **Committed in:** `f235c8c`

**Total deviations:** 1 auto-fixed (Rule 1)

## Issues Encountered

- `bunx tsc --noEmit` reports pre-existing repository-wide Bun typing and unrelated source errors; targeted Bun test suites passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 06-05 can dispatch only the durable claimed operations and reconcile ambiguous results by their stored original identities.

## Self-Check: PASSED

- Verified durable store files and Phase 6 migration exist.
- Verified all four task commits are present in git history.
