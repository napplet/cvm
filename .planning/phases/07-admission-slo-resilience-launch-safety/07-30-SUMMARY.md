---
phase: 07-admission-slo-resilience-launch-safety
plan: "30"
subsystem: release infrastructure and telemetry
tags: [cloud-run, collector, otel, authorization, idempotency, security]
requires:
  - phase: 07-28
    provides: exact v2 USD authorization request and receipt boundary
  - phase: 07-29
    provides: injected GCP project/account scope and persist-before-effect adapter pattern
provides:
  - Receipt-gated, injected Cloud Run deployment and observation port
  - Reference-only Collector provisioning and protected-live telemetry observation bridge
affects: [07-31, 07-36, 07-37, 07-38, 07-20, 07-26]
tech-stack:
  added: []
  patterns: [injected native ports, immediate receipt revalidation, original-operation reconciliation, reference-and-digest-only configuration, strict telemetry windows]
key-files:
  created:
    - src/release/native/cloud-run.ts
    - src/release/native/collector.ts
    - tests/release/cloud-run-provider.test.ts
    - tests/release/collector-provider.test.ts
  modified: []
decisions:
  - Cloud Run accepts only candidate/topology/effect/scope-bound configuration and observes the exact original revision before retrying any deployment.
  - Collector configuration returns endpoint digests only and rejects sensitive fields before emitting or accepting a queried telemetry window.
  - Native provider clients, credentials, network calls, and live effects remain injected-only until protected execution.
metrics:
  duration: 14m
  completed_date: 2026-08-06
  tasks_completed: 2
  files_modified: 4
status: complete
---

# Phase 07 Plan 30: Cloud Run and Collector Native Providers Summary

Cloud Run and Collector are now candidate-bound, receipt-gated injected provider ports with exact original-operation reconciliation, no durable generation queue, and redacted concurrent lifecycle telemetry windows.

## Completed Tasks

1. Added Cloud Run control-plane composition for a region/service/revision path. It keeps planning read-only, persists the original operation, observes before retry, revalidates the exact v2 receipt immediately before deployment, checks every readiness/configuration fact, and limits cleanup to the configured run-owned service.
2. Added Collector composition plus a `LiveTelemetryObservationPort` bridge. It retains only endpoint references/digests, binds configuration to the candidate and authorization scopes, emits the closed D-118 lifecycle vocabulary concurrently, requires the exact D-120 binding window, and rejects sensitive-field canaries.

## Verification

- PASS: `bun test tests/release/cloud-run-provider.test.ts` — 3 tests covering read-only plan, exact receipt mutation gate, original-operation reuse, bounded cleanup, and no queue resource.
- PASS: `bun test tests/release/collector-provider.test.ts` — 3 tests covering reference-only configuration, concurrent lifecycle coverage, strict canary rejection, and expiry-boundary revalidation.
- PASS: `bun test tests/phase-07/telemetry-policy.test.ts` — 5 existing telemetry-policy tests covering the finite vocabulary, redaction, cardinality, and exporter containment.
- PASS: ASVS L1 high/critical block-policy source assertion.
- PASS: `git diff --check 82ef41d^ HEAD` and modified-file stub scan.

## TDD Gate Compliance

- RED: `82ef41d` added the Cloud Run contract before its module existed; it failed with the expected missing-module error.
- GREEN: `4f4d7f4` implemented the receipt-gated Cloud Run adapter and passed the contract.
- RED: `78c0296` added the Collector contract before its module existed; it failed with the expected missing-module error.
- GREEN: `58e625c` implemented the reference-only Collector adapter and passed the contract plus the existing telemetry policy suite.

## Decisions Made

- The sole deployment/configuration mutation happens only after initial reconciliation and an immediate fresh exact-v2 receipt validation; stale or ambiguous work is observation-only.
- Cloud Run observations must match the exact operation, project, region, image, service account reference, environment reference digest, minimum instances, ingress, concurrency, refusal semantics, and zero queue-resource count.
- Collector records are constrained to the existing finite D-118 vocabulary and a queried window must bind the exact candidate, topology, collector image, and config digest without sensitive content.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used the existing telemetry policy suite after the planned test path was absent**
- **Found during:** Task 2
- **Issue:** `tests/certification/live-telemetry.test.ts` does not exist in this repository, so the plan's named command did not exercise an existing telemetry suite.
- **Fix:** Ran `tests/phase-07/telemetry-policy.test.ts`, the actual existing D-118/D-119 lifecycle vocabulary, canary-redaction, and cardinality test suite, alongside the new Collector contract.
- **Files modified:** None beyond the planned provider and test files.
- **Verification:** 5 telemetry-policy tests passed.
- **Committed in:** `58e625c` (Task 2)

**Total deviations:** 1 auto-fixed (1 blocking verification-path correction). **Impact:** Verification is stronger and remains within the plan's telemetry scope; no provider authority was broadened.

## Known Stubs

None. Both adapters intentionally require injected protected-run ports and return only bounded references, digests, and observations; they do not claim or perform a live provider action.

## Self-Check: PASSED

- Required source and test files exist.
- Task commits `82ef41d`, `4f4d7f4`, `78c0296`, and `58e625c` exist in git history.
- No generated files, credentials, live effects, skipped tests, or unplanned trust-boundary surface were introduced.
