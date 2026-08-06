---
phase: 07-admission-slo-resilience-launch-safety
plan: "47"
subsystem: release-certification
tags: [authorization-receipt, production-factory, dependency-injection, deny-effects]
requires:
  - phase: 07-46
    provides: hash-pinned release execution session and effect-free readiness seam
provides:
  - receipt-gated sixteen-family production provider registry
  - exact eight-port, real-evidence protected-suite dependency gate
  - validation that rejects aliases, fixtures, stale receipts, and cross-bound requests before any effect
affects: [07-48, 07-49, 07-20, 07-26]
tech-stack:
  added: []
  patterns: [branded operational dependency graph, receipt revalidation before preparation, project-owned port identity checks]
key-files:
  created:
    - src/release/deployment/production-dependencies.ts
    - tests/release/production-dependencies.test.ts
  modified:
    - src/release/deployment/production-factory.ts
    - src/release/deployment/factory.ts
    - src/release/production-execution.ts
decisions:
  - The only path to operational preparation is an opaque, branded graph of explicit project-owned adapters with a receipt revalidated against the caller's canonical request.
  - All sixteen provider ports and eight protected ports must be distinct and real; construction itself performs no provider, signer, suite, or finalization operation.
  - NIP-46 remains a dormant signer-family dependency and is not called during graph construction or receipt validation.
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Exact receipt unlocks one complete sixteen-family/eight-port production dependency graph with no pre-receipt effects.
    requirement: OPS-01
    verification:
      - kind: unit
        ref: tests/release/production-dependencies.test.ts#the exact receipt gates a complete real independently-owned production graph without pre-receipt effects
        status: pass
      - kind: integration
        ref: NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: Aliased, fixture, incomplete, stale, and request-mismatched dependencies cannot reach operational or signer methods.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: tests/release/production-dependencies.test.ts#aliased incomplete and non-real dependencies are rejected before an operational method is reachable
        status: pass
      - kind: unit
        ref: tests/release/production-dependencies.test.ts#a stale receipt does not invoke preparation or any provider including the dormant signer family
        status: pass
    human_judgment: false
metrics:
  duration: 15m
  completed_date: 2026-08-06
  tasks_completed: 1
  files_changed: 5
status: complete
---

# Phase 07 Plan 47: Receipt-Gated Production Dependency Graph Summary

One canonical structured receipt now gates a complete sixteen-provider, eight-real-suite production graph without creating any real operational effect during composition.

## Performance

- **Duration:** 15 min
- **Completed:** 2026-08-06T21:02:20Z
- **Tasks:** 1/1
- **Files modified:** 5

## Accomplishments

- Replaced the unconditional `prepareAuthorizedExecution` stub with a branded, explicitly injected dependency graph.
- Required canonical ordering, project-owned origins, distinct identities, and real evidence class for all provider and protected-suite ports.
- Revalidated canonical authorization requests and exact receipts before preparation; stale and mismatched receipts cannot invoke a provider, signer, suite, finalizer, cost, promotion, or cleanup operation.

## Task Commits

1. **Task 1: Compose and validate the receipt-gated production dependency graph** — `927e03a` (TDD RED), `0272da6` (TDD GREEN)

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-dependencies.test.ts tests/release/production-factory.test.ts tests/release/deployment-factory.test.ts tests/release/production-execution.test.ts --timeout 10000` — 9 passed.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — 662 passed across 121 files.

## Files Created/Modified

- `src/release/deployment/production-dependencies.ts` — validates and exposes the complete receipt-gated dependency graph.
- `src/release/deployment/production-factory.ts` — accepts only validated operational dependencies instead of an unconditional stub.
- `src/release/deployment/factory.ts` — carries the opaque graph to the production session boundary.
- `src/release/production-execution.ts` — revalidates the exact receipt at the pinned execution-session boundary.
- `tests/release/production-dependencies.test.ts` — covers zero-effect, alias, fixture, stale, and cross-bound receipt rejection.

## Decisions Made

- A valid graph is branded after strict construction-time checks so callers cannot substitute an unchecked lookalike at the production factory.
- Receipt validation happens at preparation, after no-effect graph construction and before the injected preparation callback, preserving NIP-46 solely for authorized publication.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The repository has no `typecheck` script or local TypeScript compiler. Bun's focused and full test runs compiled and exercised the changed TypeScript paths successfully.

## Known Stubs

None.

## TDD Gate Compliance

- RED: `927e03a` committed the new test while its imported production dependency module was absent; the focused test failed with module-not-found.
- GREEN: `0272da6` added the dependency module and production wiring; focused and full deny-effects suites pass.

## Next Phase Readiness

- Plan 07-48 can materialize current source/preapproval facts against the now-truthful receipt-gated execution boundary.
- No live provider, wallet, signer, publication, suite, or promotion action was attempted or authorized.

## Self-Check: PASSED

- Verified commits `927e03a` and `0272da6` exist.
- Verified all five plan files exist and the unconditional production preparation stub is absent.
