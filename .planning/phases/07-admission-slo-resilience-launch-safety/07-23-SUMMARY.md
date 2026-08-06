---
phase: 07-admission-slo-resilience-launch-safety
plan: "23"
subsystem: protected-live-operations
tags: [admission, telemetry, chaos, restore, protected-live, contract-tests]
requires:
  - phase: 07-21
    provides: Authorized provider topology and controller transition contracts
  - phase: 07-22
    provides: Candidate-bound protected certifier materialization
provides:
  - Candidate-bound admission, telemetry, chaos, and restore operational adapters
  - Local fail-closed contract coverage that cannot dispatch protected execution
affects: [protected-certification, phase-07-launch, plan-07-25]
tech-stack:
  added: []
  patterns: [protected-port-gate, original-operation-observation, exact-fresh-instance-restore, collector-window-binding]
key-files:
  created: [src/certification/live/admission.ts, src/certification/live/telemetry.ts, src/certification/live/chaos.ts, src/certification/live/restore.ts, tests/release/live-operations-adapters.test.ts]
  modified: []
key-decisions:
  - "Operational adapters reject deterministic ports before dispatch; only Plan 07-25 may inject authenticated protected-live ports."
  - "Chaos derives its oracle from an original-operation observation, and restore requires every D-125 subject to reattach once from a fresh instance."
metrics:
  duration: 7m
  completed: 2026-08-06
  status: complete
---

# Phase 07 Plan 23: Protected Operational Adapter Contracts Summary

**Four candidate-bound operational adapters now feed the locked admission, telemetry, chaos, and restore contracts while rejecting every locally injected deterministic port before a provider call, protected dispatch, or evidence write.**

## Performance

- **Duration:** 7m
- **Started:** 2026-08-06T11:40:00Z
- **Completed:** 2026-08-06T11:47:33Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added the Modal/Fly admission adapter, which delegates individual exact-session samples to the locked benchmark evaluator and only accepts complete cohort, one-sided p95, isolation, cleanup, and zero-backlog observations.
- Added the digest-bound Collector adapter, which emits the complete finite coordinator lifecycle then verifies a candidate/topology/config/Collector-bound export window with bounded cardinality and rejected canaries.
- Added the D-122 chaos adapter, which dispatches only the canonical fault matrix and validates one-writer, exact-effect facts retrieved by the original operation identity.
- Added the D-125 restore adapter, which inventories all seven subjects, loses local state, creates a fresh controller, verifies exact objects and restore fences, reattaches exactly once, and exercises expiry/deletion.

## Task Commits

1. **Task 1: Execute protected admission and Collector telemetry observations** — `f55a8d8` (RED), `c0b4b24` (GREEN)
2. **Task 2: Execute protected topology chaos and fresh-instance restore observations** — `9dd6033` (RED), `5af0b6f` (GREEN)

## Files Created/Modified

- `src/certification/live/admission.ts` — locked worker-schedule and SLO adapter behind a protected-only observation port.
- `src/certification/live/telemetry.ts` — finite lifecycle emission and exact Collector-window verifier.
- `src/certification/live/chaos.ts` — canonical D-122 dispatch with original-operation authoritative observations.
- `src/certification/live/restore.ts` — D-125 exact-object fresh-instance restore and expiry/deletion adapter.
- `tests/release/live-operations-adapters.test.ts` — local deterministic-port contract tests proving no live/protected pass path or provider dispatch.

## Decisions Made

- Each adapter takes a narrow injected port only; it does not create clients, authenticate, provision topology, write protected evidence, or accept caller-provided pass summaries.
- A port labelled `deterministic` returns a non-pass before its first method can run. Plan 07-25 is solely responsible for injecting real protected-live ports after Plan 07-20 authorization.

## Verification

- `bun test tests/release/live-operations-adapters.test.ts --test-name-pattern='admission|Modal|Fly|Collector|telemetry|canary' --timeout 10000` — passed.
- `bun test tests/release/live-operations-adapters.test.ts --test-name-pattern='chaos|original operation|restore|retention|RTO|RPO' --timeout 10000` — passed.
- Relevant suite: 30 passed, 0 failed across live adapter, worker benchmark, fault matrix, restore drill, and certification runner tests.
- `bunx tsc --noEmit` remains blocked by pre-existing repository-wide errors in unrelated source/scripts and test typings; neither live adapter file is reported.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Removed a forged protected-live fixture pass path**
- **Found during:** Task 2
- **Issue:** The initial local contract test used a mock port labelled `protected_live`, which contradicted the local-only boundary even though it performed no network call.
- **Fix:** Restricted all test ports to `deterministic` and asserted that their methods are never called; the production adapters retain their protected-port seam for Plan 07-25 only.
- **Files modified:** `tests/release/live-operations-adapters.test.ts`
- **Commit:** `9dd6033`

**Total deviations:** 1 auto-fixed (Rule 2 - Security).
**Impact:** Local tests cannot supply any protected-live pass result or trigger protected work.

## Known Stubs

None.

## Next Phase Readiness

Plan 07-25 can wire these adapters to the materialized, authenticated provider ports only after the Plan 07-20 authorization checkpoint. This plan produced no provider mutation, protected-suite dispatch, or protected-evidence record.

## Self-Check: PASSED

- Task commits `f55a8d8`, `c0b4b24`, `9dd6033`, and `5af0b6f` exist in Git history.
- All four live adapter modules and their contract test exist on disk.
- Focused and relevant automated tests passed; local fixture results remain non-authoritative.
