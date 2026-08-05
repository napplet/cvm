---
phase: 07-admission-slo-resilience-launch-safety
plan: "16"
subsystem: security
tags: [certification, reproducibility, supply-chain, promotion, content-addressed-evidence]
requires:
  - phase: 07-15
    provides: Redacted reproducibility and supply-chain verification records
provides:
  - Protected supply-chain claim ownership bound to explicit verified record references
  - Sole release evaluator revalidation of paired protected records and observation digests
affects: [promotion, protected-certification, release-evidence]
tech-stack:
  added: []
  patterns: [profile-named-record-loading, independent-release-record-revalidation]
key-files:
  created: []
  modified:
    - src/certification/adapters.ts
    - src/certification/runner.ts
    - scripts/certify-phase-07.ts
    - src/promotion/run-promotion.ts
    - src/promotion/candidate.ts
    - tests/phase-07/certification-runner.test.ts
    - tests/phase-07/promotion-gate.test.ts
key-decisions:
  - "Protected supply-chain authority requires two profile-named, digest-pinned record files before adapter invocation."
  - "The sole evaluator independently validates both redacted records and requires the supply-chain observation to echo their exact digests."
patterns-established:
  - "Release bundles explicitly name every content-addressed verification record; no ambient discovery or generic adapter claim can replace one."
  - "Credential-free preflight writes only ephemeral blocked records outside canonical evidence."
requirements-completed: [OPS-04]
coverage:
  - id: D1
    description: Protected supply-chain certification refuses generic adapter claims without exact paired verification records.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/phase-07/certification-runner.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Exact release bundles and the sole evaluator require independently revalidated reproducibility and supply-chain records.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/phase-07/promotion-gate.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 11m
  completed: 2026-08-05
  status: complete
---

# Phase 07 Plan 16: Protected Release Record Integration Summary

**Protected certification and promotion now require explicit, independently revalidated reproducibility and supply-chain records before any supply-chain release claim can pass.**

## Performance

- **Duration:** 11m
- **Started:** 2026-08-05T20:34:37Z
- **Completed:** 2026-08-05T20:45:37Z
- **Tasks:** 2/2
- **Files modified:** 10

## Accomplishments

- Profile-bound protected certification loads only two explicitly named, path-contained, digest-checked record files, validates them before adapter invocation, and persists only their verification digests.
- Supply-chain adapters must echo the independently derived paired digests; generic passes, missing records, drift, malformed data, stale records, and swapped bindings remain non-pass.
- Exact release bundles name both record pointers. The sole evaluator revalidates their candidate, release, artifact, content, and freshness bindings before considering the claim inventory.
- Credential-free preflight remains blocked and uses ephemeral output; canonical candidate verification remains nonzero without protected records.

## Task Commits

1. **Task 1: Require verified record references in the protected supply-chain suite** - `3d5d4e6` (test), `c9b57d4` (feat), `3ec8c56` (fix)
2. **Task 2: Require independent record validation in the sole release evaluator** - `c503c44` (test), `1776310` (feat)
3. **Preflight output correction** - `a8f47c0` (fix)

## Files Created/Modified

- `src/certification/adapters.ts` - loads only named, contained, regular, digest-checked record files.
- `src/certification/contracts.ts` - carries finite paired verification-digest contracts.
- `src/certification/reproducibility.ts` - revalidates persisted redacted reproducibility records at authority boundaries.
- `src/certification/supply-chain.ts` - timestamps and revalidates persisted redacted supply-chain records.
- `src/certification/runner.ts` - prevents a protected supply-chain adapter from running or claiming authority without matched records.
- `scripts/certify-phase-07.ts` - parses explicit protected record references and keeps unconfigured preflight output ephemeral.
- `src/promotion/run-promotion.ts` - makes paired-record validation and observation binding a precondition of the sole promotion decision.
- `src/promotion/candidate.ts` - parses exact record pointers and loads them for sole-evaluator validation.
- `tests/phase-07/certification-runner.test.ts` - covers generic adapter denial before invocation.
- `tests/phase-07/promotion-gate.test.ts` - covers missing, deterministic, stale, swapped, and mismatched record bypasses.

## Decisions Made

- Verification records are references named by the protected profile or release bundle, never directory-discovered inputs.
- The persisted supply-chain observation contains only the two derived record digests; raw protected documents, paths, command output, and identities remain outside it.
- Candidate promotion can succeed in an ephemeral test fixture only when the test records, release manifest, supply-chain observation, and pointers all agree.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected the protected-record path matcher syntax**
- **Found during:** Task 1 preflight verification
- **Issue:** Escaped delimiters made the new matcher invalid TypeScript, preventing the certification CLI from parsing.
- **Fix:** Replaced it with a valid relative-path matcher.
- **Files modified:** `scripts/certify-phase-07.ts`
- **Verification:** Protected preflight remained blocked and focused runner tests passed.
- **Committed in:** `3ec8c56`

**2. [Rule 2 - Correctness] Kept unconfigured preflight records out of canonical evidence**
- **Found during:** Task 2 verification
- **Issue:** A credential-free preflight could write blocked output under the canonical evidence tree.
- **Fix:** Routed only the unconfigured preflight default to an ephemeral temporary directory; configured evidence directories retain their explicit behavior.
- **Files modified:** `scripts/certify-phase-07.ts`
- **Verification:** Focused suite and full suite passed; preflight exited nonzero with finite blocked evidence.
- **Committed in:** `a8f47c0`

---

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 2)
**Impact on plan:** Both changes preserve fail-closed protected certification and prevent a blocked local preflight from contaminating canonical evidence.

## Issues Encountered

- The non-mutating existing-evidence verifier passed. Rebuilding canonical design evidence remains intentionally unavailable from the current dirty workspace, so no new canonical evidence was claimed.
- The prior Plan 07-15 OpenTelemetry fixture concern was not reproducible: the final full suite passed all OTel cases and all 506 tests.

## User Setup Required

Protected live certification remains blocked until the profile provides the trusted record root, two exact record paths and content digests, the protected adapter module, and protected credentials. This plan does not run builds, Cosign, or publication.

## Next Phase Readiness

Release authority now fails closed at its concrete protected entrypoints. Missing live protected records remain an explicit external blocker to actual production promotion.

## Known Stubs

None.

## Self-Check: PASSED

- All ten task files and the SUMMARY exist.
- TDD RED/GREEN commits `3d5d4e6`, `c9b57d4`, `c503c44`, and `1776310` exist; corrective commits `3ec8c56` and `a8f47c0` also exist.
- Final full suite: 506 passed, 0 failed.
