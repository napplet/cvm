---
phase: 01-napplet-contract-artifact-verification
plan: 01
subsystem: promotion-verification
tags: [bun, typescript, promotion, hermetic-runner, evidence]
requires: []
provides:
  - "Immutable candidate manifest validation and canonical toolchain identities"
  - "Hermetic argv-only command execution with bounded output and scrubbed environment"
  - "Content-addressed, layered promotion evidence bundles"
affects: [01-02, 01-03, 01-04, promotion, toolchain-provenance]
tech-stack:
  added: [Bun, TypeScript]
  patterns: [immutable-manifest, argv-only-runner, fail-closed-evidence]
key-files:
  created:
    - package.json
    - tsconfig.json
    - src/promotion/schema.ts
    - src/promotion/run-promotion.ts
    - src/runner/hermetic-command.ts
    - src/evidence/bundle.ts
  modified: []
key-decisions:
  - "A passing tracer is review-ready only and has no promoted-pointer mutation path."
  - "Children receive a minimal explicit environment instead of inherited process secrets."
  - "Evidence is content-addressed from complete D-15 layers and rejects missing or altered report links."
patterns-established:
  - "Promotion commands must name a manifest-allowlisted absolute executable and supply literal argv."
  - "Promotion evidence is canonical JSON with a stable SHA-256 identity."
requirements-completed: [GEN-01, GEN-04, SAFE-05]
coverage:
  - id: D1
    description: "Runnable immutable candidate-to-command-to-evidence promotion tracer"
    requirement: GEN-04
    verification:
      - kind: integration
        ref: "bun test tests/tracer.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Hermetic argv execution and D-15 evidence-bundle validation"
    requirement: SAFE-05
    verification:
      - kind: unit
        ref: "bun test tests/runner/hermetic-command.test.ts tests/evidence/bundle.test.ts"
        status: pass
    human_judgment: false
duration: 5 min
completed: 2026-08-03
status: complete
---

# Phase 01 Plan 01: Promotion Tracer and Hermetic Evidence Summary

**Immutable candidate promotion tracer with pinned executable verification, argv-only execution, and content-addressed D-15 evidence bundles.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-08-03T06:54:05Z
- **Completed:** 2026-08-03T06:59:18Z
- **Tasks:** 2/2
- **Files modified:** 10
- **Verification:** `bun test` — 16 passing tests in 1.17 seconds

## Accomplishments

- Added a dependency-free Bun/TypeScript promotion tracer that validates all D-04 identity pins before running a candidate.
- Added a manifest-allowlisted absolute-executable runner with literal argv, empty inherited environment, timeout/output limits, and blocker evidence.
- Added immutable evidence bundles that contain verdict, manifest, native reports, integration links, artifact/golden hashes, reproducibility state, and provenance links.

## Task Commits

1. **Task 1: Run one candidate through the manifest → command → evidence path** — `d118247` (feat)
2. **Task 2: Extract the bounded runner and layered evidence contracts (RED)** — `86251f2` (test)
3. **Task 2: Extract the bounded runner and layered evidence contracts (GREEN)** — `c51c8c2` (feat)

## Files Created/Modified

- `package.json` — Bun test command and runtime floor.
- `tsconfig.json` — strict TypeScript compilation contract.
- `src/promotion/schema.ts` — immutable promotion manifest parsing and canonical identity hashing.
- `src/promotion/run-promotion.ts` — review-only candidate tracer using the extracted contracts.
- `src/runner/hermetic-command.ts` — bounded command runner with command evidence.
- `src/evidence/bundle.ts` — complete, content-addressed D-15 evidence writer and validator.
- `tests/tracer.test.ts` — end-to-end positive and fail-closed tracer coverage.
- `tests/runner/hermetic-command.test.ts` — argv, isolation, secret, timeout, output, egress, resource, and allowlist coverage.
- `tests/evidence/bundle.test.ts` — canonical ordering, report-link integrity, and tamper detection coverage.

## Decisions Made

- Successful candidate runs are `review-ready`, never promoted; the tracer exposes no promoted-pointer mutation.
- The runner executes only manifest-pinned absolute paths and explicitly sets `LANG`/`TZ`; no inherited secret can cross into a child process.
- Evidence bundles are emitted only when every D-15 layer is present, and their SHA-256 digest covers canonical JSON rather than insertion order.

## TDD Gate Compliance

- **RED:** `86251f2` added the missing-module runner/evidence tests, which failed before implementation.
- **GREEN:** `c51c8c2` implemented the runner and bundle modules; all tests pass.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Bun was unavailable at the initial checkpoint. The authorized Bun 1.3.14 installation was verified before this continuation and no project dependency installation was required.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 01-02 through 01-04 can now bind reviewed provenance and the sealed image to the retained `runPromotionCandidate`, `runHermeticCommand`, and `writeEvidenceBundle` seams.
- The candidate remains review-only until the planned provenance review and explicit promotion-state work are complete.

## Self-Check: PASSED

- Confirmed the summary exists and task commits `d118247`, `86251f2`, and `c51c8c2` are present in git history.
