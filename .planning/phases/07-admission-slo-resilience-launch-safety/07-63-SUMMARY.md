---
phase: 07-admission-slo-resilience-launch-safety
plan: "63"
subsystem: infra
tags: [google-cloud, adc, cloud-run, cloud-storage, cloud-sql, topology]
requires:
  - phase: 07-58
    provides: production architecture and single-authority topology decision
provides:
  - ADC-bound Google control-plane HTTPS transports with durable request identities
  - Two-region Cloud Run, one regional-HA Cloud SQL, and nam4 GCS topology contract
affects: [07-65, 07-66, protected-live-certification]
tech-stack:
  added: []
  patterns: [observe-before-create, durable-request-journal, generation-specific-object-observation]
key-files:
  created: [src/release/deployment/google-auth.ts, tests/release/google-production-transport.test.ts]
  modified: [src/release/deployment/google-clients.ts, src/release/topology.ts, src/release/contracts.ts]
key-decisions:
  - "Cloud Run creation uses deterministic serviceId then resource observation; it does not invent requestId support."
  - "Cloud SQL regional HA is one database authority despite two Cloud Run control regions."
  - "GCS retention, lifecycle old-version expiry, and soft-delete duration are observed separately; retention locking is rejected."
patterns-established:
  - "Google mutation: journal exact resource/request digest, observe, make one official request, then reconcile by resource identity."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: ADC-bound Google deployment transports and failure handling
    requirement: OPS-01
    verification:
      - kind: unit
        ref: tests/release/deployment-google-clients.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Single-authority Google production topology and storage policy
    requirement: OPS-02
    verification:
      - kind: unit
        ref: tests/release/google-production-transport.test.ts
        status: pass
    human_judgment: false
duration: 14min
completed: 2026-10-27
status: complete
---

# Phase 07 Plan 63: Google Production Transports Summary

**Authenticated Google REST transports now journal and observe deterministic Cloud Run, Cloud SQL, and GCS resources while topology bills one regional-HA database authority.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-10-27T13:56:26Z
- **Completed:** 2026-10-27T14:10:16Z
- **Tasks:** 2/2
- **Files modified:** 7

## Accomplishments

- Added an in-memory-only ADC broker with project, quota-project, principal, expiry, and `cloud-platform` scope binding; bearer values never enter logs, errors, or durable records.
- Replaced loopback/illustrative Google requests with official HTTPS Cloud Run create, Cloud Storage JSON upload, and Cloud SQL Admin insert operations, all with pre-request journaling and reconciliation-safe observations.
- Corrected the topology to two Cloud Run regions with three warm instances each, one regional-HA PostgreSQL authority, and a versioned/KMS/retention-checked `nam4` bucket.

## Task Commits

1. **Task 1: Implement ADC HTTPS and durable Google operations** — `f0ccbf9` (`feat`)
   - Follow-up identity hardening: `63c438a` (`fix`)
2. **Task 2: Correct the selected topology and storage policy** — `3667aa4` (`feat`)

## Files Created/Modified

- `src/release/deployment/google-auth.ts` — bounded ADC broker and receipt-compatible account-scope digest.
- `src/release/deployment/google-clients.ts` — official Google transports, resource observation, journaling, and cleanup ownership checks.
- `src/release/topology.ts` — one regional-HA Cloud SQL authority and explicit storage policy.
- `src/release/contracts.ts` — validates topology's HA and object-policy declarations.
- `tests/release/deployment-google-clients.test.ts` — authenticated success, failure, timeout/reconciliation, and request-shape contracts.
- `tests/release/google-production-transport.test.ts` — production allocation and GCS-policy contracts.

## Decisions Made

- Cloud Run has no documented create `requestId`; the deterministic service identifier plus persisted request digest is observed before any retry.
- Vertex generation remains `unknown` at this layer: it has no durable operation lookup and Plan 65 owns query-only receipt reconciliation.
- GCS retention policy is observed but never irreversibly locked by this code; lifecycle and soft-delete windows are independently required.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected topology quantity assertion after removing the fabricated second database**
- **Found during:** Task 2
- **Issue:** Preapproval coverage expected twenty topology lines, including a Cloud SQL authority for each control region.
- **Fix:** Updated the expectation to nineteen explicit allocations and documented why one regional-HA instance is billed once.
- **Files modified:** `tests/release/production-preapproval.test.ts`
- **Verification:** Targeted preapproval and controller suites pass.
- **Commit:** `3667aa4`

**Total deviations:** 1 auto-fixed (Rule 1).

## Known Stubs

None.

## Next Phase Readiness

The code is local-contract verified only. Before a protected execution, an authorized deployment must supply the receipt-bound principal, actual ADC identity, durable operation journal, exact KMS/bucket/Cloud SQL identifiers, and scoped IAM. No cloud resource was created, no credential was read, and no live continuity claim is made by this plan.

## Self-Check: PASSED

- Confirmed both task commits exist and all seven plan files exist.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/google-production-transport.test.ts tests/release/deployment-google-clients.test.ts tests/release/controller.test.ts tests/release/production-preapproval.test.ts --timeout 10000` passed: 24 tests, 125 assertions.
