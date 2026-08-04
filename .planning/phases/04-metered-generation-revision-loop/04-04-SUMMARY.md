---
phase: 04-metered-generation-revision-loop
plan: 04
subsystem: metered-generation-revision
tags: [billing, revisions, repair-policy, napplet-harness, artifact-verification, zod]
dependency_graph:
  requires: [04-03]
  provides: [same-lineage-revisions, verified-artifact-outcomes, one-automatic-repair]
  affects: [phase-04-session-status, phase-05-continuity, phase-06-preview]
tech_stack:
  added: []
  patterns: [session-serialized-revisions, closed-harness-outcomes, immutable-repair-ceiling]
key_files:
  created: [src/phase-04/napplet-harness.ts, src/phase-04/repair-policy.ts, tests/phase-04/revision.test.ts, tests/phase-04/repair.test.ts, tests/phase-04/artifact-outcome.test.ts]
  modified: [src/phase-04/metered-generation-service.ts, src/persistence/funding-store.ts, src/persistence/postgres-funding-store.ts, src/persistence/postgres-sql-funding-store.ts]
decisions:
  - "Revisions serialize per account/session before new provider or worker work and reuse the established action receipt lifecycle."
  - "Only the ProjectNappletHarness verified branch may advance an artifact; non-passing outcomes retain the prior artifact and return redacted diagnostics."
  - "Automatic repair is one owner-scoped, persisted action per originating failed action; subsequent recovery requires a signed revision."
requirements-completed: [BILL-03, SESS-04, GEN-05, GEN-06]
coverage:
  - id: D1
    description: Same-lineage revision admission, replay, stale fencing, and concurrency behavior.
    requirement: SESS-04
    verification:
      - kind: integration
        ref: tests/phase-04/revision.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Verified-artifact-only harness outcomes and safe failure diagnostics.
    requirement: GEN-06
    verification:
      - kind: integration
        ref: tests/phase-04/artifact-outcome.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: One separately authorized automatic repair with restrictive policy ceiling.
    requirement: GEN-05
    verification:
      - kind: unit
        ref: tests/phase-04/repair.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 14m
  completed_date: 2026-08-04
status: complete
---

# Phase 04 Plan 04: Revision and Verified Artifact Outcomes Summary

Metered sessions now support bounded same-lineage revisions, promoted-toolchain artifact verification, and one separately authorized validation repair without turning failed candidates into usable artifacts.

## Performance

- **Duration:** 14m
- **Started:** 2026-08-04T19:54:00Z
- **Completed:** 2026-08-04T20:08:30Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- Added strict revision commands, exact replay, stale/lineage/input rejection, and session-scoped concurrent writer fencing.
- Added a project-owned harness that validates the promoted make/design/build/test workflow and exposes a closed verified-or-diagnostic result union.
- Added immutable one-repair policy and persisted owner-scoped repair-origin counting across all metered funding store implementations.

## Task Commits

1. **Task 1: Add separately authorized same-lineage revisions** — `f18f51e` (RED), `fc1f6f1` (GREEN)
2. **Task 2: Compose promoted napplet workflows and truthful artifact outcomes** — `a464864` (RED), `7e5fe30` (GREEN), `ef6d469` (integration fix)
3. **Task 3: Authorize exactly one validation-triggered repair** — `bc849dd` (RED), `90049de` (GREEN), `00f145c` (durable repair-origin fix)

## Files Created/Modified

- `src/phase-04/metered-generation-service.ts` — revision, repair, and harness-composed metered action paths.
- `src/phase-04/napplet-harness.ts` — fixed promoted workflow validation and safe artifact outcome union.
- `src/phase-04/repair-policy.ts` — deeply frozen, restrictive one-automatic-repair decision.
- `src/persistence/funding-store.ts` — owner-scoped session action history for repair ceilings.
- `src/persistence/postgres-funding-store.ts` — deterministic PostgreSQL adapter session action history.
- `src/persistence/postgres-sql-funding-store.ts` — PostgreSQL-wire session action history query.
- `tests/phase-04/revision.test.ts` — revision lifecycle proof.
- `tests/phase-04/repair.test.ts` — repair policy and internal command proof.
- `tests/phase-04/artifact-outcome.test.ts` — verified versus retained-artifact outcome proof.

## Decisions Made

- Revisions reuse the existing metered provider intent, pricing, receipt, and finalization lifecycle while receiving distinct action and operation IDs.
- Promoted toolchain identity is verified before the harness calls the worker; toolchain/model text remains data, never execution authority.
- Repair count is derived from persisted owner/session action history with the originating action embedded in repair identity, preventing an in-memory-only recursion guard.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical integration] Routed configured generation actions through the harness.**
- **Found during:** Task 2
- **Issue:** The new harness would otherwise be independently testable but not on the service finalization path.
- **Fix:** Added optional promoted-harness composition before finalization; only its `verified` result advances the action.
- **Files modified:** `src/phase-04/metered-generation-service.ts`
- **Verification:** Plan-wide targeted test suite passed.
- **Committed in:** `ef6d469`

**2. [Rule 2 - Missing critical persistence] Persisted automatic repair origin counting.**
- **Found during:** Task 3
- **Issue:** A service-local repair counter would reset on coordinator restart and could allow repair recursion.
- **Fix:** Added owner-scoped session action history to metered store adapters and derive the repair ceiling from persisted repair action identities.
- **Files modified:** `src/phase-04/metered-generation-service.ts`, `src/persistence/funding-store.ts`, `src/persistence/postgres-funding-store.ts`, `src/persistence/postgres-sql-funding-store.ts`
- **Verification:** Phase and persistence adapter suites passed.
- **Committed in:** `00f145c`

**Total deviations:** 2 auto-fixed (2 Rule 2 missing-critical corrections).

## Verification

- `bun test tests/phase-04/revision.test.ts tests/phase-04/repair.test.ts tests/phase-04/artifact-outcome.test.ts tests/policy/artifact-contract.test.ts tests/worker-port/contracts.test.ts --timeout 10000` — passed (18 tests).
- `bun test tests/persistence/postgres-funding-store.test.ts tests/persistence/postgres-sql-funding-store.test.ts --timeout 10000` — passed (12 tests).
- `git diff --check` — passed.
- Stub scan across all plan source and test files — no stubs found.

## Known Stubs

None.

## Next Phase Readiness

Plans 04-05 and 04-06 can use the retained verified-artifact outcome and persisted revision/repair action history. No live provider has been selected or certified.

## Self-Check: PASSED

- All six required source/test files exist.
- All eight RED, GREEN, and corrective implementation commits exist in git history.
