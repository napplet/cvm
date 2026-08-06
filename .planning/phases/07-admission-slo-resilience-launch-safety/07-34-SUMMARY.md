---
phase: 07-admission-slo-resilience-launch-safety
plan: "34"
subsystem: model provider certification
tags: [model, http, reconciliation, authorization, metering, telemetry, zod]
requires:
  - phase: 04-metered-generation-revision-loop
    provides: ModelGateway, durable original-operation accounting, and ModelReconciliationService
  - phase: 07-admission-slo-resilience-launch-safety
    plan: "28"
    provides: exact v2 authorization receipt boundary
provides:
  - Candidate-bound native HTTP model gateway with strict receipt normalization
  - Fresh capability and exact-receipt-gated original-operation reconciliation bridge
  - Local protocol-fixture coverage for dispatch, disconnect recovery, redaction, and fail-closed cases
affects: [07-37, 07-38, 07-39, protected-certification]
tech-stack:
  added: []
  patterns: [candidate-bound-capability-documents, original-operation-only-reconciliation, redacted-lifecycle-observations]
key-files:
  created:
    - src/release/native/model.ts
    - src/certification/live/model-port.ts
    - tests/release/model-live-provider.test.ts
  modified: []
key-decisions:
  - The native HTTP layer normalizes only a strictly validated provider receipt into the existing metering contract; it cannot create an alternate ledger path.
  - Capability bytes are canonical-digest-bound to the candidate, scope, endpoint, model/version, price card, freshness, and exact v2 authorization request.
  - Protected model evidence exposes finite operation/count facts only; credential references may be retained, but credentials, headers, prompts, responses, and tokens do not cross the boundary.
requirements-completed: []
coverage:
  - id: D1
    description: A candidate-bound model endpoint dispatches once, persists only safe provenance, and recovers the original ambiguous operation through authoritative lookup.
    requirement: OPS-01
    verification:
      - kind: integration
        ref: tests/release/model-live-provider.test.ts#protected model port reconciles the one persisted ambiguous operation with the exact receipt and no redispatch
        status: pass
      - kind: integration
        ref: tests/model/reconciliation.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Missing credentials or lookup, stale capabilities, authorization/price mismatches, and malformed provider payloads block without replacement dispatch or sensitive evidence.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/release/model-live-provider.test.ts#missing lookup stale capability mismatched price identity and malformed provider payload fail closed without replacement dispatch
        status: pass
      - kind: integration
        ref: tests/release/model-live-provider.test.ts#protected reconciliation blocks a stale capability before lookup even when its authorization receipt remains valid
        status: pass
    human_judgment: false
metrics:
  duration: 7m 3s
  completed: 2026-08-06
status: complete
---

# Phase 7 Plan 34: Native Model Provider Summary

**Candidate-bound HTTP model dispatch and original-operation reconciliation that reuse the exact metering authority while retaining only redacted evidence.**

## Performance

- **Duration:** 7m 3s
- **Started:** 2026-08-06T14:52:11Z
- **Completed:** 2026-08-06T14:59:34Z
- **Tasks:** 2/2
- **Files created:** 3

## Accomplishments

- Added a provider-neutral HTTP `ModelGateway` whose capability document binds candidate, account/endpoint scopes, model/version, price-card identity, freshness, and exact v2 authorization request before credential resolution or dispatch.
- Added strict, timeout-bounded dispatch and lookup normalization with runtime duplicate suppression, authoritative original-operation lookup, exact receipt identity checks, and redacted lifecycle telemetry.
- Added a protected model observation bridge that revalidates the exact receipt and fresh capability before delegating to `ModelReconciliationService`; it emits only finite operation and count facts.
- Added local-only protocol-server tests for dispatch/reconnect, persisted-before-dispatch recovery, malformed/mismatched/stale authority, missing credentials, no replacement dispatch, and evidence redaction.

## Task Commits

1. **Task 1: Dispatch and reconcile one authorized model operation** - `856ffb9` (test RED), `1f59433` (feat GREEN)
2. **Task 2: Fail closed on unavailable or stale model authority** - `9d87e02` (test RED), `529bd96` (feat GREEN)

## Files Created/Modified

- `src/release/native/model.ts` — candidate-bound, exact-receipt-gated native model adapter.
- `src/certification/live/model-port.ts` — protected original-operation reconciliation bridge.
- `tests/release/model-live-provider.test.ts` — local fixture and failure-mode integration coverage.

## Decisions Made

- Preserve the existing normalized metering provider identity and pricing path; native provider identity is instead bound by the immutable capability digest.
- Treat malformed responses, unavailable credentials, stale capability documents, absent lookup, and unknown outcomes as explicit non-dispatch/reconciliation blocks rather than a retry invitation.
- Keep authorization secrets transient: only a credential reference appears in discovery; protected provenance is a derived reference/digest with no headers or response body.

## Verification

- `bun test tests/release/model-live-provider.test.ts tests/model/reconciliation.test.ts` — passed (12 tests, 62 assertions).
- Phase 07-34 ASVS L1 high-block source assertion — passed.
- `git diff --check` — passed.
- Stub-pattern scan across planned files — no stubs found.

## TDD Gate Compliance

- RED: `856ffb9` added the native adapter and original-operation tests before implementation; the suite failed with expected missing-module errors.
- GREEN: `1f59433` implemented the gateway and protected bridge; focused tests passed.
- RED: `9d87e02` added capability-freshness-before-lookup coverage; it failed with the expected missing freshness guard.
- GREEN: `529bd96` exposed and enforced capability freshness at the protected bridge; focused tests passed.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. The adapter intentionally receives only injected credential resolution and local protocol fixtures in this plan; protected-live execution remains reserved for its receipt-authorized run plan.

## Issues Encountered

The optional repository-wide `bunx tsc --noEmit` check reports pre-existing errors outside this plan's files. The focused test suite passes and a narrowed output check reported no errors in this plan's files.

## Next Phase Readiness

Plan 07-35 can compose the remaining protected provider families through the same capability-bound, receipt-gated, original-operation-only pattern. No model provider selection or live effect has occurred.

## Self-Check: PASSED

- All three planned files exist.
- TDD commits `856ffb9`, `1f59433`, `9d87e02`, and `529bd96` exist in git history.
- No tracked-file deletions, unresolved high/critical threat, stub, skipped test, unrun required verification, credential persistence, or live provider effect was introduced.
