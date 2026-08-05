---
phase: 07-admission-slo-resilience-launch-safety
plan: "13"
subsystem: release-promotion-cli
tags: [bun, cli, release-certification, promotion, regression-test]
requires:
  - phase: 07-12
    provides: Exact release-bundle parsing and the sole release-certification evaluator
provides:
  - Public release verification exit status derived from the evaluator decision
  - Real subprocess coverage for promoted and blocked exact release bundles
affects: [phase-07-verification, production-promotion]
tech-stack:
  added: []
  patterns:
    - CLI exit status mirrors the existing authoritative release decision
    - Temporary repository-relative release bundles prove public command behavior
key-files:
  created: []
  modified:
    - src/promotion/candidate.ts
    - tests/phase-07/promotion-gate.test.ts
key-decisions:
  - "candidate:verify exits zero only when the existing evaluateReleaseCertification path returns promoted."
  - "The subprocess fixture writes complete relative-path release evidence and cleans it up without altering canonical evidence."
patterns-established:
  - "Promotion CLI: retain one evaluator and map only its terminal status to process success."
requirements-completed: []
coverage:
  - id: D1
    description: Public candidate release verification reports success only for a promoted exact bundle and rejects a candidate-substituted bundle.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/phase-07/promotion-gate.test.ts#candidate verification reports promoted release evidence as a successful package command
        status: pass
      - kind: unit
        ref: bun test --timeout 10000
        status: pass
    human_judgment: false
duration: 10 min
completed: 2026-08-05
status: complete
---

# Phase 07 Plan 13: Release Verification CLI Exit Mapping Summary

**The public release verifier now exits successfully only for the existing sole evaluator's `promoted` decision, with a real exact-bundle subprocess regression proving both outcomes.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-08-05T19:36:00Z
- **Completed:** 2026-08-05T19:46:51Z
- **Tasks:** 1/1
- **Files modified:** 2

## Accomplishments

- Preserved the exact parser and evaluator, then mapped the returned decision directly to the public process exit code.
- Added a repository-relative temporary release bundle containing all required protected observation files and exercised it through `bun run candidate:verify`.
- Confirmed the promoted bundle exits zero while candidate-substituted and canonical deterministic evidence remain nonzero.

## Task Commits

1. **Task 1: Derive the CLI exit code from the sole evaluator decision** - `ac37a37` (test), `eb1d9ce` (fix)

## Files Created/Modified

- `src/promotion/candidate.ts` - Prints the existing release decision and derives `process.exitCode` from `decision.status`.
- `tests/phase-07/promotion-gate.test.ts` - Materializes and removes an exact relative-path release bundle for public promoted and blocked subprocess coverage.

## Decisions Made

- Used no alternate promotion evaluator: the CLI only maps the existing decision's `status` to zero or nonzero.
- Kept the canonical deterministic pointer blocked; the promoted fixture is test-only plumbing and never writes live certification evidence.

## Requirement Status

OPS-04 remains pending protected-live certification. This plan closes only the local public CLI exit-code gap and does not create, alter, or claim protected evidence.

## Verification

- `bun test tests/phase-07/promotion-gate.test.ts --test-name-pattern='candidate verification|release evidence' --timeout 10000` - passed (5 tests).
- `! bun run candidate:verify -- --release-evidence evidence/design/phase-07.json` - passed; canonical deterministic pointer remains blocked/nonzero.
- `bun test --timeout 10000` - passed (495 tests).

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration was required.

## Next Phase Readiness

The final local release-CLI gap is closed. Phase 7 remains blocked on genuine protected-live certification evidence and requires phase goal re-verification; this plan does not change that status.

## Self-Check: PASSED

- `src/promotion/candidate.ts` and `tests/phase-07/promotion-gate.test.ts` exist.
- Task commits `ac37a37` and `eb1d9ce` exist.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-05*
