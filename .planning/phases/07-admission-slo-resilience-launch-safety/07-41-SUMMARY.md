---
phase: 07-admission-slo-resilience-launch-safety
plan: 41
subsystem: release-deployment
tags: [gcp, modal, fly, pricing, cost-reconciliation, no-effect]
requires:
  - phase: 07-40
    provides: Pinned deployment factory and receipt-gated release execution seam
provides:
  - Shared bounded Google client primitives for Cloud Run, GCS, Cloud SQL, Collector, and Vertex
  - Equivalent unselected Modal/Fly runner descriptors and fixed cohort schedule
  - Fresh sixteen-family USD estimate and actual-cost reconciliation contract
affects: [07-42, 07-43, 07-44, 07-26]
tech-stack:
  added: []
  patterns: [injected loopback provider clients, source-attributed price facts, original-operation actual-cost reconciliation]
key-files:
  created: [src/release/deployment/google-clients.ts, src/release/deployment/worker-clients.ts, src/release/costs/live-estimator.ts]
  modified: [src/release/deployment/factory.ts]
key-decisions:
  - "Google control-plane primitives share one injected project/quota authority and fail closed outside loopback fixture transport."
  - "Modal and Fly share immutable schedule/resource/network definitions and remain unselected without fresh protected evidence."
  - "All sixteen provider families require fresh source and quote digests before an estimate or final actual-cost settlement is accepted."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Shared GCP client primitives constrain fixture ADC, loopback transport, GCS, Cloud SQL, Collector, and Cloud Run observations.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: tests/release/deployment-google-clients.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Equivalent worker schedules and sixteen-family estimates block unavailable, stale, malformed, or over-bound facts.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/release/deployment-worker-clients.test.ts and tests/release/live-cost-estimator.test.ts
        status: pass
    human_judgment: false
duration: 8m
completed: 2026-08-06
status: complete
---

# Phase 07 Plan 41: Concrete Deployment Clients and Live Cost Contract Summary

**Loopback-testable shared Google and worker provider clients with fresh sixteen-family USD estimates and bounded actual-cost reconciliation.**

## Accomplishments

- Added a project/quota-scoped, redacted Google client seam for Cloud Run, GCS, Cloud SQL PostgreSQL, Collector, and Vertex primitives.
- Added unselected Modal/Fly client descriptors with the same no-backlog, default-deny runner definition and cohort schedule.
- Added checked bigint-based source/freshness/coverage pricing plus exact original-operation actual-cost settlement gates.

## Task Commits

1. **Task 1: Wire shared Google client tracer** - `39e5e10` (test), `09d4157` (feat)
2. **Task 2: Add worker clients and live cost estimator** - `891e7de` (test), `1cde393` (feat)

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test …` focused deployment suite — passed (28 tests).
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — passed (634 tests).
- No-effect proof: all provider interactions used injected fakes or loopback-only transports. No real ADC, metadata, GCP, Modal, Fly, worker lifecycle, catalog, spend, process, cleanup, publication, or promotion operation ran.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Next Phase Readiness

Vertex primitives are exported for 07-42. Authenticated price discovery remains deferred to 07-44 and all real effects remain exclusive to 07-26.

## Self-Check: PASSED

- Confirmed task commits and all three deployment/cost modules exist.
