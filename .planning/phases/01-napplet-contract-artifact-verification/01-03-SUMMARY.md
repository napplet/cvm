---
phase: 01-napplet-contract-artifact-verification
plan: 03
subsystem: toolchain-provenance
tags: [bun, typescript, npm-registry, github-releases, napplet, provenance]
requires:
  - phase: 01-02
    provides: Immutable candidate record, evidence digesting, and read-only candidate workflow
provides:
  - Human-approved immutable pre-install provenance candidate
  - Separate pre-intake provenance and final D-04 promotion-manifest validation contracts
  - Exact package and standalone Linux CLI provenance facts retained with evidence-origin digests
affects: [01-04, sealed-toolchain, promotion, toolchain-intake]
tech-stack:
  added: []
  patterns: [two-stage-provenance-review, deferred-d04-promotion-pins, standalone-cli-release-binding]
key-files:
  created:
    - .planning/phases/01-napplet-contract-artifact-verification/01-03-SUMMARY.md
  modified:
    - src/promotion/candidate.ts
    - tests/promotion/candidate.test.ts
    - toolchains/candidates/initial.json
    - .github/workflows/toolchain-candidate.yml
key-decisions:
  - "Pre-install approval is limited to one sealed candidate intake/testing subject and cannot authorize promotion or a current-pointer mutation."
  - "The final D-04 PromotionManifest remains strict; NAP, frozen lockfile, image, browser, fixture, golden, and image-local stage facts are produced and verified only by Plans 04-11."
  - "@napplet/sdk@0.27.2 is bound to the official Version Packages release commit because the repository has no matching SDK tag; its registry integrity and source-version evidence remain explicit review facts."
patterns-established:
  - "Validate review-scope provenance without attempting to parse or weaken the later production promotion manifest."
  - "Use the standalone Linux GitHub release asset and its published checksum rather than the npm CLI placeholder."
requirements-completed: [GEN-01, GEN-04, SAFE-05]
coverage:
  - id: D1
    description: Complete pre-install provenance candidate with exact package, NIP-5D, and standalone CLI facts
    requirement: GEN-04
    verification:
      - kind: unit
        ref: bun run candidate:verify -- toolchains/candidates/initial.json --review-ready
        status: pass
    human_judgment: true
    rationale: A human must approve or quarantine the exact package and release provenance mappings.
  - id: D2
    description: Read-only candidate verification workflow and deferred D-04 validation boundary
    requirement: SAFE-05
    verification:
      - kind: unit
        ref: tests/promotion/candidate.test.ts
        status: pass
      - kind: unit
        ref: bun run candidate:workflow-check
        status: pass
    human_judgment: false
duration: 7 min
completed: 2026-08-03
status: complete
---

# Phase 01 Plan 03: Review Exact Napplet Candidate Provenance Summary

**Human-approved, evidence-bound pre-install provenance for one napplet package set and standalone Linux CLI release, with final promotion pins deferred to their producing plans.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-08-03T07:54:00Z
- **Completed:** 2026-08-03T08:01:30Z
- **Tasks:** 1/1
- **Files modified:** 5

## Accomplishments

- Corrected the candidate boundary so review validates NIP-5D, all five package identity/source facts, and the standalone Linux CLI release before any intake.
- Recorded human approval of candidate `2dbf448be962e289c962fd5b3659bf526232ded9de163c485925618cead1f23e` with evidence digest `56a2be37420132426c62fc78408fb4c3364ae08ae9e1cb82451be0f45d73f2f5`.
- Preserved strict final D-04 parsing: NAP selection, frozen lockfile, scaffold/image/browser materialization, fixtures, goldens, and image-local stage paths remain required before promotion.

## Approved Provenance Subject

approved: 2dbf448be962e289c962fd5b3659bf526232ded9de163c485925618cead1f23e

| Subject | Exact identity | Source binding |
| --- | --- | --- |
| NIP-5D | `eb45dfd7335b7f88cb53781984c553581d2b4c34` | Official `nostr-protocol/nips` commit evidence |
| `@napplet/skills` | `0.3.1` / `sha512-jL1pvjKV8wd1H+BHWWpKhzK5xxpKS946gr1gdzQRux16oVpgWFIXrHfd3eqC14oLRFmsaYsGub+056G+4PMoDQ==` | `napplet/web@dc1d24153c759152b6ba31a6ec9bea967798f2df` |
| `@napplet/boilerplate` | `0.3.1` / `sha512-Xh7Ik9HM7j8G/w7/bCFJY080h2t6DgQPTGCiRwOYqc1oU2TUFUaSsmmzR6WOXoBA0vjpcgnCr8Wg143hAMB/cA==` | `napplet/web@60889f1c2476e063500c7ab6624af6abe0dbcbe5` |
| `@napplet/sdk` | `0.27.2` / `sha512-/5j2SrAc+mNoEFCGeRE+vZtCmzCZE6tvcWCXi2sokVKedvcl8Pj+2/+xwlJY5qWrkYwK/v7d49jThyr2xypH4w==` | `napplet/web@dc1d24153c759152b6ba31a6ec9bea967798f2df` release-commit mapping |
| `@napplet/vite-plugin` | `0.14.1` / `sha512-WIs5CP9+lWOOuuItlO39tjvlWxuFJmb1xLyXcuM6BlV9LTmbO2bAkU1mXcz9G0mPSRQnxzTRf4RckP9J0O6Yug==` | `napplet/web@dc1d24153c759152b6ba31a6ec9bea967798f2df` |
| `@napplet/conformance-cli` | `0.2.18` / `sha512-cWN6XRohN8iE+2xuaTh4LxBOj2iLkGhyCjsV+1g7TGNaj4hkEp+u792dX1eA2vFIVa/k1qR9QAZHO0jkzPdONw==` | `napplet/web@03ad65b66413e5798536ef48695ffc4c2508f2c3` |
| standalone CLI | `napplet` `0.5.1`, `napplet-linux-x86_64`, SHA-256 `c533b129f6208348f50c99889bb29e13355ba68cab9092881b6478d5d88fd275` | official `@napplet/cli@0.5.1` release and `napplet/web@dc1d24153c759152b6ba31a6ec9bea967798f2df` |

All package publisher identities are `sandwiches`; every registry and official-source response digest is retained in `toolchains/candidates/initial.json`.

## Task Commits

1. **Task 1: Review the exact napplet candidate provenance** — `d88a591` (fix)

## Files Created/Modified

- `src/promotion/candidate.ts` — separate pre-install provenance validation from final promotion-manifest parsing and recognize `--review-ready` after the candidate path.
- `tests/promotion/candidate.test.ts` — cover the two-stage contract, required provenance fields, strict final parser, and documented CLI invocation.
- `toolchains/candidates/initial.json` — reviewed package, protocol, CLI, source, and evidence-origin pins; explicit deferred D-04 fields.
- `.github/workflows/toolchain-candidate.yml` — verify review readiness with the documented flag.
- `.planning/phases/01-napplet-contract-artifact-verification/01-02-SUMMARY.md` — clarify the corrected two-stage contract for downstream plans.

## Decisions Made

- Approved only the exact candidate ID above for sealed intake and testing. It does not authorize promotion, goldens, package installation outside the later controlled intake, or `toolchains/current.json` mutation.
- Kept `parsePromotionManifest` unchanged and mandatory for the complete promotion gate rather than weakening it to accommodate review-time unknowns.
- Accepted the SDK 0.27.2 official release-commit mapping as an explicit human-reviewed fact; the candidate retains the absence of a matching SDK Git tag rather than concealing it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Separated pre-intake provenance from the later D-04 manifest**
- **Found during:** Task 1: Review the exact napplet candidate provenance
- **Issue:** The original candidate validator required lockfile, image, browser, NAP, fixture, golden, and image-local stage facts that can only exist after Plans 04-11, preventing a meaningful pre-install review.
- **Fix:** Added a provenance-intake review scope with explicit deferred pins while leaving the complete `parsePromotionManifest` requirements intact.
- **Files modified:** `src/promotion/candidate.ts`, `tests/promotion/candidate.test.ts`, `toolchains/candidates/initial.json`, `.github/workflows/toolchain-candidate.yml`, `01-02-SUMMARY.md`
- **Verification:** Candidate verifier, candidate tests, workflow guard, and full `bun test` passed.
- **Committed in:** `d88a591`

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking)
**Impact on plan:** The correction closes the sequencing gap without broadening authority or weakening final promotion controls.

## Issues Encountered

- `@napplet/sdk@0.27.2` has no matching GitHub tag. Its official Version Packages release commit contains the exact package version and is paired with the registry integrity; this was exposed to and approved by the reviewer rather than inferred silently.

## Known Stubs

None. The `null`/empty D-04 fields are deliberate deferred promotion pins and block final promotion parsing until later plans materialize them.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 04 may materialize only approved candidate `2dbf448be962e289c962fd5b3659bf526232ded9de163c485925618cead1f23e` into its sealed image and frozen inputs.
- The complete D-04 manifest must still receive all deferred pins from Plans 04-11 before any promotion decision or current-pointer update.

## Self-Check: PASSED

- Confirmed the summary, candidate validator, and exact candidate record exist.
- Confirmed correction commit `d88a591` is present.
- Re-ran review readiness for the approved candidate ID with no blockers.
- Confirmed the correction neither materialized a toolchain nor mutated a promoted pointer.

---
*Phase: 01-napplet-contract-artifact-verification*
*Completed: 2026-08-03*
