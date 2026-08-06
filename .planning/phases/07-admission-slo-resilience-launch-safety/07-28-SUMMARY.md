---
phase: 07-admission-slo-resilience-launch-safety
plan: "28"
subsystem: release authorization
tags: [release, authorization, usd, receipts, cli, security]
requires:
  - phase: 07-27
    provides: Cloud SQL authority and provider-neutral release controller boundary
provides:
  - Versioned exact USD authorization requests and matching receipts
  - State-, candidate-, scope-, topology-, and effect-bound no-effect approval flow
  - CLI rendering and validation of the one exact authorization digest
affects: [07-29, 07-20, 07-25, 07-26]
tech-stack:
  added: []
  patterns: [canonical content-addressed authorization, integer USD micros, receipt-gated effects]
key-files:
  created:
    - src/release/authorization.ts
    - tests/release/authorization.test.ts
  modified:
    - src/release/contracts.ts
    - src/release/controller.ts
    - src/release/providers.ts
    - scripts/certify-release.ts
    - tests/release/controller.test.ts
decisions:
  - Exact release authorization uses a v2 USD-only contract; the controller accepts no legacy receipt for execution.
  - The request binds the candidate, topology, ordered effects, controller state, account/project scopes, GCP bootstrap effects, estimate freshness, retention, cleanup, and expiry.
  - CLI request and receipt operations remain no-effect and never construct native discovery or provider mutation ports.
metrics:
  duration: 20m
  completed_date: 2026-08-06
  tasks_completed: 2
  files_modified: 7
status: complete
---

# Phase 07 Plan 28: Exact USD Authorization Boundary Summary

Release certification now creates a deterministic, content-addressed USD authorization request and accepts only its exact unexpired v2 receipt before the protected effect boundary.

## Completed Tasks

1. Added the tracer contract from controller through CLI: canonical request/receipt schemas bind candidate, topology, ordered effects, scopes, state, cost, GCP effects, retention, cleanup, and expiry; CLI `--request`/`--receipt` operate with zero effect ports.
2. Enforced stale-estimate, ISO currency, safe integer micros, maximum-cost, scope ordering, request tamper, receipt expiry, regeneration, and exact cleanup-deadline validation.

## Verification

- PASS: `bun test tests/release/authorization.test.ts` — 4 tests, 25 assertions.
- PASS: `bun test tests/release/authorization.test.ts --rerun-each 2` — 8 passing repetitions.
- PASS: focused release suite (`authorization`, `controller`, `provider-discovery`, `certify-release`) — 22 tests, 99 assertions.
- PASS: ASVS L1 high/critical block-policy source assertion.
- PASS: `git diff --check`.

## TDD Gate Compliance

- RED: `91f6671` added authorization contract tests before `authorization.ts` existed; the focused test failed with the missing-module error.
- GREEN: `a3320e9` added the exact v2 contract, controller integration, provider compatibility boundary, and no-effect CLI path.
- RED/GREEN follow-up: `de0471b` added and satisfied the strict cleanup-not-after-expiry rule.

## Decisions Made

- Exact authorization is USD-only and uses safe integer micros end-to-end.
- A newly derived project scope digest is paired with each discovered account scope, so a stale or changed provider scope cannot reuse a receipt.
- Historical provider test parsing remains supported inside the adapter, but the release controller validates only the exact v2 receipt before any future effect.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Tightened cleanup to the exact authorization expiry**
- **Found during:** Task 2
- **Issue:** A cleanup deadline could extend past request expiry when only bounded by expiry plus run duration.
- **Fix:** Reject any request whose cleanup deadline is after its authorization expiry, with RED/GREEN coverage.
- **Files modified:** `src/release/authorization.ts`, `tests/release/authorization.test.ts`
- **Commit:** `de0471b`

**2. [Rule 1 - Compatibility] Kept legacy adapter parsing outside controller authority**
- **Found during:** Task 1
- **Issue:** Existing provider-adapter tests still exercise historical v1 operation records; replacing its parser outright would break those records while the controller must accept only v2.
- **Fix:** Kept a local historical parser for adapter compatibility and imported the v2 contract directly into the controller, preserving its v2-only effect gate.
- **Files modified:** `src/release/providers.ts`, `src/release/controller.ts`
- **Commit:** `a3320e9`

**Total deviations:** 2 auto-fixed (1 security, 1 compatibility). **Impact:** The live-effect boundary is stricter; no provider authority was broadened.

## Known Stubs

None. The plan intentionally leaves protected live execution for its designated later plans; this authorization implementation neither fabricates evidence nor performs effects.

## Self-Check: PASSED

- Required authorization module, controller, CLI, and tests exist.
- Task commits `91f6671`, `a3320e9`, and `de0471b` exist in git history.
- No stubs, skipped tests, unrun verification, or new security surface outside the plan threat model were found.
