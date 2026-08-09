# Quick Task 260809-cashu-certification-gate: Cashu-only certification funding gate

## Objective

Allow the current Phase 7 release certification checkpoint to proceed with the operator's saved Cashu rail when NWC Lightning is not currently available, without pretending NWC is ready or changing the product requirement that both payment rails remain supported.

## Tasks

1. Normalize release-certification funding readiness so a single ready Cashu rail can satisfy the authorization prerequisite for this run.
2. Keep per-rail prerequisite reporting honest: Cashu ready, NWC `readiness_required`, owner NIP-46 deferred to publication.
3. Separate the 10-minute setup-page lifetime from the reusable local funding reference lifetime.
4. Update Plan 07-20 and project state to record the bounded Cashu-only course correction and the next checkpoint.

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/operator-funding.test.ts tests/release/authorization.test.ts tests/release/certify-live-composition.test.ts tests/release/certify-release.test.ts tests/release/production-preapproval.test.ts --timeout 10000`
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun run release:certify -- --candidate toolchains/candidates/initial.json --request`

