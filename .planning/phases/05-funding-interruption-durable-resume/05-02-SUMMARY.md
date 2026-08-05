---
phase: 05-funding-interruption-durable-resume
plan: 02
subsystem: payments
tags: [continuity, postgres, serializable, checkpoint, resume, expiry]
requires:
  - phase: 05-funding-interruption-durable-resume
    provides: replay-safe funding pauses and owner-safe top-up status
provides:
  - One durable continuation authority for pause, checkpoint, resume claim, expiry, and deletion state
  - PostgreSQL-wire continuation transitions paired with scripted migration parity tests
affects: [05-03, checkpointing, worker-leases, resume-session]
tech-stack:
  added: []
  patterns: [one-transaction continuation state, immutable checkpoint identity, terminal expiry tombstone]
key-files:
  created: [migrations/phase-05/001_continuation.sql, tests/persistence/continuation-store.test.ts, tests/persistence/phase-05-sql-schema-parity.test.ts]
  modified: [src/persistence/funding-store.ts, src/persistence/postgres-sql-funding-store.ts, src/persistence/postgres-funding-database.ts, tests/persistence/postgres-sql-funding-store.test.ts]
key-decisions:
  - "Checkpoint commitment clears the live lease in the same continuation state transition."
  - "A pre-expiry resume claim remains fenced while unclaimed checkpoints tombstone exactly at the retention deadline."
  - "The PostgreSQL funding database exposes continuation as an alias of its existing funding authority."
patterns-established:
  - "Continuation rows use immutable object generation/checksum identity and command-fingerprint replay."
requirements-completed: [CONT-01, CONT-03, CONT-04, CONT-06, CONT-07]
coverage:
  - id: D1
    description: Durable pause, checkpoint, resume-claim, and expiry state has one deterministic legal winner.
    requirement: CONT-01
    verification:
      - kind: integration
        ref: bun test tests/persistence/continuation-store.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: PostgreSQL-wire transitions and Phase 05 migration enforce continuation identity, retention, and no generation queue.
    requirement: CONT-07
    verification:
      - kind: integration
        ref: bun test tests/persistence/phase-05-sql-schema-parity.test.ts tests/persistence/postgres-sql-funding-store.test.ts --timeout 10000
        status: pass
    human_judgment: false
metrics:
  duration: 6 min
  completed: 2026-08-05
status: complete
---

# Phase 05 Plan 02: Durable Continuation Authority Summary

**Replay-safe pause, checkpoint, explicit resume, and expiry transitions now share one deterministic and PostgreSQL-wire funding authority.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-08-05T01:05:25Z
- **Completed:** 2026-08-05T01:11:45Z
- **Tasks:** 2/2
- **Files modified:** 7

## Accomplishments

- Added append-only continuation migration rows for pauses, immutable checkpoint objects, resume commands, tombstones, and exact-generation deletion audit.
- Extended the deterministic funding authority with replay-safe pause generations, checkpoint lease release, single resume claim, and terminal expiry behavior.
- Added PostgreSQL-wire continuation methods inside the existing serializable transaction and exposed them through the database-owned funding authority.
- Proved the memory transitions, SQL transaction seam, and scripted schema parity without claiming live PostgreSQL certification.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define continuation rows and one atomic transition contract** — `61061ef` (test), `af91072` (feat)
2. **Task 2: Implement PostgreSQL-wire continuation parity and scripted schema proof** — `a5b971b` (test), `f9399cc` (feat)

## Files Created/Modified

- `migrations/phase-05/001_continuation.sql` — Continuation, checkpoint, command, tombstone, and deletion constraints.
- `src/persistence/funding-store.ts` — Unified continuation transaction contracts and deterministic oracle.
- `src/persistence/postgres-sql-funding-store.ts` — Serializable SQL continuation transitions.
- `src/persistence/postgres-funding-database.ts` — Single database-owned continuation authority alias.
- `tests/persistence/continuation-store.test.ts` — Replay, claim, and expiry-race tests.
- `tests/persistence/phase-05-sql-schema-parity.test.ts` — Scripted migration and adapter parity gate.

## Decisions Made

- Checkpoint identity and lease revocation commit together, preventing a resumable checkpoint from coexisting with its old live lease.
- Resume commands claim before allocation and are terminally fenced by the fixed 30-day deadline.
- Live PostgreSQL infrastructure execution remains a Phase 7 certification gate; this plan proves scripted SQL/schema parity only.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None.

## Next Phase Readiness

- Plan 05-03 can build checkpoint/worker-envelope orchestration against the persisted continuation seams.
- Production PostgreSQL, object-storage, and worker-provider certification remain intentionally deferred to Phase 7.

## Self-Check: PASSED

- Created migration and continuation test files are present.
- Task commits `61061ef`, `af91072`, `a5b971b`, and `f9399cc` exist in git history.
- The complete plan verification command passed with 17 tests.

---
*Phase: 05-funding-interruption-durable-resume*
*Completed: 2026-08-05*
