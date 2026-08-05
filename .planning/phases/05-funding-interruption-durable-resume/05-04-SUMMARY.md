---
phase: 05-funding-interruption-durable-resume
plan: 04
subsystem: continuity
tags: [funding, grace-wake, checkpoint, lease-fencing, aes-gcm]
requires:
  - phase: 05-02
    provides: atomic pause, checkpoint, and lease-revocation authority
  - phase: 05-03
    provides: authenticated checkpoint envelopes and lease-bound worker lifecycle ports
provides:
  - Verified-credit hints that atomically authorize one same-worker continuation
  - Injected-clock deadline reconciliation that seals before checkpoint/lease promotion and terminates after it
affects: [05-05, 05-06, continuation, metered-generation]
tech-stack:
  added: []
  patterns: [durable-credit-reread, single-wake-action-budget, object-before-sql-checkpoint-promotion, terminate-after-lease-revocation]
key-files:
  created: [src/continuity/deadline-reconciler.ts, tests/phase-05/grace-wake.test.ts, tests/phase-05/deadline-checkpoint.test.ts]
  modified: [src/continuity/continuation-service.ts, src/phase-04/metered-generation-service.ts]
key-decisions:
  - "A payment delivery is only a wake hint; the coordinator rereads durable funds and all paused-session fences inside the store transaction."
  - "Checkpoint ciphertext may exist before SQL promotion, but worker termination occurs only after the atomic checkpoint identity and lease revocation commit."
requirements-completed: [CONT-03, CONT-04]
coverage:
  - id: D1
    description: Verified credit resumes exactly one unchanged live lease after a fresh action budget, while duplicate, stale, cap-short, and deadline hints are no-effects.
    requirement: CONT-03
    verification:
      - kind: integration
        ref: bun test tests/phase-05/grace-wake.test.ts tests/funding/funded-admission.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: Deadline reconciliation validates and seals checkpoint state, commits its identity with lease revocation, and only then attempts termination across fault boundaries.
    requirement: CONT-04
    verification:
      - kind: integration
        ref: bun test tests/phase-05/deadline-checkpoint.test.ts tests/phase-05/checkpoint-envelope.test.ts --timeout 10000
        status: pass
    human_judgment: false
metrics:
  duration: 10 min
  completed: 2026-08-05
status: complete
---

# Phase 05 Plan 04: Grace Wake and Deadline Checkpoint Summary

**Verified credit now wakes one unchanged live worker only after a fresh budget, while deadline reconciliation promotes an encrypted checkpoint and fences the old lease before termination.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-08-05T01:24:57Z
- **Completed:** 2026-08-05T01:34:07Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added a durable-credit wake transition that rejects notification-only, cap-short, stale, foreign, reordered, duplicate, and deadline-expired hints without work or cap mutation.
- Added a coordinator-facing metered wake hook that receives only the pending-action reference, fresh budget reference, and preserved lease token after the transition commits.
- Added injected-clock deadline scanning that validates worker exports, seals an immutable encrypted object, commits checkpoint identity with lease revocation, then idempotently terminates the worker.
- Added boundary and fault tests for pre-deadline idleness, concurrent hints, invalid export, object/SQL pre-commit loss, and post-commit termination loss.

## Task Commits

1. **Task 1: Wake only the same fenced worker after authoritative credit and fresh authorization** — `e896cfa` (test), `26aa5d8` (feat)
2. **Task 2: Checkpoint at the fixed deadline and revoke the live lease before termination** — `2b16647` (test), `b7e9229` (feat)

## Files Created/Modified

- `src/continuity/continuation-service.ts` — Atomic verified-credit, budget, tuple, deadline, and lease wake authority.
- `src/continuity/deadline-reconciler.ts` — Clock-driven checkpoint/release orchestration with named fault boundaries.
- `src/phase-04/metered-generation-service.ts` — Internal coordinator integration point for a newly authorized live wake.
- `tests/phase-05/grace-wake.test.ts` — CONT-03 credit, cap, deadline, replay, lease, and idle-effect coverage.
- `tests/phase-05/deadline-checkpoint.test.ts` — CONT-04 deadline ordering and crash-point coverage.

## Decisions Made

- Payment and relay signals remain non-authoritative: only a durable funding snapshot and the exact pause/version/lease tuple can create the fresh action budget.
- Checkpoint promotion is object-first but SQL-authoritative; an uploaded encrypted orphan has no resumable authority, and a committed checkpoint has already revoked its live lease before termination is attempted.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 1 - Bug] Corrected the grace-wake test account identity.**
   - **Found during:** Task 1 GREEN verification.
   - **Issue:** The initial fixture used a literal account ID while funding derives the account from the signed principal, so the intended admission was not visible to the continuation transaction.
   - **Fix:** Derived the test account ID through the same project helper as the funding coordinator.
   - **Files modified:** `tests/phase-05/grace-wake.test.ts`.
   - **Verification:** Targeted grace-wake and funded-admission suites pass.
   - **Committed in:** `26aa5d8`.

**Total deviations:** 1 auto-fixed (Rule 1 bug).
**Impact on plan:** Corrected test setup only; no scope expansion.

## Issues Encountered

None.

## Known Stubs

None.

## Next Phase Readiness

- Later Phase 5 plans can consume a single same-worker wake result and the deadline reconciler’s checkpoint-first release order.
- Live Modal, object storage, key-management, and provider certification remain explicitly deferred to Phase 7.

## Self-Check: PASSED

- All five production/test files exist on disk.
- Task commits `e896cfa`, `26aa5d8`, `2b16647`, and `b7e9229` exist in git history.
- `bun test` passed: 338 tests, 0 failures.
