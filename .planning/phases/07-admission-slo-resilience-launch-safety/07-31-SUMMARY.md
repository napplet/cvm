---
phase: 07-admission-slo-resilience-launch-safety
plan: "31"
subsystem: release durability infrastructure
tags: [gcs, cloud-sql-postgres, authorization, idempotency, durability, asvs]
requires:
  - phase: 07-28
    provides: exact v2 USD authorization request and receipt boundary
  - phase: 07-29
    provides: injected GCP scope and persist-before-effect provider pattern
provides:
  - Receipt-gated, versioned GCS content-addressed object and restore bridge
  - Receipt-gated Cloud SQL PostgreSQL authority with HA and serializable probe observations
affects: [07-36, 07-37, 07-38, 07-20, 07-26]
tech-stack:
  added: []
  patterns: [injected native ports, immediate receipt revalidation, exact-generation restore, original-operation reconciliation, reference-and-digest-only evidence]
key-files:
  created:
    - src/release/native/gcs.ts
    - src/release/native/cloud-sql-postgres.ts
    - tests/release/gcs-provider.test.ts
    - tests/release/cloud-sql-provider.test.ts
  modified: []
decisions:
  - GCS authorizes only content-addressed keys inside one candidate-bound run namespace, while exact generations and checksums remain mandatory for restore and deletion.
  - Cloud SQL PostgreSQL remains the sole current D-130 database authority; only exact REGIONAL PostgreSQL 17, backup, storage, private-network, and identity observations pass.
  - Native clients and credentials remain injected-only; adapters persist and reconcile the original operation before an immediate receipt revalidation permits a mutation.
metrics:
  duration: 12m
  completed_date: 2026-08-06
  tasks_completed: 2
  files_modified: 4
status: complete
requirements-completed: []
coverage:
  - id: D1
    description: Versioned content-addressed GCS objects restore only with exact generation and checksum facts.
    requirement: OPS-03
    verification:
      - kind: unit
        ref: tests/release/gcs-provider.test.ts
        status: pass
      - kind: integration
        ref: tests/release/live-operations-adapters.test.ts#chaos and restore reject deterministic controls before provider effects or protected evidence
        status: pass
    human_judgment: false
  - id: D2
    description: Cloud SQL PostgreSQL observes the selected HA topology and a serializable zero-duplicate-effect probe.
    requirement: OPS-02
    verification:
      - kind: unit
        ref: tests/release/cloud-sql-provider.test.ts
        status: pass
    human_judgment: false
---

# Phase 07 Plan 31: Native GCS and Cloud SQL PostgreSQL Providers Summary

GCS and the sole Cloud SQL PostgreSQL authority now use receipt-gated injected ports that preserve original operations, exact durable observations, bounded cleanup, and credential-free evidence.

## Completed Tasks

1. Added GCS bucket/object composition with dual-region, versioning, retention, run namespace, content-address, checksum, and exact-generation controls. Its read-only object-store bridge is suitable for fresh-instance restore while all object writes/deletion schedules remain authorization-gated.
2. Added the D-130 Cloud SQL PostgreSQL composition. It binds one project/region/instance and exact PostgreSQL 17 REGIONAL HA, storage, backup, private-network, and identity settings, then requires a serializable zero-duplicate-effect probe before reporting completion.

## Verification

- PASS: `bun test tests/release/gcs-provider.test.ts` — 3 tests covering zero-effect planning, exact-v2 revalidation, content-addressed generation reads, original-operation retry, and namespace-scoped cleanup.
- PASS: `bun test tests/release/cloud-sql-provider.test.ts` — 3 tests covering zero-effect planning, exact HA/database observations, serializable duplicate-effect probe, original-operation reuse, and instance-scoped cleanup.
- PASS: `bun test tests/release/live-operations-adapters.test.ts` — 3 existing protected-live boundary tests, including restore refusal before any deterministic provider effect.
- PASS: ASVS L1 high/critical block-policy source assertion.
- PASS: `git diff --check eefed2c^..HEAD` and modified-file stub scan.

## TDD Gate Compliance

- RED: `eefed2c` added the GCS contract before its module existed; it failed with the expected missing-module error.
- GREEN: `0f5cd38` implemented the receipt-gated GCS provider and passed its contract plus the existing live-adapter guard.
- RED: `ec74e2f` added the Cloud SQL contract before its module existed; it failed with the expected missing-module error.
- GREEN: `a85b7dc` implemented the receipt-gated Cloud SQL PostgreSQL provider and passed its contract.

## Decisions Made

- Every future GCS effect has fresh authorization immediately before it: first bucket configuration, then each immutable object write or exact-generation deletion schedule.
- Only a completed Cloud SQL observation that exactly matches the selected authoritative configuration may run the serializable transaction/duplicate-effect probe.
- Neither adapter instantiates a provider client, opens a network connection, receives credentials, or writes protected evidence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used the existing live restore adapter suite after the planned path was absent**
- **Found during:** Task 1
- **Issue:** `tests/certification/live-durability.test.ts` is not present in this repository.
- **Fix:** Ran `tests/release/live-operations-adapters.test.ts`, the existing protected-live restore boundary suite, together with the GCS contract tests.
- **Files modified:** None beyond planned provider/test files.
- **Verification:** All three existing live-operation adapter tests passed.
- **Committed in:** `0f5cd38` (Task 1)

**2. [Rule 1 - Bug] Avoided a Bun matcher mutation of the object reference under test**
- **Found during:** Task 1
- **Issue:** Applying nested matcher objects through `toMatchObject` changed the subsequently reused object reference in the Bun test runtime.
- **Fix:** Asserted the immutable reference fields individually before passing the same reference to the restore bridge.
- **Files modified:** `tests/release/gcs-provider.test.ts`
- **Verification:** GCS contract and live-adapter suites passed.
- **Committed in:** `0f5cd38` (Task 1)

**Total deviations:** 2 auto-fixed (1 blocking verification-path correction, 1 test bug). **Impact:** Both fixes preserve the planned trust boundary and strengthen evidence without adding a provider path or live effect.

## Known Stubs

None. Both adapters intentionally require injected protected-run ports and return only bounded configuration, digest, reference, and observation values; they do not claim or perform a live provider action.

## Self-Check: PASSED

- Required source and test files exist.
- Task commits `eefed2c`, `0f5cd38`, `ec74e2f`, and `a85b7dc` exist in git history.
- No generated files, credentials, live effects, skipped tests, or unplanned trust-boundary surface were introduced.
