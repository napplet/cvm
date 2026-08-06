---
phase: 07-admission-slo-resilience-launch-safety
plan: 44
subsystem: release-authorization
tags: [authorization, cost-estimation, consent, no-effect, release]
requires:
  - phase: 07-43
    provides: Receipt-bound deployment session and exact-eight protected-port boundary
provides:
  - Sixteen-family source-attributed USD authorization requests with immutable quote supersession
  - Redacted one-command review projection and pending NIP-46/NWC/Cashu consent descriptors
  - Same-pin static readiness inventory and fixture-only receipt-valid transition
affects: [07-20, 07-26, protected-release]
tech-stack:
  added: []
  patterns: [source-attributed-price-lines, immutable-request-supersession, no-effect-review, static-session-readiness]
key-files:
  created: [tests/release/release-authorization-costs.test.ts, tests/release/production-readiness.test.ts]
  modified: [src/release/controller.ts, src/release/authorization.ts, src/release/production-execution.ts, src/release/deployment/consent.ts, scripts/certify-release.ts, tests/release/certify-release.test.ts]
key-decisions:
  - "Authorization cost is the checked aggregate of sixteen source-attributed line maxima, never a fixed release total."
  - "The CLI emits only bounded review facts and consent launch descriptors; it never launches consent before Plan 07-20."
  - "Pinned readiness inventory is read from the same module/config pins without constructing a provider client."
requirements-completed: []
coverage:
  - id: D1
    description: Sixteen-family fresh-price authorization and quote supersession
    verification:
      - kind: integration
        ref: tests/release/release-authorization-costs.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: No-effect pre-approval request, redacted review, consent descriptors, and fixture receipt validation
    verification:
      - kind: integration
        ref: tests/release/production-readiness.test.ts and tests/release/certify-release.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 31m
  completed: 2026-08-06
  tasks_completed: 2
  files_changed: 8
status: complete
---

# Phase 07 Plan 44: Exact Authorization Request and No-Effect Review Summary

**The release controller now turns fresh sixteen-family price facts into immutable bounded authorization requests, while the product CLI produces a redacted review and pending consent descriptors without executing a protected effect.**

## Accomplishments

- Replaced the fixed release estimate with checked USD price lines, quantities, headroom, source hashes, freshness, aggregate policy bounds, and immutable request supersession.
- Added no-effect pre-approval composition: a bounded review projection, pending NIP-46/NWC/Cashu descriptors, and fixture-only `receipt_valid` state transition.
- Added static inventory validation for the same hash-pinned factory/config module used after approval: sixteen provider families, eight protected suites, materialization, worker selection, verification, finalization, actual-cost, and cleanup ownership.

## Task Commits

1. Task 1 — `150f159` `feat(07-44): derive authorization from fresh price facts`
2. Task 2 — `4dae213` `feat(07-44): add no-effect release request workflow`

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/release-authorization-costs.test.ts tests/release/authorization.test.ts tests/release/controller.test.ts tests/release/live-cost-estimator.test.ts --timeout 10000` — passed (20 tests).
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-readiness.test.ts tests/release/certify-release.test.ts tests/release/production-execution.test.ts --timeout 10000` — passed (16 tests).
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — passed (653 tests).
- `git diff --check` — passed. Static scan finds no retired static source or fixed 36,000,000-micro authority in production request code.

## No-Effect Proof

All verification ran with `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny`. Tests used fake catalog/discovery sources, fixture receipts, and local subprocesses only. No authenticated discovery, provider mutation, billing/API change, worker, payment, signer, model, host, publication, relay, protected evidence, promotion, or cleanup effect was run.

## Decisions Made

- A changed quote generates a new request and keeps the old content-addressed request readable as immutable history.
- The review projection excludes paths, tokens, secrets, NWC URIs, Cashu proofs, native receipts, and provider payloads.
- A real official receipt remains an explicit Plan 07-20 input; the fixture receipt route is deny-effects-test-only.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. The no-credential command intentionally uses candidate-bound fixture price facts; authenticated price discovery is injected through the read-only catalog port and remains a root-agent/Plan 07-20 readiness action.

## Next Phase Readiness

Plan 07-20 can run the controller-owned official consent boundary after the root agent performs the permitted authenticated read-only readiness/discovery/pricing check. All protected execution, actual-cost collection, benchmark schedules, publication, promotion, and cleanup remain exclusive to Plan 07-26.

## Self-Check: PASSED

- Confirmed task commits `150f159` and `4dae213` exist.
- Confirmed created tests and all modified release request/CLI sources exist.
