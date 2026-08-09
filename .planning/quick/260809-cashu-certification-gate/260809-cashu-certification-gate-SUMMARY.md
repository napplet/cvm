---
status: complete
date: 2026-08-09
---

# Quick Task 260809-cashu-certification-gate Summary

## Outcome

The current release certification checkpoint now accepts the saved operator Cashu rail as sufficient funding readiness for this run. NWC Lightning remains absent and is reported as `readiness_required`; it is not marked ready and no secret or credential value is persisted in planning artifacts.

The saved Cashu readiness metadata was renewed from the existing opaque Keychain reference and hashes, with no token material read or printed.

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/operator-funding.test.ts tests/release/authorization.test.ts tests/release/certify-live-composition.test.ts tests/release/certify-release.test.ts tests/release/production-preapproval.test.ts --timeout 10000` — 28 pass, 0 fail.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun run release:certify -- --candidate toolchains/candidates/initial.json --request` — exits 1 at `preapproval_blocked` with pricing/capability discovery complete, Cashu ready, NWC `readiness_required`, and execution blocked on `RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED`.

## Next Checkpoint

Repair protected execution materialization so the Cashu-funded request can render the exact bounded approval, then complete Plan 07-20 approval and run Plan 07-26.
