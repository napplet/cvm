---
phase: 07-admission-slo-resilience-launch-safety
plan: "39"
subsystem: release-certification
tags: [release-controller, sole-evaluator, immutable-bundle, promotion, cleanup, cli]
requires:
  - phase: 07-38
    provides: receipt-bound native operations and exact-eight protected-suite records
provides:
  - sole-evaluator finalization of one exact protected-live evidence root
  - immutable candidate-bound release bundles and original-operation promotion journals
  - idempotent cleanup observations and redacted receipt/resume command progress
affects: [07-20, 07-26, protected-live-run, release-promotion]
tech-stack:
  added: []
  patterns: [sole-evaluator orchestration, immutable-before-effect, original-operation cleanup]
key-files:
  created: [src/release/finalize.ts]
  modified: [src/release/controller.ts, scripts/certify-release.ts, tests/release/live-controller.test.ts, tests/release/certify-release.test.ts]
key-decisions:
  - "Finalization delegates its only verdict to evaluateReleaseCertification after enforcing a complete protected-live exact-eight root."
  - "Promotion and cleanup retain original operation identities in immutable journals so restart reuses, rather than replaces, an effect."
  - "The product command returns only candidate-bound digests and stage status for receipt confirmation."
patterns-established:
  - "Persist the immutable bundle and original promotion operation before pointer mutation."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Incomplete protected evidence cannot create a bundle or promotion effect.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/release/live-controller.test.ts#finalization rejects incomplete evidence before bundle or promotion effects
        status: pass
    human_judgment: false
  - id: D2
    description: Receipt confirmation produces safe same-run authorization progress without provider execution.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: tests/release/certify-release.test.ts#receipt confirmation reports a redacted same-run progress boundary
        status: pass
    human_judgment: false
metrics:
  duration: 12m
  completed: 2026-08-06
status: complete
---

# Phase 07 Plan 39: Release Finalization Summary

**The receipt-bound release controller now finalizes only a fresh protected exact-eight root through the existing evaluator, journals an immutable promotion bundle, and reports redacted same-run CLI progress.**

## Performance

- **Duration:** 12m
- **Started:** 2026-08-06T15:59:00Z
- **Completed:** 2026-08-06T16:11:15Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added a sole-evaluator finalizer which rejects incomplete, non-live, stale, cross-topology, duplicate, and mismatched protected evidence before it writes any bundle or promotion operation.
- Persists a content-addressed bundle containing protected records, evaluator verdict, trust material, verification records, receipt references, attestations, selected worker, and bounded cleanup plan before a caller-provided promotion pointer effect.
- Makes promotion and cleanup replays reuse durable original-operation observations, and returns redacted request/receipt progress from the product CLI.

## Task Commits

1. **Task 1: Finalize one complete evidence root into one immutable bundle** - `9008dcf`, `2adc941` (test, feat)
2. **Task 2: Complete cleanup and product-command resume semantics** - `24428f4` (feat)

## Files Created/Modified

- `src/release/finalize.ts` - Exact-eight finalization, sole evaluator delegation, immutable bundle/promotion journal, and resumable cleanup observations.
- `src/release/controller.ts` - Routes a passed protected run into finalization and refuses completion without finalization input.
- `scripts/certify-release.ts` - Emits redacted receipt-bound progress for request/receipt/resume workflows.
- `tests/release/live-controller.test.ts` - RED/green proof that incomplete evidence causes zero bundle/promotion effects.
- `tests/release/certify-release.test.ts` - Same-run receipt progress test with no provider calls.

## Decisions Made

- The existing `evaluateReleaseCertification` remains the sole release verdict; finalization adds no evaluator or policy duplication.
- A successful pointer effect still cannot conceal an unresolved cleanup: cleanup returns `cleanup_incomplete` and the controller remains non-complete.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Updated stale plan path references to current authority modules**
- **Found during:** Task 1
- **Issue:** The plan referenced removed `src/certification/evaluator.ts`, `bundle.ts`, and `src/promotion/promotion.ts` paths.
- **Fix:** Used the current sole evaluator in `src/promotion/run-promotion.ts`, protected-runner exact-eight contract, trust finalizer, and evidence contract without changing authority boundaries.
- **Files modified:** `src/release/finalize.ts`, `src/release/controller.ts`
- **Verification:** Focused release suites and full `bun test` pass.
- **Committed in:** `2adc941`

---

**Total deviations:** 1 auto-fixed (Rule 3)
**Impact on plan:** No scope expansion; the adjustment preserved the plan's intended sole-evaluator and immutable-bundle architecture.

## Issues Encountered

None.

## Known Stubs

None.

## User Setup Required

None - this implementation uses only fakes and local fixtures. Plan 07-20 remains the required exact provider authorization checkpoint, and Plan 07-26 remains the only protected live run.

## Next Phase Readiness

The controller, finalizer, and CLI are implementation-complete. Next: Plan 07-20 exact provider authorization; then Plan 07-26 executes the protected live run with the persisted same-run identities.

## Self-Check: PASSED

- `src/release/finalize.ts` and both release test files exist.
- Task commits `9008dcf`, `2adc941`, and `24428f4` exist.
- Focused release tests and full `bun test` passed (615 tests).
