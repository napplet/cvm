---
phase: 07-admission-slo-resilience-launch-safety
plan: "18"
subsystem: security
tags: [release-promotion, trust-root, sha256, certification]
requires:
  - phase: 07-17
    provides: "pre-cache certification authentication and a pinned trust-root loader"
provides:
  - "Operator-only protected release verification command with a containment-checked SHA-256-pinned trust root"
  - "Counterfeit bundle regression proving candidate authority cannot promote or reach evaluator/cache authority"
affects: [release-promotion, phase-07-certification]
tech-stack:
  added: []
  patterns: ["Load protected authority before candidate bundle bytes", "Public release verification remains rootless"]
key-files:
  created: [scripts/verify-phase-07-release.ts]
  modified: [src/certification/trust.ts, src/promotion/candidate.ts, package.json, tests/phase-07/promotion-gate.test.ts]
key-decisions:
  - "The protected command hard-codes the root authority source to absolute operator configuration and loads it before bundle I/O."
  - "The existing public candidate verifier remains rootless and therefore fails closed for release evidence."
patterns-established:
  - "Protected entrypoints own their digest-pinned trust root rather than accepting caller-provided certifier objects."
requirements-completed: []
coverage:
  - id: D1
    description: "Protected promotion composes an operator-pinned root with the sole certification evaluator."
    requirement: OPS-04
    verification:
      - kind: integration
        ref: "tests/phase-07/promotion-gate.test.ts#the protected release command owns a pinned root"
        status: pass
    human_judgment: false
  - id: D2
    description: "Public and unconfigured protected release commands fail closed without protected-live authority."
    requirement: OPS-04
    verification:
      - kind: integration
        ref: "bun run candidate:verify -- --release-evidence evidence/design/phase-07.json; bun run release:verify:protected -- --release-evidence evidence/design/phase-07.json"
        status: pass
    human_judgment: false
duration: 6min
completed: 2026-08-05
status: complete
---

# Phase 07 Plan 18: Protected Promotion Composition Summary

**Operator-owned release verification now loads a containment-checked SHA-256-pinned certifier root before evaluating any candidate bundle.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-08-05T21:52:39Z
- **Completed:** 2026-08-05T21:58:05Z
- **Tasks:** 1/1
- **Files modified:** 5

## Accomplishments

- Added `release:verify:protected`, which accepts only explicit relative release evidence and absolute, digest-pinned operator trust-root configuration.
- Generalized the shared loader to recognize the release-root export while preserving the reproducibility-root alias and its containment, symlink, file, and digest controls.
- Proved a fully rehashed counterfeit manifest, observations, and verification records cannot select its permissive fake root, pass authentication, reuse authority, or emit a protected-live claim.

## Task Commits

1. **Task 1: Add the operator-owned protected promotion composition** - `7b141d5` (test), `41bae15` (feat)

## Files Created/Modified

- `scripts/verify-phase-07-release.ts` - protected operator command and finite fail-closed responses.
- `src/certification/trust.ts` - recognizes the pinned release-root export through the shared loader.
- `src/promotion/candidate.ts` - exports the narrow bundle verification seam; public CLI still supplies no root.
- `package.json` - exposes `release:verify:protected`.
- `tests/phase-07/promotion-gate.test.ts` - exercises valid composition, cache replay, counterfeit authority, and root/config mutations.

## Decisions Made

- The command loads its root before opening release evidence, so candidate-controlled bytes cannot cause selection or execution of certifier authority.
- OPS-04 remains pending at phase level: no protected-live evidence was created, accepted, or claimed by this plan.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

The new `package.json` command invalidated the intentionally full-file OpenTelemetry approval snapshot. GSD debug session `otel-approval-digest-drift` renewed the content-addressed delegated approval and generated a fresh real Collector smoke record without weakening drift detection (`e6714b6`). Final convergence, including promotion-time source remeasurement and the cross-archive substitution fix (`769fcc0`, `2806dd5`), passes 518 tests with zero failures.

## User Setup Required

None - production use requires the existing operator-controlled `PHASE07_RELEASE_TRUST_ROOT_DIRECTORY`, `PHASE07_RELEASE_TRUST_ROOT`, and `PHASE07_RELEASE_TRUST_ROOT_SHA256` configuration; this plan intentionally does not create or populate it.

## Next Phase Readiness

The protected promotion composition gap is closed. Genuine protected-live observations and the pending launch-risk decision remain required before Phase 07 can make a protected-live or production-promotion claim.

## Self-Check: PASSED

Verified the five plan files exist and both TDD commits (`7b141d5`, `41bae15`) are reachable in git history.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-05*
