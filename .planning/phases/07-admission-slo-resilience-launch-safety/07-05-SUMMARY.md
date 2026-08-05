---
phase: 07-admission-slo-resilience-launch-safety
plan: "05"
subsystem: certification
tags: [worker, modal, fly, admission-slo, immutable-evidence]
requires:
  - phase: 07-01
    provides: Receipt-to-exact-ready admission samples with zero-backlog enforcement
provides:
  - Candidate-bound immutable certification observations and bundles
  - Provider-neutral Modal/Fly exact-ready cohort benchmark and confidence gate
  - Candidate-only Fly WorkerPort implementation with blocked credential evidence
affects: [07-10, promotion, live-certification]
tech-stack:
  added: []
  patterns: [content-addressed certification evidence, provider-neutral worker benchmark]
key-files:
  created: [src/certification/contracts.ts, src/certification/evidence.ts, src/worker-adapters/fly-worker.ts]
  modified: [src/admission/benchmark.ts, src/worker-adapters/modal-worker.ts, tests/phase-07/worker-benchmark.test.ts]
key-decisions:
  - "Deterministic evidence may report a passing SLO calculation but always remains unselected; only protected live observations can own selection claims."
  - "Modal and Fly remain injected WorkerPort variants with an identical immutable schedule and no provider-native domain authority."
requirements-completed: [SESS-02, OPS-04]
coverage:
  - id: D1
    description: Immutable candidate/input/freshness-bound certification records reject mutation, stale claims, and pointer overwrite.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: tests/phase-07/worker-benchmark.test.ts#certification evidence
        status: pass
    human_judgment: false
  - id: D2
    description: Modal and Fly use one exact-ready schedule and fail-closed SLO confidence/cohort gate without selecting either provider.
    requirement: SESS-02
    verification:
      - kind: integration
        ref: bun test tests/phase-07/worker-benchmark.test.ts tests/integration/modal-probe.test.ts --timeout 10000
        status: pass
    human_judgment: false
metrics:
  duration: 7m
  completed: 2026-08-05
status: complete
---

# Phase 07 Plan 05: Provider-Neutral Worker Certification Summary

**Immutable certification evidence and a shared Modal/Fly receipt-to-exact-ready benchmark now fail closed without selecting a vendor from fixture results.**

## Performance

- **Duration:** 7m
- **Started:** 2026-08-05T15:58:49Z
- **Completed:** 2026-08-05T16:05:08Z
- **Tasks:** 2/2
- **Files modified:** 7

## Accomplishments

- Added canonical, content-addressed certification observations that bind candidate, image/source, benchmark inputs, command, timestamps, claims, limitations, and finite status reasons.
- Added a generic exact-ready benchmark schedule covering pool-hit/miss, cold, step-load, contention, reclaim, ambiguity, cleanup, and failure cohorts with p50/p95/p99 and deterministic bootstrap upper-p95 facts.
- Added a candidate-only injected Fly adapter and strengthened Modal probe evidence with immutable-image, exact-session lease, cleanup, and remaining-lifetime facts.

## Task Commits

1. **Task 1: Make certification observations immutable, finite, fresh, and candidate-bound** — `67105ac`
2. **Task 2: Compare Modal and Fly through one exact-ready load and selection oracle** — `6f28a5c`

## Decisions Made

- A computed SLO pass remains `unselected`; Plan 07-10 requires fresh protected live claim-bearing evidence before selection.
- Missing Fly credentials yield canonical `blocked` evidence and no client construction, rather than an inferred pass or alternate provider.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 1 - Bug] Avoided Zod refined-schema omission during immutable observation construction**
   - **Found during:** Task 1
   - **Fix:** Exported and parsed the input schema directly before adding the computed evidence digest.
   - **Committed in:** `67105ac`

2. **[Rule 1 - Bug] Ensured deterministic schedules cover every required cohort**
   - **Found during:** Task 2
   - **Fix:** Extended the fixed schedule and enforced complete cohort presence before an SLO result can pass.
   - **Committed in:** `6f28a5c`

## Known Stubs

None. Protected live credentials/topology are intentionally not synthesized; absent-provider paths produce explicit blocked evidence.

## Next Phase Readiness

Plan 07-10 can consume this contract to write protected live observations. Both provider candidates remain unselected until that evidence is fresh, complete, and meets the locked sample, confidence, readiness, cleanup, isolation, and zero-backlog gates.

## Self-Check: PASSED

- Verified task commits `67105ac` and `6f28a5c` exist.
- Verified all created certification and Fly adapter files exist.
