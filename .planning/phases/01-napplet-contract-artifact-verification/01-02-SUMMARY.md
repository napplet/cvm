---
phase: 01-napplet-contract-artifact-verification
plan: 02
subsystem: promotion-verification
tags: [bun, typescript, provenance, candidate-intake, github-actions]
requires:
  - phase: 01-01
    provides: Immutable promotion manifest parsing, canonical toolchain IDs, and bounded argv execution
provides:
  - Immutable, canonical candidate records with explicit readiness blockers
  - A first unverified NIP-5D/toolchain candidate with no guessed CLI provenance
  - Read-only scheduled/manual workflow outputs and an anti-promotion workflow guard
affects: [01-03, 01-04, 01-05, promotion, toolchain-provenance]
tech-stack:
  added: [GitHub Actions workflow]
  patterns: [candidate-only-provenance, canonical-package-sorting, explicit-unverified-facts]
key-files:
  created:
    - src/promotion/candidate.ts
    - toolchains/candidates/initial.json
    - .github/workflows/toolchain-candidate.yml
  modified:
    - package.json
    - tests/promotion/candidate.test.ts
key-decisions:
  - "Candidate identity is computed from canonical package metadata while stage order remains a strict execution contract."
  - "The first candidate remains unverified until exact CLI distribution, source, release-asset, executable, package, image, fixture, and golden evidence exists."
  - "Candidate automation may report IDs and evidence digests but has no install, lifecycle, golden, review, promotion, or current-pointer authority."
patterns-established:
  - "Candidate readiness is a pure validation boundary that parses through the existing promotion schema only after every required fact is complete."
  - "Workflow capability is guarded by a repository test that treats package-install and promotion paths as forbidden."
requirements-completed: [GEN-01, GEN-04, SAFE-05]
coverage:
  - id: D1
    description: "Immutable candidate identity and review-readiness validation"
    requirement: GEN-04
    verification:
      - kind: unit
        ref: "tests/promotion/candidate.test.ts#candidate detection"
        status: pass
    human_judgment: false
  - id: D2
    description: "Read-only scheduled/manual candidate evidence workflow"
    requirement: SAFE-05
    verification:
      - kind: unit
        ref: "bun run candidate:workflow-check"
        status: pass
    human_judgment: false
duration: 5 min
completed: 2026-08-03
status: complete
---

# Phase 01 Plan 02: Immutable Candidate Intake Summary

**Canonical, evidence-bound toolchain candidate detection with explicit provenance blockers and read-only GitHub Actions reporting.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-08-03T07:03:56Z
- **Completed:** 2026-08-03T07:08:42Z
- **Tasks:** 2/2
- **Files modified:** 5
- **Verification:** `bun test` — 21 passing tests in 1.15 seconds

## Accomplishments

- Added a pure candidate detector and readiness verifier that canonicalize package records, preserve the exact seven-stage execution sequence, and reject incomplete or duplicate facts.
- Added the initial NIP-5D candidate as explicitly unverified rather than inferring NAP compatibility or the disputed CLI distribution/source/executable mapping.
- Added scheduled/manual workflow reporting of immutable candidate and evidence digests, with a guard that rejects installation, goldens, review, promotion, and current-pointer authority.

## Task Commits

1. **Task 1: Produce one evidence-bound immutable candidate record (RED)** — `38e504c` (test)
2. **Task 1: Add duplicate-package coverage (RED)** — `37bc5d6` (test)
3. **Task 1: Produce one evidence-bound immutable candidate record (GREEN)** — `bd44c4e` (feat)
4. **Task 2: Automate candidate evidence without granting promotion authority** — `14d1214` (chore)
5. **Task 2: Correct candidate workflow guard** — `aa747e4` (fix)

## Files Created/Modified

- `src/promotion/candidate.ts` — candidate normalization, identity hashing, fail-closed readiness validation, and read-only CLI output.
- `toolchains/candidates/initial.json` — initial NIP-5D candidate with machine-readable unresolved provenance facts.
- `.github/workflows/toolchain-candidate.yml` — scheduled/manual candidate evidence workflow with read-only permissions.
- `tests/promotion/candidate.test.ts` — stage ordering, identity, provenance, NIP/NAP revision, and workflow-authority coverage.
- `package.json` — candidate detection, verification, and workflow-guard commands.

## Decisions Made

- Candidate IDs include all submitted immutable facts and normalized package ordering, so a NIP-5D/NAP/pin change creates a separate review subject.
- No package, executable, release, or protocol capability is guessed: incomplete data is retained as an explicit `unverified` blocker.
- CI writes only workflow outputs; it has read-only repository permission and no promotion path.

## TDD Gate Compliance

- **RED:** `38e504c` and `37bc5d6` added candidate-intake tests before the module existed; `bun test tests/promotion/candidate.test.ts` failed with the expected missing-module error.
- **GREEN:** `bd44c4e` implemented the candidate module and static initial record; all candidate and full-suite tests pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test bug] Corrected non-hex fixture pins and a workflow-guard false positive**
- **Found during:** Tasks 1 and 2
- **Issue:** The first test fixture used non-hex placeholder characters for revision/digest values, and the first workflow guard treated the safe `src/promotion/` module path as promotion authority.
- **Fix:** Replaced invalid test pin characters with valid hexadecimal values and scoped the forbidden-script check to actual install/pointer/promotion-run capabilities.
- **Files modified:** `tests/promotion/candidate.test.ts`
- **Verification:** `bun test`, `bun run candidate:workflow-check`
- **Committed in:** `bd44c4e`, `aa747e4`

---

**Total deviations:** 1 auto-fixed (Rule 1)
**Impact on plan:** The correction strengthened the required fail-closed guard without expanding the candidate or promotion surface.

## Issues Encountered

- The initial candidate correctly remains `unverified`; its returned blockers enumerate missing exact provenance and candidate-image facts for Plan 03 review rather than claiming support.

## Known Stubs

None. The `null` values in `toolchains/candidates/initial.json` are explicit, non-rendered provenance blockers and intentionally prevent review readiness.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 03 can review one immutable candidate ID (`a55da4c5c4bb8d5ead8a922db282f03fea523eda6b7575af0f02b61e208b6da2`) and its explicit blocking evidence without any candidate changing the current promoted set.
- Exact CLI distribution/source/executable mapping, package integrities/source commits, and same-set NAP/conformance evidence remain mandatory before the candidate can become `review_ready`.

## Self-Check: PASSED

- Confirmed all five candidate/workflow files and this summary exist.
- Confirmed task commits `38e504c`, `37bc5d6`, `bd44c4e`, `14d1214`, and `aa747e4` are present in git history.
