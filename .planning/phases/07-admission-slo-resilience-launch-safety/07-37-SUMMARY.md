---
phase: 07-admission-slo-resilience-launch-safety
plan: "37"
subsystem: production release-provider and protected-certification composition
tags: [release, providers, certification, authorization, asvs]
requires:
  - phase: 07-36
    provides: receipt-gated native publication adapters
provides:
  - complete 16-family injected native provider registry
  - exact-eight real protected certification port composition
affects: [07-38, 07-20, 07-26]
tech-stack:
  added: []
  patterns: [injected provider handles, schema-validated references, exact receipt gates, real-evidence-only protected ports]
key-files:
  created:
    - src/release/native-registry.ts
    - src/certification/live/production-ports.ts
    - tests/release/live-production-composition.test.ts
  modified:
    - src/certification/live/registry.ts
    - src/release/controller.ts
    - tests/release/certify-release.test.ts
decisions:
  - All 16 provider families are represented by one injected ReleaseProviderPort registry; absent protected handles are explicit capability-blocked ports.
  - Production input exposes exactly eight real-evidence suite ports, translated only into the established protected-live evaluator contract.
  - The local non-dry controller constructs the complete no-effect registry then blocks for protected capability and consent, never an unimplemented-family fallback.
metrics:
  duration: 5m
  completed_date: 2026-08-06
  tasks_completed: 2
  files_modified: 6
status: complete
---

# Phase 07 Plan 37: Production Provider and Protected Port Composition Summary

Every release provider family now has a candidate-bound, injected, no-effect composition path, and protected certification accepts only one exact eight-suite real-evidence port set.

## Completed Tasks

1. Added a TDD-proven native registry slice which constructs all 16 provider families without calls, exposes a provider-neutral controller discovery bridge, and rejects missing or malformed authorization before adapter apply.
2. Added strict production protected-port composition for admission, telemetry, chaos, durability, security-host, supply-chain, ContextVM-payment-model, and publication. The production boundary rejects any non-real port and delegates through the existing sole evaluator path.

## Verification

- PASS: `bun test tests/release/live-production-composition.test.ts tests/release/certify-release.test.ts tests/phase-07/certification-runner.test.ts` — 20 tests passed with injected fakes only.
- PASS: Plan ASVS L1 high/critical blocking-policy assertion.
- PASS: former unimplemented-family scan of `src/` returned no matches.
- PASS: `git diff --check`.
- PASS: stub-pattern scan of changed production and test files returned no results.

## TDD Gate Compliance

- RED: `5547e68` added the production composition contract; it failed because the native registry module did not exist.
- GREEN: `fc96713` added the injected 16-family registry and exact real protected-port factory.
- RED: `a384a56` added the complete-registry blocked-path and former-dead-end regression assertions; the controller returned the former unimplemented-family error.
- GREEN: `eff9b9d` replaces that response with explicit protected capability-or-consent blocking.

## Decisions Made

- The registry stores only candidate digests, validated provider references, injected client/session handles, and an injected clock; it neither authenticates nor persists raw credentials.
- Missing protected capability or official consent is an explicit blocked state before any provider effect.
- The production facade uses `evidenceClass: "real"`; its internal conversion to the existing `protected_live` runner type creates no alternate evaluator or fallback.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed the controller's former unimplemented-family dead end**
- **Found during:** Task 2
- **Issue:** `src/release/controller.ts` still threw `RELEASE_LIVE_PROVIDER_FAMILY_UNIMPLEMENTED`, causing the plan-required former-error scan to fail.
- **Fix:** Constructed the complete no-effect native registry from the candidate digest and returned `RELEASE_PRODUCTION_CAPABILITY_OR_CONSENT_REQUIRED` until the protected runner supplies authorized capability/consent handles.
- **Files modified:** `src/release/controller.ts`, `tests/release/certify-release.test.ts`
- **Commit:** `eff9b9d`

**2. [Rule 3 - Blocking] Used the existing live registry coverage path**
- **Found during:** Task 2 verification
- **Issue:** `tests/certification/live-registry.test.ts` does not exist in this repository.
- **Fix:** Ran the existing release registry and exact-eight runner coverage in `tests/release/certify-release.test.ts` and `tests/phase-07/certification-runner.test.ts` alongside the new composition contract.
- **Files modified:** None

**Total deviations:** 2 auto-fixed. **Impact:** The release command now fails closed with a concrete protected-input requirement, and verification exercises the repository's actual registry coverage.

## Known Stubs

None. Provider clients, sessions, consent, and live effects remain injected-only and are intentionally unavailable until the protected execution plan.

## Self-Check: PASSED

- Required source, test, and summary files exist.
- Task commits `5547e68`, `fc96713`, `a384a56`, and `eff9b9d` exist in git history.
- No credential material, skipped tests, unrun verification, or unplanned live effect was introduced.
