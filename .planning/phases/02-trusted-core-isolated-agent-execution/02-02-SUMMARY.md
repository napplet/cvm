---
phase: 02-trusted-core-isolated-agent-execution
plan: 02
subsystem: trusted-core-admission
tags: [typescript, bun, unicode, admission, risk-policy, sha-256]
requires:
  - phase: 02-trusted-core-isolated-agent-execution
    provides: immutable Phase 2 policy fixture and strict transport-neutral contracts
provides:
  - canonical NFC text admission with independent byte, scalar, grapheme, token, and structural ceilings
  - restrictive-only bounded risk classification with deterministic fault closure
affects: [phase-02-plan-06, generation-admission, worker-allocation]
tech-stack:
  added: []
  patterns: [pre-allocation-hard-denial, redacted-hash-evidence, restrictive-only-risk-signals]
key-files:
  created:
    - src/admission/admission-policy.ts
    - src/admission/risk-policy.ts
    - tests/admission/admission-policy.test.ts
    - tests/admission/risk-policy.test.ts
  modified: []
key-decisions:
  - "The named phase-02-policy-2026-08-04 fixture is the sole source for all admission ceilings."
  - "Risk detection is bounded, canonicalized observability that can only deny; it never participates in grant construction."
patterns-established:
  - "Validate exact NFC text and all hard structural limits before a token counter, classifier, allocation, worker, model, or billing effect."
  - "Evidence carries only rule/signal IDs, hashes, counts, versions, and latency class by default."
requirements-completed: [SAFE-01, SAFE-02]
coverage:
  - id: D1
    description: Canonical pre-allocation text admission enforces the immutable Phase 2 limits and redacted stable denials.
    requirement: SAFE-01
    verification:
      - kind: unit
        ref: tests/admission/admission-policy.test.ts#SAFE-01 canonical text admission
        status: pass
    human_judgment: false
  - id: D2
    description: Classifier output is bounded to restrictive-only canonical signals and faults reject before execution.
    requirement: SAFE-02
    verification:
      - kind: unit
        ref: tests/admission/risk-policy.test.ts#SAFE-02 restrictive-only risk policy
        status: pass
    human_judgment: false
metrics:
  duration: 8m
  completed: 2026-08-04
status: complete
---

# Phase 2 Plan 02: Canonical Admission and Restrictive Risk Summary

Canonical NFC text admission uses exact versioned limits, and bounded classifier signals can only preserve a fixed base grant or deny work.

## Performance

- **Duration:** 8 min
- **Started:** 2026-08-04T10:44:57Z
- **Completed:** 2026-08-04T10:52:46Z
- **Tasks:** 2/2
- **Files modified:** 4

## Accomplishments

- Added a strict one-field text envelope that rejects malformed Unicode, controls, non-NFC text, oversized dimensions, and forbidden repository/data/control shapes before any later hook.
- Bound byte, code-point, grapheme, token, line, and per-line metrics to the immutable `phase-02-policy-2026-08-04` policy and emitted hash/count-only evidence.
- Added bounded restrictive-only risk evaluation: hard denials skip the detector; clean output retains the base grant; signals and every detector fault deny without adding authority.

## Task Commits

1. **Task 1: Enforce exact canonical text and limit semantics before allocation**
   - `f124c0f` `test(02-02): add failing admission policy contract`
   - `e2e412b` `feat(02-02): enforce canonical text admission`
2. **Task 2: Make risk signals restrictive-only and fail closed on classifier faults**
   - `ce1eb1d` `test(02-02): add failing restrictive risk contract`
   - `0e0d200` `feat(02-02): fail closed on restrictive risk signals`

## Files Created

- `src/admission/admission-policy.ts` — canonical input checks, metrics, redacted evidence, and injected token-count contract.
- `src/admission/risk-policy.ts` — bounded detector, canonical signal table, subset-only grants, and fault closure.
- `tests/admission/admission-policy.test.ts` — Unicode, fixture-boundary, structure, zero-hook, and evidence coverage.
- `tests/admission/risk-policy.test.ts` — hard-denial precedence, signal, fault, timeout, grant, and evidence coverage.

## Decisions Made

- Kept the source policy fixture immutable and imported instead of duplicating numeric defaults.
- Used the `und` grapheme segmenter contract and exact scalar iteration to avoid locale-dependent interpretation.
- Rejected all recognized risk signals; this is a restrictive-only initial policy and cannot widen authority.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected unpaired-surrogate detection at end of input**
- **Found during:** Task 1
- **Issue:** A missing trailing surrogate produced `NaN`, which was not rejected by a range-only comparison.
- **Fix:** Required the paired code unit to be an integer before accepting a high surrogate.
- **Files modified:** `src/admission/admission-policy.ts`
- **Verification:** `bun test tests/admission/admission-policy.test.ts`
- **Committed in:** `e2e412b`

**Total deviations:** 1 auto-fixed (Rule 1)

## Issues Encountered

`bun test` was run after the scoped verification. It reports an unrelated, concurrently introduced Plan 04 test import failure for `src/worker-port/fake-worker`; both Plan 02 suites pass (31 tests). No Plan 02 files or behavior were changed to address that out-of-scope work.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 06 can compose the admission and risk boundaries before session allocation. The whole-suite failure must be resolved by the owner of Plan 04's missing fake-worker module.

## Self-Check: PASSED

All four scoped files exist and all four RED/GREEN commits are present in Git history.
