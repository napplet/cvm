---
phase: 07-admission-slo-resilience-launch-safety
plan: "01"
subsystem: admission
tags: [contextvm, capacity, lifecycle-telemetry, slo, idempotency, bun]
requires:
  - phase: 07-00
    provides: Pending-only Phase 07 certification registry and admission command seam
provides:
  - Trusted ContextVM receipt-to-exact-ready lifecycle context
  - Provider-neutral, fail-closed admission benchmark reports
  - Concurrent/replay-safe capacity claim coalescing
affects: [07-02, 07-04, 07-09, admission-certification]
tech-stack:
  added: []
  patterns:
    - Strict finite observational lifecycle contracts
    - Exact ready proof before funded hold acceptance
    - Process-local duplicate coalescing backed by the durable capacity intent claim
key-files:
  created:
    - src/telemetry/contracts.ts
    - src/admission/benchmark.ts
  modified:
    - src/funding/funded-admission.ts
    - src/contextvm/adapter.ts
    - tests/phase-07/admission-slo.test.ts
key-decisions:
  - "The receipt clock starts after strict ContextVM event correlation and ends only at a matching exact-ready proof."
  - "In-flight duplicate coalescing is process-local only; the durable capacity intent remains the cross-process authority and no queue or retry loop is introduced."
  - "Capacity refusal is externally projected as a bounded capacity_unavailable response with only a protected admission reference."
patterns-established:
  - "Lifecycle data contains finite stages/outcomes, monotonic time, and protected SHA-256 identities only."
  - "Admission benchmarks fail closed for insufficient, unready, or backlogged cohorts."
requirements-completed: [SESS-02, OPS-01]
coverage:
  - id: D1
    description: "Correlated ContextVM admission measures receipt through an exact ready lease before accepting a funded hold."
    requirement: SESS-02
    verification:
      - kind: integration
        ref: "bun test tests/phase-07/admission-slo.test.ts tests/funding/funded-admission.test.ts tests/contextvm/adapter.test.ts --timeout 10000"
        status: pass
    human_judgment: false
  - id: D2
    description: "Concurrent and replayed capacity refusal creates no extra reserve, hold, release, retry, or backlog effects."
    requirement: SESS-02
    verification:
      - kind: integration
        ref: "tests/phase-07/admission-slo.test.ts#coalesces concurrent and refused replays"
        status: pass
    human_judgment: false
  - id: D3
    description: "Admission SLO reports reject insufficient, unready, and backlogged cohorts while retaining bounded sample identities."
    requirement: OPS-01
    verification:
      - kind: unit
        ref: "tests/phase-07/admission-slo.test.ts#rejects unready leases and produces a fail-closed deterministic report"
        status: pass
    human_judgment: false
metrics:
  duration: 5m 27s
  completed: 2026-08-05
status: complete
---

# Phase 07 Plan 01: Trusted Immediate Admission Summary

**ContextVM-funded admission now measures from a correlated signed receipt through a durably claimed exact-ready lease, with safe refusal and replay-safe concurrency.**

## Performance

- **Duration:** 5m 27s
- **Started:** 2026-08-05T15:37:38Z
- **Completed:** 2026-08-05T15:43:05Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added strict, finite lifecycle contracts that carry only protected SHA-256 correlations and monotonic timing facts.
- Bound ContextVM receipt timing to an exact session-ready lease proof before any funded admission can succeed.
- Added deterministic SLO reporting and concurrent/replay idempotency oracles that reject insufficient, unready, or backlogged cohorts.

## Task Commits

1. **Task 1: Carry one signed admission from correlated receipt to exact ready lease or safe refusal** - `30a6dbd` (RED test), `f6ba0ab` (implementation)
2. **Task 2: Close exact replay, concurrent claim, and deterministic SLO-report semantics** - `8576290` (RED test), `489b148` (implementation)

## Files Created/Modified

- `src/telemetry/contracts.ts` - Strict lifecycle schemas and non-authoritative telemetry port.
- `src/admission/benchmark.ts` - Provider-neutral samples and fail-closed p50/p95/p99 report.
- `src/funding/funded-admission.ts` - Exact-ready validation, stable compensation, and safe duplicate coalescing.
- `src/contextvm/adapter.ts` - Correlated receipt clock and owner-safe capacity refusal projection.
- `tests/phase-07/admission-slo.test.ts` - Tracer, report, replay, and concurrency evidence.

## Decisions Made

- Start the admission clock only after strict signed-envelope correlation, and stop it only at the matching exact-ready proof.
- Keep duplicate coalescing transient and local; the durable capacity intent/dispatch claim remains the authority across coordinators.
- Keep capacity response data finite and owner-safe: no provider, region, inventory, tenant, price, or native error fields cross the adapter boundary.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Normalize the default monotonic clock to an integer**
- **Found during:** Task 1
- **Issue:** `performance.now()` has fractional milliseconds but the strict lifecycle schema correctly requires integer monotonic timestamps, causing existing ContextVM adapter requests to fail closed.
- **Fix:** Floor the default clock reading at the trusted adapter boundary before lifecycle schema validation.
- **Files modified:** `src/contextvm/adapter.ts`
- **Verification:** Focused adapter, funded-admission, and Phase 07 tracer suites pass.
- **Committed in:** `f6ba0ab`

**2. [Rule 1 - Bug] Fence conflicting in-flight idempotency key reuse**
- **Found during:** Task 2
- **Issue:** Initial duplicate coalescing keyed only by account/idempotency key could return the active command's outcome to a concurrently changed command.
- **Fix:** Bind the in-flight record to the canonical command fingerprint and reject differing concurrent reuse before capacity effects.
- **Files modified:** `src/funding/funded-admission.ts`, `tests/phase-07/admission-slo.test.ts`
- **Verification:** Concurrent changed-command oracle and full focused regression suite pass.
- **Committed in:** `489b148`

**Total deviations:** 2 auto-fixed (2 Rule 1 bugs).

## Issues Encountered

None beyond the auto-fixed correctness issues above.

## Known Stubs

None in plan-owned implementation files. The full suite still reports five Wave 0 Phase 07 `test.todo` entries owned by later plans; they were not introduced or modified here.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Later Phase 07 load, telemetry, and certification plans can reuse the trusted lifecycle and benchmark contracts. This plan provides deterministic local evidence only; live provider certification remains pending and registry rows remain non-pass.

## Self-Check: PASSED

- All five plan-owned source/test files exist.
- Task commits `30a6dbd`, `f6ba0ab`, `8576290`, and `489b148` exist.
- `bun test --timeout 10000` passed: 436 pass, 5 pre-existing TODO, 0 fail.
