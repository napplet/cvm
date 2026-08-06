---
phase: 07-admission-slo-resilience-launch-safety
plan: 40
subsystem: release-certification
tags: [deployment-config, sha256, containment, consent, authorization, no-effect]
requires:
  - phase: 07-39
    provides: Provider-neutral release controller, exact sixteen-provider registry, and session seam
provides:
  - Candidate-bound deployment execution configuration and pinned factory loader
  - Structured official-consent authorization receipt and immutable receipt persistence
affects: [07-41, 07-42, 07-43, 07-44, protected-release-execution]
tech-stack:
  added: []
  patterns: [hash-pinned deployment module loading, secret-reference-only configuration, structured consent provenance]
key-files:
  created: [src/release/deployment/config.ts, src/release/deployment/factory.ts, src/release/deployment/consent.ts]
  modified: [src/certification/config.ts, src/release/production-execution.ts, src/release/authorization.ts, src/release/controller.ts]
key-decisions:
  - "Deployment sessions require candidate, source-revision, workspace, config-byte, and factory-byte pins before module import."
  - "A release receipt carries official approval provenance; a digest alone has no authorization authority."
  - "Absent concrete clients fail closed instead of receiving blocked or deterministic production ports."
patterns-established:
  - "Deployment config persists bounded public settings and named secret references only."
  - "Controller-owned consent records are content-addressed and collision-safe."
requirements-completed: [OPS-02, OPS-04]
coverage:
  - id: D1
    description: Candidate-bound deployment config and hash-pinned session loader reject invalid or escaped inputs before import.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: tests/release/deployment-factory.test.ts and tests/release/production-execution.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Structured official-consent receipts bind exact request facts and are persisted without provider execution.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/release/authorization.test.ts and tests/release/controller.test.ts
        status: pass
    human_judgment: false
duration: 8m 18s
completed: 2026-08-06
status: complete
---

# Phase 07 Plan 40: Deployment-owned Release Execution Factory Summary

**Candidate-bound, containment-checked deployment session loading with structured official-consent receipts and no pre-consent external effects.**

## Performance

- **Duration:** 8m 18s
- **Started:** 2026-08-06T18:07:42Z
- **Completed:** 2026-08-06T18:16:00Z
- **Tasks:** 2/2
- **Files modified:** 12

## Accomplishments

- Added strict, deeply frozen deployment configuration containing only byte pins, bounded regions, and named secret references.
- Verified config/module containment, regular-file status, SHA-256 pins, candidate/source/workspace bindings before any dynamic factory import.
- Added structured official approval provenance with channel, approver hash, consent-session references, approval timing, expiry, canonical receipt hash, and immutable controller persistence.
- Preserved no-effect behavior: missing concrete clients fail closed and all verification uses effect-denied fixtures only.

## Task Commits

1. **Task 1: Load one candidate-bound deployment session through the pinned product boundary** - `b0436ef` (test), `c1c35b0` (feat)
2. **Task 2: Replace digest-only approval with an official structured receipt** - `1a0f116` (test), `a5e2838` (feat)

## Files Created/Modified

- `src/release/deployment/config.ts` - strict inert deployment configuration schema.
- `src/release/deployment/factory.ts` - explicit-client factory that fails closed when production clients are absent.
- `src/release/deployment/consent.ts` - official consent-port contract with reference-only results.
- `src/release/production-execution.ts` - pre-import confinement and pin verification plus immutable session validation.
- `src/release/authorization.ts` - structured, canonical official receipt validation.
- `src/release/controller.ts` - controller-owned launch and collision-safe persistence of consent receipts.

## Decisions Made

- A factory module and its JSON configuration must both be regular files below the configured release workspace, individually SHA-256-pinned, before import.
- The existing fixture receipt helper is effect-denied only; normal execution requires the official consent boundary.
- No fallback clients are assembled in the deployment factory, preserving the later concrete-client plans as the sole place real clients can be supplied.

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/deployment-factory.test.ts tests/release/production-execution.test.ts tests/release/authorization.test.ts tests/release/controller.test.ts tests/phase-07/certifier-config.test.ts --timeout 10000` — passed (24 tests).
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — passed (626 tests).
- No-effect proof: all tests ran with `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny`; only injected fakes and loopback fixture consent descriptors were used. No provider, worker, signer, payment, model, publication, suite, promotion, network, or process-spawn action was invoked.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## User Setup Required

None - real official consent remains exclusively owned by Plan 07-20.

## Next Phase Readiness

Plan 07-41 can provide the concrete ADC/Modal/Fly clients to the strict factory without weakening the pinned configuration or structured approval boundary.

## Self-Check: PASSED

- Confirmed task commits `b0436ef`, `c1c35b0`, `1a0f116`, and `a5e2838` exist.
- Confirmed all created deployment files exist.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-06*
