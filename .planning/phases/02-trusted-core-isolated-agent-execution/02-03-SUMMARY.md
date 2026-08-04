---
phase: 02-trusted-core-isolated-agent-execution
plan: 03
subsystem: session-persistence
tags: [typescript, bun, sqlite, idempotency, concurrency, evidence]
requires:
  - phase: 02-trusted-core-isolated-agent-execution
    provides: strict Phase 2 action and evidence contracts
provides:
  - canonical D-20 action identities and frozen result contracts
  - transaction-shaped SessionStore port with an in-memory test double
  - file-backed Bun SQLite session authority with durable replay and evidence
  - transport-neutral interruption and explicit stale retry semantics
affects: [phase-02-plan-04, phase-03-ledger-adapters, contextvm-adapter]
tech-stack:
  added: [bun:sqlite]
  patterns: [idempotency-before-version-fence, atomic-session-result-evidence-commit, exact-replay, explicit-cancellation]
key-files:
  created:
    - src/domain/session-action.ts
    - src/domain/session-service.ts
    - src/persistence/session-store.ts
    - src/persistence/sqlite-session-store.ts
    - tests/domain/session-service.test.ts
    - tests/persistence/session-store.test.ts
    - tests/persistence/sqlite-session-store.test.ts
  modified: []
key-decisions:
  - "SQLite checks the session idempotency key and complete fingerprint before the version fence, so reused keys fail deterministically."
  - "Only sessions, action_results, and append-only evidence are durable Phase 2 tables; financial and retention state remain absent."
  - "Cancellation before evaluation rolls back or avoids the transaction; callers explicitly retry after stale outcomes and exact response-loss retries replay a frozen result."
patterns-established:
  - "A successful action creates exactly one evidence record and immutable stored result at the resulting session version."
  - "The memory implementation is a copy-then-commit unit-test double; SqliteSessionStore is the file-backed durable reference."
requirements-completed: [SESS-05]
coverage:
  - id: D1
    description: Durable, atomic session action storage with exact replay, identity conflict, stale fencing, rollback, reopen, and concurrent-call convergence.
    requirement: SESS-05
    verification:
      - kind: integration
        ref: bun test tests/persistence/session-store.test.ts tests/persistence/sqlite-session-store.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Transport-neutral service semantics for abort-before-evaluation, response-loss replay, explicit stale retry, and concurrent callers.
    requirement: SESS-05
    verification:
      - kind: unit
        ref: bun test tests/domain/session-service.test.ts tests/persistence/session-store.test.ts tests/persistence/sqlite-session-store.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 3m 29s
  completed: 2026-08-04
status: complete
---

# Phase 2 Plan 03: Durable Session Semantics Summary

Canonical version-fenced actions now persist atomically in file-backed Bun SQLite, with exact replay, explicit conflict/stale results, and cancellation-safe SessionService semantics.

## Performance

- **Duration:** 3m 29s
- **Started:** 2026-08-04T10:48:27Z
- **Completed:** 2026-08-04T10:51:56Z
- **Tasks:** 2/2
- **Files modified:** 7

## Accomplishments

- Bound every D-20 action fingerprint to principal, session, kind, idempotency key, expected version, policy version, and canonical payload hash.
- Added the durable reference schema for exactly sessions, immutable idempotency results, and append-only content-addressed evidence, with close/reopen and rollback tests.
- Defined replay, stale, conflict, simultaneous caller, response-loss retry, and pre-evaluation cancellation behavior through a transport-neutral service.

## Task Commits

1. **Task 1: Define exact action identity and the durable Bun SQLite SessionStore (RED)** — `5e77c41` (test)
2. **Task 1: Define exact action identity and the durable Bun SQLite SessionStore (GREEN)** — `3b5e6e3` (feat)
3. **Task 2: Expose deterministic interruption and retry semantics through SessionService (RED)** — `da8727e` (test)
4. **Task 2: Expose deterministic interruption and retry semantics through SessionService (GREEN)** — `6f4ef1d` (feat)

## Files Created/Modified

- `src/domain/session-action.ts` — canonical action and evidence fingerprint helpers plus stable result codes.
- `src/persistence/session-store.ts` — authoritative store seam and deterministic memory double.
- `src/persistence/sqlite-session-store.ts` — SQLite schema, bounded busy handling, and all-or-nothing durable action application.
- `src/domain/session-service.ts` — cancellation-safe, no-auto-retry caller semantics.
- `tests/persistence/session-store.test.ts`, `tests/persistence/sqlite-session-store.test.ts`, `tests/domain/session-service.test.ts` — replay, fences, durable recovery, rollback, concurrency, and interruption coverage.

## Decisions Made

- Idempotency lookup precedes ownership/version checks only for the exact session-key pair; a fingerprint mismatch is always `IDEMPOTENCY_KEY_CONFLICT`.
- Evidence identity is written in the same transaction as the action result and conditional version advance.
- An interrupted caller receives recoverable `ACTION_INTERRUPTED`; a caller that loses a completed response uses the same idempotency key to retrieve the stored success.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Renamed the SessionService test factory to avoid a temporal-dead-zone shadowing failure.**
- **Found during:** Task 2
- **Issue:** The test helper name was shadowed by destructuring inside test bodies, causing the initial service test run to throw before assertions.
- **Fix:** Renamed the helper to `createService`.
- **Files modified:** `tests/domain/session-service.test.ts`
- **Verification:** Focused service and persistence suite passes.
- **Committed in:** `6f4ef1d`

---

**Total deviations:** 1 auto-fixed (Rule 1)
**Impact on plan:** Test-only correctness repair; no scope expansion.

## Issues Encountered

- The final full `bun test` run executed this plan's 13 tests successfully, but two concurrently-developed SAFE-02 risk-policy tests failed because their uncommitted implementation returned `RISK_CLASSIFIER_UNAVAILABLE` for configured signals. This is outside Plan 03 ownership; no persistence/domain files were changed in response.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Later transport and ledger adapters can depend on one explicit action transaction boundary and durable frozen replay outcomes.
- Phase 3 must keep financial reservation, ledger, balance, and payment tables outside this Phase 2 schema.

## Self-Check: PASSED

- Confirmed all seven planned source/test files exist.
- Confirmed commits `5e77c41`, `3b5e6e3`, `da8727e`, and `6f4ef1d` exist.
