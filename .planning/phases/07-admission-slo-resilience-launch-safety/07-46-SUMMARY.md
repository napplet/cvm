---
phase: 07-admission-slo-resilience-launch-safety
plan: "46"
subsystem: release-certification
tags: [production-factory, no-effect, readiness, authorization]
requires:
  - 07-45 truthful cost catalog and operator funding readiness
provides:
  - controller-generated, hash-pinned release execution module and configuration
  - same-session preapproval discovery with finite readiness blockers
affects: [07-20 operator approval, 07-26 protected execution]
tech-stack:
  added: []
  patterns: [opaque secret references, pinned factory readiness, no-effect preapproval]
key-files:
  created:
    - src/release/deployment/production-factory.ts
    - tests/release/production-factory.test.ts
  modified:
    - src/release/deployment/factory.ts
    - src/release/production-execution.ts
    - src/release/materialize-certifier.ts
    - scripts/certify-release.ts
    - tests/release/production-execution.test.ts
decisions:
  - The protected execution factory accepts only controller-generated opaque references, with NWC Lightning and funded Cashu separate and NIP-46 deferred to publication.
  - Readiness imports and constructs the same hash-pinned session later used for receipt-bound execution, but can invoke only capability/authentication discovery before approval.
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Controller-generated production factory has the exact sixteen provider families and eight protected suites.
    requirement: OPS-01
    verification:
      - kind: unit
        ref: tests/release/production-factory.test.ts#the concrete factory has the authoritative sixteen-family inventory and no preapproval NIP-46 request
        status: pass
    human_judgment: false
  - id: D2
    description: Preapproval loads the same pinned session while retaining zero provider effects.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: tests/release/production-execution.test.ts#pinned release execution session construction makes no provider call
        status: pass
      - kind: integration
        ref: tests/release/production-readiness.test.ts#the pre-approval controller path performs only sixteen fake discovery and price reads
        status: pass
    human_judgment: false
metrics:
  duration: 10m
  completed_date: 2026-08-06
  tasks_completed: 2
  files_changed: 7
status: complete
---

# Phase 07 Plan 46: Concrete Protected Factory and Readiness Summary

The release command now validates a controller-generated, hash-pinned session before approval, while retaining an effect-free path that reports finite pricing, factory, and funding prerequisites.

## Completed Tasks

1. Added a concrete production factory with the authoritative sixteen-family registry, eight-suite inventory, opaque-reference validation, and generated execution/config pins inside the confined workspace.
2. Made preapproval use the pinned session for discovery when present, and added coverage proving factory construction has no provider call or effect method reachability.

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-factory.test.ts tests/release/deployment-factory.test.ts tests/release/production-execution.test.ts --timeout 10000` — 6 passed.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-readiness.test.ts tests/release/certify-release.test.ts --timeout 10000` — 13 passed.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — 659 passed across 120 files.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun run release:certify -- --candidate toolchains/candidates/initial.json --request` — exited 1 with `preapproval_blocked`; only read-only capability discovery ran. Pricing needs current authoritative catalog data, execution needs a protected generated config, both operator funding rails are `readiness_required`, and NIP-46 remains `deferred_to_publication`.

## TDD Gate Compliance

- RED: `04fc631` — factory contract failed until the module existed.
- GREEN: `f7ec05f`, `59f8069` — factory and same-session readiness passed.

## Decisions Made

- The production factory only exposes opaque reference names and bounded public topology; it never enumerates ambient credentials or renders secret/path payloads.
- The no-effect request remains fail-closed until current price evidence, protected materialization, and the separate NWC Lightning/Cashu readiness are available. It never requests NIP-46 before publication.

## Deviations from Plan

### Auto-fixed Issues

1. [Rule 1 - Bug] Corrected the generated readiness suite identifiers
- **Found during:** Task 2 RED verification
- **Issue:** The initial inventory used external port labels rather than the protected runner's canonical `restore` and `contextvm-payment-model` suite names.
- **Fix:** Reused the runner's authoritative `PROTECTED_SUITES` list in the production factory.
- **Files modified:** `src/release/deployment/production-factory.ts`
- **Commit:** `59f8069`

## Known Stubs

None.

## Self-Check: PASSED

All task commits (`04fc631`, `f7ec05f`, `59f8069`) and the seven plan-owned source/test files exist. The full deny-effects suite passed.

## Next Checkpoint

Plan 07-20: connect any missing official local operator NWC Lightning and funded Cashu references, refresh the authoritative pricing catalog and protected generated configuration, then approve the exact rendered request. No NIP-46 interaction is needed before publication.
