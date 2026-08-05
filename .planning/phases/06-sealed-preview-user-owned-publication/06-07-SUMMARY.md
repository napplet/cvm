---
phase: 06-sealed-preview-user-owned-publication
plan: "07"
subsystem: verification
tags: [design-evidence, content-addressed, phase-06, source-contract, coverage]
requires:
  - phase: 06-06
    provides: signed preview/publication boundary and safe host projection
provides:
  - 26-case deterministic Phase 6 actual-authority reference matrix
  - canonical content-addressed Phase 6 design evidence and pointer
  - coverage, promoted-source, determinism, and live-observation honesty gate
affects: [phase-07, verification, publication, release-certification]
tech-stack:
  added: []
  patterns: [comparison-only expectations, canonical evidence payload digest, Phase 7 live-observation separation]
key-files:
  created:
    - tests/fixtures/phase-06-reference-set.json
    - tests/evals/phase-06-reference-set.test.ts
    - src/verification/phase-06-design-evidence.ts
    - scripts/verify-phase-06-design-slice.ts
    - evidence/design/phase-06.json
    - evidence/design/1155cb31a32191a728275ddd625ca078a8eba6e5889ca012894180ff29d4f123.json
  modified:
    - package.json
key-decisions:
  - "The Phase 6 evidence pointer names a canonical payload digest while the stored record remains an immutable canonical JSON document."
  - "Deterministic authority and source-contract inspection may pass design proof; live host, signer, CLI asset, relay, Blossom, PostgreSQL/Cockroach, and provider records remain not_observed under Phase 7 ownership."
  - "Reference expectations are comparison-only; the verifier derives observations from bounded actual-authority scenarios after running their named probes."
patterns-established:
  - "Require complete requirement, decision, threat, API, edge, and UI mappings before emitting evidence."
  - "Validate two isolated canonical builds for byte/hash equality before writing an immutable record and stable pointer."
requirements-completed: [PREV-01, PREV-02, PREV-03, PREV-04, PUB-01, PUB-02, PUB-03, PUB-04, PUB-05]
coverage:
  - id: D1
    description: 26 deterministic reference cases execute Phase 6 authority probes for every preview/publication requirement and E-01 through E-23.
    requirement: PREV-01
    verification:
      - kind: integration
        ref: bun test tests/evals/phase-06-reference-set.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: Canonical design evidence validates mappings, source identity, API dispositions, redaction, and content-address pointer integrity.
    requirement: PUB-04
    verification:
      - kind: other
        ref: bun run verify:phase06-design
        status: pass
    human_judgment: false
  - id: D3
    description: Live host, signer, CLI asset, relay, Blossom, PostgreSQL/Cockroach, and provider records stay explicitly not_observed pending Phase 7 certification.
    requirement: PUB-05
    verification:
      - kind: other
        ref: evidence/design/phase-06.json
        status: pass
    human_judgment: false
metrics:
  duration: 13m
  completed_date: 2026-08-05
status: complete
---

# Phase 06 Plan 07: Deterministic Design Evidence Summary

**Phase 6 now has a 26-case authority matrix and a reproducible content-addressed design record that proves deterministic behavior without overstating unexecuted live integrations.**

## Performance

- **Duration:** 13m
- **Started:** 2026-08-05T09:40:00Z
- **Completed:** 2026-08-05T09:53:07Z
- **Tasks:** 2/2
- **Files modified:** 7

## Accomplishments

- Added all 26 named reference cases, mapping PREV-01 through PREV-04, PUB-01 through PUB-05, D-96 through D-113, the threat register, all UI considerations, and E-01 through E-23 to executed authority probes.
- Added strict canonical evidence building, promoted source identity/API coverage gates, atomic record writing, and a stable Phase 6 evidence pointer.
- Recorded deterministic source-contract inspection as passed while explicitly deferring host, signer, CLI asset, relay, Blossom, PostgreSQL/Cockroach, and provider certification to Phase 7.

## Task Commits

1. **Task 06-07-01: Execute the requirement and 26-case actual-authority reference set** — `05c50eb` (test)
2. **Task 06-07-02: Emit content-addressed design evidence and enforce coverage honesty** — `9cb32ef` (feat), `7236e00` (fix)

## Files Created/Modified

- `tests/fixtures/phase-06-reference-set.json` — Named requirement, decision, threat, edge, and authority-probe fixture matrix.
- `tests/evals/phase-06-reference-set.test.ts` — Exact scenario comparison and actual authority-probe execution gate.
- `src/verification/phase-06-design-evidence.ts` — Strict schemas, mappings, deterministic digest, redaction, and observation-separation validator.
- `scripts/verify-phase-06-design-slice.ts` — Deterministic evidence generation, source/API coverage validation, immutable record/pointer writer.
- `evidence/design/phase-06.json` — Stable pointer to the Phase 6 content-addressed record.
- `package.json` — Phase 6 source-probe, reference-evaluation, and design-verification scripts.

## Decisions Made

- The source-contract validator proves only reviewed source facts; the repository checkout probe correctly remains `publication_unavailable` without an independently verified checkout and does not become a live CLI claim.
- Evidence serializes only allowlisted mappings, identity values, counters, comparisons, and observation statuses; it omits protected/user/provider payloads.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `bun run probe:phase06-cli-source` correctly reported `SOURCE_CHECKOUT_NOT_PROVIDED`; this is an expected live-certification boundary, not a design-proof failure.

## Known Stubs

None. The evidence explicitly tracks unexecuted live integrations as `not_observed` rather than stubbing a Phase 6 behavior.

## User Setup Required

None - no external service configuration is required for deterministic design verification.

## Next Phase Readiness

Phase 7 can use the stable evidence pointer and live-observation inventory to perform real checkout, host, signer, CLI asset, relay, Blossom, PostgreSQL/Cockroach, and provider certification without conflating those results with deterministic design proof.

## Self-Check: PASSED

- Verified the Phase 6 pointer and content-addressed record exist and validate through `bun run verify:phase06-design` twice.
- Verified task commits `05c50eb`, `9cb32ef`, and `7236e00` exist.

---
*Phase: 06-sealed-preview-user-owned-publication*
*Completed: 2026-08-05*
