---
phase: 07-admission-slo-resilience-launch-safety
plan: "22"
subsystem: release-certification
tags: [certifier, materialization, trust-root, sha256, bun]
requires:
  - phase: 07-21
    provides: Authorized provider topology and controller transition contracts
  - phase: 07-18
    provides: Digest-pinned protected trust-root loader and promotion composition
provides:
  - Candidate-bound, canonical protected certifier profile/config/adapter inputs
  - Repository-owned, digest-pinned trust-root bundle finalization from strict evidence facts
affects: [protected-certification, release-promotion, phase-07-launch]
tech-stack:
  added: []
  patterns: [candidate-addressed-materialization, in-memory-config-environment, repository-owned-bundles]
key-files:
  created: [src/release/materialize-certifier.ts, tests/release/materialize-certifier.test.ts]
  modified: [src/certification/config.ts, src/certification/adapters.ts, src/certification/trust.ts]
key-decisions:
  - "Pre-certification materialization creates only non-authoritative candidate-addressed bytes and returns the config pin in memory."
  - "Final trust bundles contain repository-owned constructor code plus independently validated material facts; fixture records never become release evidence."
patterns-established:
  - "Generated artifacts are canonical exclusive files and every resume detects byte mutation before reuse."
  - "Protected evidence and source archives must be remeasured against the exact candidate, release binding, topology, and authorization tuple."
requirements-completed: [OPS-04]
coverage:
  - id: D1
    description: Candidate-bound config, release profile, secret references, evidence root, and self-contained adapter bundle are generated without provider or runner invocation.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/release/materialize-certifier.test.ts#materializes a candidate-bound local config profile adapter bundle secret references and evidence tree
        status: pass
    human_judgment: false
  - id: D2
    description: Finalization accepts only matching protected-live records and a remeasured source archive before emitting a pinned project-owned trust root.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/release/materialize-certifier.test.ts#finalizes a project-owned candidate-bound trust root from exact local protected-record fixtures
        status: pass
    human_judgment: false
metrics:
  duration: 12m
  completed: 2026-08-06
  status: complete
---

# Phase 07 Plan 22: Protected Certifier Materialization Summary

**Candidate-bound certifier inputs and a separately pinned repository-owned trust root can now be produced locally without hand-authored protected files, credential values, provider calls, or protected-suite execution.**

## Performance

- **Duration:** 12m
- **Started:** 2026-08-06T11:28:00Z
- **Completed:** 2026-08-06T11:39:59Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added the sole materializer for canonical profile, protected config/digest, scoped secret-reference manifest, candidate-specific evidence directory, and digest-pinned self-contained adapter bundle.
- Added post-certification trust finalization that rehashes the source archive and validates exact candidate/release-bound protected records before bundling the repository-owned root constructor.
- Kept the materialization path entirely local: tests use temporary roots and assert zero provider/protected-runner calls; no fixture authority is placed in a release evidence tree.

## Task Commits

1. **Task 1: Materialize the release profile, certifier config, adapter bundle, and evidence tree** — `650d0e1` (test), `b4a5f95` (feat)
2. **Task 2: Finalize candidate-bound trust-root material from executed evidence** — `0155c1c` (test), `0482159` (feat)

## Files Created/Modified

- `src/release/materialize-certifier.ts` — canonical two-stage certifier and trust-root materialization with mutation detection.
- `src/certification/config.ts` — validates controller provenance, secret-reference, and generated-artifact fields.
- `src/certification/adapters.ts` — exposes the project-owned protected adapter bundle entrypoint.
- `src/certification/trust.ts` — exposes the repository-owned material-backed trust-root constructor.
- `tests/release/materialize-certifier.test.ts` — isolated generation, mutation, candidate-binding, archive, and zero-call coverage.

## Decisions Made

- The materializer returns `NAPPLET_CVM_CERTIFIER_CONFIG` and its SHA-256 in memory; no user environment edit or hand-authored protected JSON is required.
- Pre-certification artifacts are not authority. Only finalization with exact protected-live, candidate-bound facts produces a root module, and it remains fail-closed under the existing loader.

## Verification

- Focused materialization/config: 7 passed.
- Focused trust/promotion-root regressions: 9 passed.
- Full suite: 536 passed, 0 failed.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - this plan intentionally performs no protected execution, provisioning, promotion, or release-evidence installation.

## Next Phase Readiness

Plan 07-25 can consume the generated in-memory config pin only after the Plan 07-20 authorization gate and genuine protected outputs are available. Local fixtures remain non-authoritative.

## Known Stubs

None.

## Self-Check: PASSED

- Task commits `650d0e1`, `b4a5f95`, `0155c1c`, and `0482159` exist in Git history.
- All created/modified materializer, certification, and test files exist.
- Focused and full automated suites passed.
