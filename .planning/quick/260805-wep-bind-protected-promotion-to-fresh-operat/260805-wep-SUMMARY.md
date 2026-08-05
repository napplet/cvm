---
quick_id: 260805-wep
status: complete
subsystem: release-certification
tags: [phase-07, promotion, trust-root, source-measurement, sha256]
requires:
  - protected release certification trust root
provides:
  - manifest-derived source measurement authenticated before promotion
  - source-aware release authentication and cache fingerprints
affects: [phase-07-release-verification, protected-promotion]
tech-stack:
  added: []
  patterns:
    - operator-held source archives are re-hashed by the pinned root before release authority
key-files:
  modified:
    - src/certification/trust.ts
    - src/promotion/candidate.ts
    - src/promotion/run-promotion.ts
    - tests/phase-07/promotion-gate.test.ts
key-decisions:
  - "Release source measurements are finite versioned tuples of source revision and SHA-256."
  - "The measurement participates in authentication evidence and the terminal decision cache key."
metrics:
  duration: 13min
  completed: 2026-08-05
---

# Quick Task 260805-wep: Bind protected promotion to fresh source measurement

**Protected release promotion now re-hashes the manifest-bound operator source archive before it can authenticate, cache, or promote a release.**

## Accomplishments

- Added a strict, manifest-derived source measurement and pinned-root archive verification.
- Bound the measurement into release authentication, evidence hashing, and decision-cache fingerprinting.
- Added regressions for measurement mutation/omission, archive-byte drift, counterfeit recomputation, and candidate-supplied permissive roots.

## Task Commits

1. `1d76396` — `test(260805-wep): add failing source measurement gate`
2. `769fcc0` — `feat(260805-wep): bind promotion to source measurement`

## Verification

- `bun test tests/phase-07/promotion-gate.test.ts tests/phase-07/reproducibility.test.ts tests/phase-07/supply-chain.test.ts tests/phase-07/certification-runner.test.ts --timeout 10000`
- `bun test --timeout 10000` — 517 passing tests.
- Public `candidate:verify` and unconfigured protected verification both fail closed as required.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Critical correctness] Bound the measurement into the sole evaluator cache.**
- **Found during:** Task 1
- **Issue:** The planned cache-fingerprint requirement is owned by `src/promotion/run-promotion.ts`, which was not listed in the task file set.
- **Fix:** Included source measurement in release authentication, evidence digest, and cache fingerprint.
- **Commit:** `769fcc0`

## Known Stubs

None.
