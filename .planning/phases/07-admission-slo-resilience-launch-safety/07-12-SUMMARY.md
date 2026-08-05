---
phase: 07-admission-slo-resilience-launch-safety
plan: "12"
subsystem: certification-and-promotion
tags: [typescript, zod, sha256, release-certification, fail-closed]
requires:
  - phase: 07-10
    provides: immutable certification observations and release evaluator
  - phase: 07-11
    provides: digest-bound approval enforcement
provides:
  - digest-verified, typed protected-suite adapter dispatch
  - exact release-bundle parsing routed to the sole certification evaluator
affects: [phase-07-goal-verification, protected-live-certification, promotion]
tech-stack:
  added: []
  patterns: [trusted-root module loading, finite redacted adapter evidence, explicit release evidence pointers]
key-files:
  created: [src/certification/adapters.ts, src/certification/runner.ts, tests/phase-07/certification-runner.test.ts]
  modified: [src/certification/contracts.ts, scripts/certify-phase-07.ts, src/promotion/candidate.ts, tests/phase-07/promotion-gate.test.ts]
key-decisions:
  - "Only a canonical regular module under a configured trusted root with a profile-bound SHA-256 may supply protected-live adapters."
  - "Adapter output is a strict finite result; registry-owned evidence class prevents fixture passes from becoming live certification."
  - "Release CLI accepts only explicit deterministic and protected observation pointers, then delegates its one terminal decision to evaluateReleaseCertification."
patterns-established:
  - "Preflight records every requested suite as non-pass without loading or invoking an adapter."
  - "All-suite success requires exactly one fresh passed record for every closed release claim."
requirements-completed: []
coverage:
  - id: D1
    description: Protected adapter dispatch and fail-closed preflight behavior
    verification:
      - kind: unit
        ref: tests/phase-07/certification-runner.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Exact release-bundle promotion decision wiring
    verification:
      - kind: integration
        ref: tests/phase-07/promotion-gate.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Real protected certification and promotion
    verification:
      - kind: manual_procedural
        ref: bun run certify:phase07 -- --profile=release --suite=all
        status: unknown
    human_judgment: true
    rationale: Provisioned release topology and scoped credentials are unavailable locally; no fixture output is a live pass.
duration: 3 min
completed: 2026-08-05
status: complete
---

# Phase 07 Plan 12: Protected Certification and Release Bundle Summary

**Typed, digest-pinned protected adapters and an exact immutable release-bundle verifier now reach the sole promotion evaluator without turning local fixtures into live evidence.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-08-05T19:29:31Z
- **Completed:** 2026-08-05T19:31:50Z
- **Tasks:** 3/3
- **Files modified:** 7

## Accomplishments

- Added a closed protected-suite registry, finite result schema, redacted runner, and canonical regular-file/digest loader.
- Made preflight inventory-only and made all-suite success contingent on complete one-pass-per-claim coverage.
- Added strict release-bundle parsing with explicit evidence pointers and delegated valid bundles to `evaluateReleaseCertification` exactly once.

## Task Commits

1. **Task 1: Dispatch the closed protected-suite adapter registry** — `0d55bfa` (feat)
2. **Task 2: Feed an exact release bundle into the sole promotion decision** — `e3f2adc` (feat)
3. **Task 3: Seal regression and evidence behavior** — `6fbf5c2` (fix)

## Files Created/Modified

- `src/certification/adapters.ts` — trusted-root, SHA-256-verified adapter module loader and registry contract.
- `src/certification/runner.ts` — suite dispatch, finite status mapping, preflight, and all-suite claim coverage gate.
- `src/certification/contracts.ts` — closed suite and safe adapter-result schemas.
- `scripts/certify-phase-07.ts` — fail-closed release CLI composition.
- `src/promotion/candidate.ts` — strict release-bundle verifier feeding the sole evaluator.
- `tests/phase-07/certification-runner.test.ts` and `tests/phase-07/promotion-gate.test.ts` — local contract coverage.

## Decisions Made

- Untrusted adapter code is loaded only after canonical containment, regular-file, no-symlink, and exact digest checks.
- A fake registry can prove behavior only as deterministic evidence, never as a protected-live observation.
- A deterministic Phase 7 pointer remains provenance only; a complete explicitly named protected observation set is required for a promotion decision.

## Verification

- `bun test --timeout 10000` — passed (492 tests).
- `bun run eval:phase07` and `bun run verify:phase07-evidence -- --verify-existing` — passed.
- Credential-free `certify:phase07 -- --profile=release --preflight-only` — correctly blocked/nonzero.
- Credential-free `candidate:verify -- --release-evidence evidence/design/phase-07.json` — correctly blocked/nonzero.

## Deviations from Plan

None - plan executed as specified. The all-suite claim-completeness check was included as required release safety behavior.

## Issues Encountered

No `typecheck` package script exists; focused and full Bun test suites are the configured executable checks.

## User Setup Required

Provide the release profile, trusted adapter root/module/digest, and access-controlled credential reference named by the plan before protected certification can record live passes.

## Known Stubs

None. The credential-free environment is explicitly represented by blocked evidence, not a placeholder success path.

## Next Phase Readiness

All local safety gates are green. Phase 7 and `SESS-02` / `OPS-01`–`OPS-04` remain unverified until a provisioned topology produces fresh exact protected-live observations and Phase 7 goal verification is rerun.

## Self-Check: PASSED

- Required source, runner, and test files exist.
- Task commits `0d55bfa`, `e3f2adc`, and `6fbf5c2` exist.
