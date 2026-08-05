---
phase: 07-admission-slo-resilience-launch-safety
plan: "10"
subsystem: release-certification
tags: [promotion, certification, supply-chain, immutable-evidence, fail-closed, bun]
requires:
  - phase: 07-05
    provides: candidate-bound immutable certification observations and provider-neutral SLO contracts
  - phase: 07-09
    provides: validated 64-case deterministic evidence with protected-live inventory
provides:
  - exact immutable release-certification manifest and D-129 waiver restrictions
  - candidate-scoped concurrency-safe promotion decision gate
  - protected certification inventory that records unavailable topology as blocked evidence
affects: [release-promotion, live-certification, ship]
tech-stack:
  added: []
  patterns: [exact evidence digest binding, candidate-scoped terminal decisions, immutable blocked observations]
key-files:
  created:
    - evidence/certification/fd49b2cd42884f762a687f81958b5ee2385c07e4fa1e6dd7f62fda1fff16fd32/live/*.json
  modified:
    - src/promotion/schema.ts
    - src/promotion/candidate.ts
    - src/promotion/run-promotion.ts
    - scripts/certify-phase-07.ts
    - tests/phase-07/promotion-gate.test.ts
    - package.json
key-decisions:
  - "A release promotion can replay only an identical candidate-plus-evidence decision; changed evidence is blocked rather than replacing the terminal result."
  - "The no-profile protected run records all suites as blocked and final candidate verification remains nonzero; deterministic evidence cannot stand in for live certification."
  - "D-129 safety, SLO, custody, and live-certification classes remain non-waivable."
patterns-established:
  - "Release manifests retain only immutable revisions and digests; raw topology data, credentials, and provider output never become gate inputs."
  - "Protected certification records are content-addressed and candidate-bound even when prerequisites are unavailable."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Exact release inputs, freshness, non-waivable classes, stale/cross-candidate rejection, and concurrent decisions are fail-closed.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: tests/phase-07/promotion-gate.test.ts#manifest and evidence gate tests
        status: pass
    human_judgment: false
  - id: D2
    description: The protected runner writes an inventory for every unavailable live suite without exposing secrets or returning a release pass.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: bun run certify:phase07 -- --profile=release --preflight-only
        status: pass
    human_judgment: false
  - id: D3
    description: Actual Modal/Fly, Cloud Run/SQL/GCS, ContextVM/CEP-8/payment/model, host/signer, CLI/upload/relay, and Collector certification remains a protected human-operated release exercise.
    requirement: OPS-04
    verification:
      - kind: manual_procedural
        ref: bun run certify:phase07 -- --profile=release --suite=all
        status: unknown
    human_judgment: true
    rationale: Protected credentials and the exact release topology are unavailable locally; recorded observations are blocked and cannot certify promotion.
metrics:
  duration: 34m
  completed: 2026-08-05
status: complete
---

# Phase 07 Plan 10: Immutable Release Certification Summary

**An immutable, candidate-scoped promotion gate now requires exact supply-chain inputs and fresh protected evidence, while this environment truthfully retains all live certification as blocked.**

## Performance

- **Duration:** 34m
- **Completed:** 2026-08-05T17:04:23Z
- **Tasks:** 3/3
- **Files modified:** 39 (six code/test/config files, one tracer assertion, and 32 immutable protected observations)

## Accomplishments

- Added strict release manifest parsing for source, control/worker images, package lock/toolchain, migration, configuration, policy, dataset, golden, SBOM, provenance, evidence requirements, freshness, and bounded waivers.
- Added an atomic candidate-scoped decision that replays only an identical evidence set and blocks stale, mutated, cross-candidate, duplicate-claim, non-pass, or replaced evidence before any promoted result.
- Replaced the deferred terminal promotion stage with a required release-certification stage and a final `candidate:verify --release-evidence` check.
- Implemented the protected suite preflight. The local no-profile run recorded **32 blocked, 0 passed** protected observations across repeated complete eight-suite inventories. The existing deterministic corpus remains **64 passed offline cases** with `promotionVerdict: blocked`.

## Task Commits

1. **Task 1: Complete the immutable supply-chain and release-certification manifest** — `02f791b` (RED), `344ef7f` (GREEN)
2. **Task 2: Run every protected live integration or emit immutable blocking evidence** — `18bba15` (implementation), `89561aa` (blocked evidence)
3. **Task 3: Promote exactly one fully certified candidate and fail closed otherwise** — `ac83ed8` (RED), `bb64069` and `789a9c4` (GREEN)
4. **Compatibility correction** — `b6828e8` (fix)

## Files Created/Modified

- `src/promotion/schema.ts` — strict release input, requirement, and waiver schemas with non-waivable D-129 classes.
- `src/promotion/run-promotion.ts` — freshness/input-bound certification evaluator and one candidate terminal decision.
- `src/promotion/candidate.ts` — final deterministic-pointer validation that blocks absent protected certification.
- `scripts/certify-phase-07.ts` — secret-safe protected suite inventory writer for `--profile`, `--suite`, and `--preflight-only`.
- `tests/phase-07/promotion-gate.test.ts` — manifest, waiver, mutation, stale, cross-candidate, concurrency, blocked-preflight, and final-verifier oracles.
- `evidence/certification/fd49b2cd42884f762a687f81958b5ee2385c07e4fa1e6dd7f62fda1fff16fd32/live/` — 32 canonical blocked no-profile observations.

## Decisions Made

- A passed deterministic record is mandatory but never a live-certification substitute.
- Modal and Fly selection remains unset until identical protected benchmark evidence is fresh, complete, and proves the five-second p95/zero-backlog contract.
- Original-operation reconciliation and user-key non-custody are never represented as waivable release exceptions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated promotion tracer terminology after replacing the deferred gate.**
- **Found during:** Full-suite verification
- **Issue:** The established tracer expected the removed `certification-deferred` stage instead of the concrete `certification-required` blocker.
- **Fix:** Updated only the direct tracer assertions; blocked status and no-promotion behavior remain unchanged.
- **Files modified:** `tests/tracer.test.ts`
- **Verification:** Focused tracer test and full Bun suite passed.
- **Committed in:** `b6828e8`

**Total deviations:** 1 auto-fixed Rule 1 correction. No scope expansion or live pass was introduced.

## Issues Encountered

Protected credentials and release topology are unavailable in this environment. This is expected release-blocking state, not a failed deterministic implementation: the runner wrote complete immutable `blocked` observations and exited nonzero.

## User Setup Required

Before a promotion may be attempted, an operator must provide the versioned release profile and protected credential bundle named in `07-10-PLAN.md`, provision the exact declared topology, then run `bun run certify:phase07 -- --profile=release --suite=all`. A no-profile, blocked, stale, skipped, or not-observed result must not be approved.

## Known Stubs

None. The protected integrations are deliberately represented by release-blocking observations, not empty or mock data paths.

## Next Phase Readiness

The deterministic and promotion logic is green. Release remains blocked until fresh, exact, executed protected observations cover all eight suites; only then can a candidate reach the sole promoted decision path.

## Self-Check: PASSED

- All declared source, runner, test, package, and summary files exist.
- Task commits `02f791b`, `344ef7f`, `18bba15`, `89561aa`, `ac83ed8`, `bb64069`, `789a9c4`, and `b6828e8` exist.
- `bun test --timeout 10000` passed: 468 tests, 0 failures.
