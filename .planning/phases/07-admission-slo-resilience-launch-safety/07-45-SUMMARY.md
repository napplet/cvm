---
phase: 07-admission-slo-resilience-launch-safety
plan: "45"
subsystem: release-certification
tags: [pricing, authorization, funding, no-effect]
requires:
  - 07-44 exact authorization request boundary
provides:
  - source-attributed sixteen-family production cost catalog
  - separately-bound NWC Lightning and Cashu readiness contract
affects:
  - 07-46 production factory/readiness composition
  - 07-20 operator funding and approval checkpoint
tech-stack:
  added: [zod, Web Crypto SHA-256]
  patterns: [schema-bounded read-only ports, opaque secret references, receipt-bound readiness]
key-files:
  created:
    - src/release/costs/production-catalog.ts
    - src/release/deployment/operator-funding.ts
    - tests/release/production-catalog.test.ts
    - tests/release/operator-funding.test.ts
  modified:
    - src/release/authorization.ts
    - src/release/deployment/consent.ts
    - tests/release/authorization.test.ts
    - tests/release/certify-release.test.ts
decisions:
  - Current Google/Modal/Fly facts are accepted only through schema-bounded read-only source ports and exact source-byte hashes; a future GCP project is never supplied to catalog reads.
  - NWC Lightning and funded Cashu are two service-owned readiness prerequisites with distinct opaque OS-secret references, while NIP-46 stays deferred to napplet publication.
  - Human approval receipts bind the operator-funding readiness digest; deny-effects loopback receipts remain test-only and cannot constitute production approval.
metrics:
  duration: 7m 51s
  completed_date: 2026-08-06
  tasks_completed: 2
  files_changed: 8
status: complete
---

# Phase 07 Plan 45: Truthful Cost Catalog and Operator Funding Summary

Production pricing now requires current, hash-bound official source snapshots for every paid family, while explicit project-owned policy facts represent only zero-cost operations. Approval authority separately binds NWC Lightning and Cashu readiness without treating either rail or future NIP-46 signing as user consent.

## Completed Tasks

1. Added a sixteen-family production catalog that rejects incomplete, stale, malformed, non-USD, unpriced, and reordered facts. Google reads receive no project ID; Modal/Fly rate source bytes are preserved and hashed before facts reach the estimator.
2. Added the opaque local operator-funding prerequisite controller, updated approval semantics, and made a changed, expired, or revoked rail invalidate readiness. Real human approval now requires ready funding; only deny-effects fixtures can issue loopback receipts for downstream test coverage.

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-catalog.test.ts tests/release/live-cost-estimator.test.ts tests/release/certify-release.test.ts --timeout 10000` — 16 passed.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/operator-funding.test.ts tests/release/authorization.test.ts tests/release/certify-release.test.ts tests/release/controller.test.ts --timeout 10000` — 28 passed.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — 658 passed across 119 files.
- No-effect product request probe returned `preapproval_blocked` with pricing blocked, two separate funding-readiness prerequisites, and deferred NIP-46. It printed no fixture prices, URI, proof, token, or bearer-shaped value.

## Decisions Made

- Pricing ports are read-only and source-byte-attributed; Plan 07-46 will compose them into the protected factory/session without selecting a substitute project.
- Operator funding is a service prerequisite, not an end-user approval channel. NIP-46 is never requested before publication.
- A production approval receipt is valid only with both ready funding rails; test-only loopback receipts are constrained to `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny`.

## Deviations from Plan

### Auto-fixed Issues

1. [Rule 1 - Bug] Preserved legacy deny-effects receipt coverage without weakening production approval
- **Found during:** Task 2 full deny-effects verification
- **Issue:** Existing downstream tests use deterministic loopback receipts to exercise post-approval guards; applying the new funding-ready condition to that explicitly test-only path broke 28 unrelated no-effect cases.
- **Fix:** Kept production `OfficialConsentPort` approval strict while allowing only the deny-effects `loopback_fixture` helper to create and validate deterministic receipts.
- **Files modified:** `src/release/authorization.ts`
- **Commit:** `79e8b16`

2. [Rule 1 - Bug] Corrected invalid non-hex test digest fixtures
- **Found during:** Task 2 GREEN test
- **Issue:** The new funding test used non-hex digest characters, so the boundary schema correctly rejected its fixture before the behavior under test.
- **Fix:** Replaced fixtures with valid SHA-256-shaped hexadecimal values.
- **Files modified:** `tests/release/operator-funding.test.ts`
- **Commit:** `937b0fa`

## Known Stubs

None.

## Self-Check: PASSED

All eight task files and the four task commits (`e39ad44`, `1bd45e0`, `937b0fa`, and `79e8b16`) exist.

## Next Checkpoint

Execute Plan 07-46 to compose the protected factory and make the one-command no-effect readiness path consume this catalog. After that, Plan 07-20 is the blocking human-action checkpoint for any missing local NWC Lightning and funded Cashu references plus approval of the exact rendered request.
