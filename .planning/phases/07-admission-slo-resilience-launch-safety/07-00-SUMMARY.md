---
phase: 07-admission-slo-resilience-launch-safety
plan: "00"
subsystem: testing
tags: [bun, nyquist, certification, fail-closed, resilience]
requires:
  - phase: 06-sealed-preview-user-owned-publication
    provides: sealed preview and publication boundaries whose live evidence remains Phase 7-owned
provides:
  - strict five-row Wave 0 registry for admission, telemetry, recovery, restore, and promotion gates
  - compile-safe baseline tests with explicit future implementation owners
  - fail-closed deterministic, evidence, and protected-certification CLI seams
affects: [07-01, 07-04, 07-06, 07-07, 07-09, 07-10, release-certification]
tech-stack:
  added: []
  patterns: [strict comparator-only fixture registry, pending-only Wave 0 baseline, nonzero certification preflight]
key-files:
  created:
    - tests/fixtures/phase-07-reference-set.json
    - tests/phase-07/admission-slo.test.ts
    - tests/phase-07/telemetry-policy.test.ts
    - tests/phase-07/fault-matrix.test.ts
    - tests/phase-07/restore-drill.test.ts
    - tests/phase-07/promotion-gate.test.ts
    - tests/evals/phase-07-reference-set.test.ts
    - scripts/eval-phase-07.ts
    - scripts/verify-phase-07-evidence.ts
    - scripts/certify-phase-07.ts
  modified:
    - .planning/phases/07-admission-slo-resilience-launch-safety/07-VALIDATION.md
key-decisions:
  - "Wave 0 registry rows are pending-only and have no runtime, store, provider, or promotion authority."
  - "Baseline CLI seams report only bounded non-pass facts until later plans supply executed candidate-bound evidence."
patterns-established:
  - "Later Phase 7 plans replace named TODO registrations with production-derived observations without creating parallel gates."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Strict pending registry and compile-safe admission/telemetry baseline contracts.
    requirement: SESS-02
    verification:
      - kind: unit
        ref: bun test tests/phase-07/admission-slo.test.ts tests/phase-07/telemetry-policy.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: Comparator-only fault and exact-restore baseline contracts.
    requirement: OPS-02
    verification:
      - kind: unit
        ref: bun test tests/phase-07/fault-matrix.test.ts tests/phase-07/restore-drill.test.ts tests/evals/phase-07-reference-set.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D3
    description: Fail-closed deterministic, evidence, and protected certification command seams.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: bun test tests/phase-07/promotion-gate.test.ts --timeout 10000
        status: pass
    human_judgment: false
duration: 5m
completed: 2026-08-05
status: complete
---

# Phase 07 Plan 00: Wave 0 Nyquist Baseline Summary

**A strict five-row Phase 7 test registry with pending-only admission, telemetry, recovery, restore, and promotion contracts plus fail-closed certification seams.**

## Performance

- **Duration:** 5m
- **Started:** 2026-08-05T15:28:34+01:00
- **Completed:** 2026-08-05T15:33:50Z
- **Tasks:** 3/3
- **Files modified:** 12

## Accomplishments

- Added registry-backed entrypoints for all five Wave 0 IDs, with exact consuming plan/task, requirement, threat, evidence tier, command, and pending status mappings.
- Ensured comparator facts never enter baseline runtime inputs and retained every production observation as an explicit future TODO.
- Added closed-argument deterministic and protected command seams that emit nonzero `not_implemented`, `not_observed`, or `blocked` facts without secret output or promotion mutation.
- Updated Wave 0 validation only after focused and complete test suites passed; live observations remain pending.

## Task Commits

Each TDD task was committed as a RED/green pair:

1. **Task 1: Register admission and telemetry contracts** - `854293e` (test), `44fcc20` (feat)
2. **Task 2: Register original-operation and exact-restore contracts** - `66bd682` (test), `8a4e75b` (feat)
3. **Task 3: Register promotion gate and certification commands** - `7ab0263` (test), `53027e2` (feat)

## Files Created/Modified

- `tests/fixtures/phase-07-reference-set.json` - closed, pending-only owner and command registry.
- `tests/phase-07/*.test.ts` - compile-safe Wave 0 admission, telemetry, recovery, restore, and promotion contracts.
- `tests/evals/phase-07-reference-set.test.ts` - comparator/runtime separation guard.
- `scripts/eval-phase-07.ts`, `scripts/verify-phase-07-evidence.ts`, `scripts/certify-phase-07.ts` - bounded non-pass command surfaces.
- `07-VALIDATION.md` - Wave 0 baseline results recorded without claiming live certification.

## Decisions Made

- The registry is ordered, exact, and pending-only; changing it to a baseline `passed` claim fails the tests.
- Certification preflight has no persistence or promotion path and intentionally reports unavailable implementation/topology as non-pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected the protected-preflight test output channel**
- **Found during:** Task 3
- **Issue:** The test required suite inventory on stdout while fail-closed CLI facts correctly used stderr.
- **Fix:** Assert the combined bounded stdout/stderr output without weakening the nonzero or secret-redaction checks.
- **Files modified:** `tests/phase-07/promotion-gate.test.ts`
- **Verification:** Focused promotion test and complete Bun suite passed.
- **Committed in:** `53027e2`

**2. [Rule 3 - Blocking issue] Normalized legacy plan-position metadata**
- **Found during:** State update
- **Issue:** `state.advance-plan` could not parse the legacy `Plan: Not started` format, preventing the completed plan from advancing the execution state.
- **Fix:** Replaced it with the supported compound plan count before rerunning the state handler.
- **Files modified:** `.planning/STATE.md`
- **Verification:** `state.advance-plan` advanced from Plan 1 to Plan 2 of 11.

**Total deviations:** 2 auto-fixed (Rule 1, Rule 3)

## Known Stubs

The following intentional `test.todo` registrations are the Wave 0 handoffs, not passing observations. Each is recorded in `.planning/WINDOWS.md` for its consuming plan.

- `tests/phase-07/admission-slo.test.ts:66` - Plan 07-01 production admission observation.
- `tests/phase-07/telemetry-policy.test.ts:40` - Plan 07-04 telemetry exporter observation.
- `tests/phase-07/fault-matrix.test.ts:27` and `tests/evals/phase-07-reference-set.test.ts:29` - Plans 07-06/07-09 original-operation observations.
- `tests/phase-07/restore-drill.test.ts:27` - Plan 07-07 fresh-instance restore observation.
- `tests/phase-07/promotion-gate.test.ts:43` - Plan 07-10 atomic promotion-evidence observation.

## Issues Encountered

None beyond the auto-fixed test assertion above.

## User Setup Required

None. Protected prerequisites intentionally remain non-pass until their later certification plans provide valid profile, credential-reference, implementation, and topology evidence.

## Next Phase Readiness

Plans 07-01, 07-04, 07-06, 07-07, 07-09, and 07-10 now have named entrypoints to replace with production-derived observations. This baseline does not certify live integrations or promotion.

## Self-Check: PASSED

- All ten declared test/fixture/script files exist.
- All six task commits exist.
- `bun test --timeout 10000` passed: 433 pass, 6 intentional pending TODOs, 0 fail.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-05*
