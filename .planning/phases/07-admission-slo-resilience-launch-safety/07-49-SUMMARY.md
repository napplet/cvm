---
phase: 07-admission-slo-resilience-launch-safety
plan: "49"
subsystem: release-certification
tags: [local-setup, macos-keychain, nwc, cashu, spend-ceiling]
requires:
  - phase: 07-50
    provides: topology component quantities and optional authenticated vendor price comparison
provides:
  - explicit loopback-only NWC and Cashu setup backed by macOS Keychain
  - conservative certification maximum-spend catalog distinct from exact customer billing
  - funding-first request sequencing with exhaustive zero-effect counters
affects: [07-20, 07-26]
tech-stack:
  added: []
  patterns: [stdin-only OS secret write, loopback CSRF session, bounded certification budget]
key-files:
  created: []
  modified:
    - scripts/certify-release.ts
    - src/release/controller.ts
    - src/release/costs/production-catalog.ts
    - src/release/deployment/local-setup.ts
    - tests/release/certify-live-composition.test.ts
    - tests/release/certify-release.test.ts
    - tests/release/production-preapproval.test.ts
key-decisions:
  - "Missing local service-wallet references are surfaced before remote catalog or execution readiness, because setup is effect-free and independently actionable."
  - "Release authorization uses a conservative hard ceiling; exact end-user API billing remains the metered ledger contract and actual certification receipts must reconcile below the approved ceiling."
  - "NWC and Cashu material crosses only the loopback request and Keychain subprocess stdin; persisted state contains opaque locators and hashes only."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
metrics:
  duration: 37m
  completed_date: 2026-08-06
  tasks_completed: 2
  files_changed: 8
status: complete
---

# Phase 07 Plan 49: Local Funding Setup and Review Boundary Summary

The release command now leads with the one actionable local prerequisite, stores both service-wallet values in macOS Keychain without serializing them, and can materialize a bounded sixteen-family request from a conservative certification spend ceiling without confusing that ceiling with customer usage billing.

## Accomplishments

- Added an explicit `--setup` flow that opens a loopback-only, CSRF-bound, ten-minute browser session for independent NWC Lightning and Cashu entry.
- Added a macOS Keychain writer that transmits material only through subprocess stdin; argv, environment, stdout/stderr, repository files, runtime records, and summaries never contain wallet material.
- Reordered `--request` so missing wallet references produce the concrete Plan 07-20 action before remote pricing/config checks, with all eighteen effect-family counters at zero.
- Replaced exact-SKU dependence at the approval boundary with a clearly labeled conservative maximum-spend policy. Optional authenticated vendor catalog comparison remains implemented by Plans 07-48/07-50; actual receipts still reconcile under the approved ceiling.
- Passed the complete repository suite: 670 tests, 0 failures, 5,147 assertions.

## Commit

- `4e52010` — `feat(release): launch local funding setup safely`

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-preapproval.test.ts tests/release/production-catalog.test.ts tests/release/certify-release.test.ts tests/release/certify-live-composition.test.ts tests/release/operator-funding.test.ts --timeout 10000` — 23 passed.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — 670 passed, 0 failed.
- macOS Keychain stdin self-test — add/read/cleanup all succeeded without placing material in argv or output.
- `bun run release:certify -- --candidate toolchains/candidates/initial.json --request` — emitted only `local_setup_required` and zero effect counters.

## Course Correction

Plan 07-49 originally required successful current vendor-SKU pricing before local setup could be surfaced. That coupled a transient read-only catalog call to an independent local prerequisite and conflated exact customer billing with operator approval of a maximum release-certification spend. The corrected contract preserves all current-source readers as optional comparison evidence while making the hard ceiling explicit and conservative.

## Next Checkpoint

Plan 07-20 is active. The controller-launched local page is collecting the two service-owned wallet references. After both opaque references are ready, the request is regenerated and the exact bounded approval is presented. Owner NIP-46 remains deferred to actual napplet publication.

## Self-Check: PASSED

- No secret-shaped value exists in the diff or summary.
- No provider, wallet, signer, model, publication, suite, promotion, or cleanup effect occurred during request preparation.
- Existing plans, evidence, deferrals, and Phase 1 completion remain intact.
