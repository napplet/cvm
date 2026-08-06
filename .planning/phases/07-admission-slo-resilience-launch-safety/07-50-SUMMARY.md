---
phase: 07-admission-slo-resilience-launch-safety
plan: "50"
subsystem: release-certification
tags: [cloud-billing-v1, adc-oauth, regional-skus, topology, cost-aggregation]
requires:
  - phase: 07-48
    provides: bounded official source readers and receipt-free preapproval inputs
provides:
  - topology-owned per-region and tier component allocations
  - memory-only ADC-authenticated Cloud Billing v1 source seam
  - component-provenance aggregation behind sixteen stable authorization lines
affects: [07-49, 07-20, 07-26]
tech-stack:
  added: []
  patterns: [component-owned SKU allocation, opaque ADC token port, checked family aggregation]
key-files:
  created: []
  modified:
    - src/release/topology.ts
    - src/release/costs/official-sources.ts
    - src/release/costs/production-catalog.ts
    - src/release/costs/live-estimator.ts
    - tests/release/production-preapproval.test.ts
key-decisions:
  - "The topology, rather than a catalog adapter, owns every component ID, region/scope, unit, quantity, and headroom allocation; its full contract is hashed."
  - "Cloud Billing reads can use only in-memory ADC bearer material through service/SKU URLs, with no project endpoint, API key, emitted token, or persisted token."
  - "Public authorization preserves ordered sixteen-family lines while component source/SKU/region/unit/quantity provenance is committed under each line digest."
patterns-established:
  - "Component provenance: require an exact, ordered, one-to-one topology component to SKU mapping; reject gaps, duplicate SKU IDs, region/unit mismatch, stale data, and ambiguous pricing tiers."
  - "Cost aggregation: derive all component base/headroom values with checked integer arithmetic, then aggregate only after exact topology and quote verification."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Regional and tiered Google price components map one-to-one to exact official SKU provenance while preserving sixteen authorization families.
    requirement: OPS-01
    verification:
      - kind: unit
        ref: tests/release/production-preapproval.test.ts#aggregates component receipts into one family line with complete provenance
        status: pass
      - kind: integration
        ref: NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-preapproval.test.ts tests/release/production-catalog.test.ts tests/release/live-cost-estimator.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: ADC is restricted to memory-only authorization on Cloud Billing service/SKU reads and cannot select a project or expose the bearer value.
    requirement: OPS-02
    verification:
      - kind: unit
        ref: tests/release/production-preapproval.test.ts#binds each regional Google component to one authenticated catalog SKU without exposing ADC
        status: pass
      - kind: integration
        ref: NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000
        status: pass
    human_judgment: false
metrics:
  duration: 44m
  completed_date: 2026-08-06
  tasks_completed: 1
  files_changed: 5
status: complete
---

# Phase 07 Plan 50: Regional Official SKU Aggregation Summary

Regional Cloud Billing pricing now uses topology-bound component allocations, opaque memory-only ADC authorization, and checked component aggregation while retaining the stable sixteen-family authorization request.

## Performance

- **Duration:** 44 min
- **Started:** 2026-08-06T22:00:00Z
- **Completed:** 2026-08-06T22:44:23Z
- **Tasks:** 1/1
- **Files modified:** 5

## Accomplishments

- Replaced per-family Google quantities with twenty canonical components covering regional Cloud Run, collector, Cloud SQL HA, and GCS storage/operation allocations plus the remaining bounded families. Component contract changes alter `topologySha256`.
- Added exact component-to-SKU catalog selection, byte-preserving source provenance, strict current USD/region/unit/tier validation, and a `gcloud auth application-default print-access-token` port whose bearer value exists only in process memory and request headers.
- Aggregated checked integer component cost and headroom into exactly sixteen ordered family lines, committing the component source/SKU/region/unit/quantity calculation to quote and estimate digests.

## Task Commits

1. **Task 1: Bind per-region component quantities to official SKU components and aggregate safely** — `db27053` (TDD RED), `f8e322a` (TDD GREEN)

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-preapproval.test.ts tests/release/production-catalog.test.ts tests/release/live-cost-estimator.test.ts --timeout 10000` — passed (10 tests).
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — passed (669 tests, 0 failures).
- Redacted real ADC Cloud Billing v1 probe attempted `GET https://cloudbilling.googleapis.com/v1/services?pageSize=1` without a project ID. The authenticated request timed out after 10 seconds; the token, account, and any project identifier were neither printed nor persisted.

## Files Created/Modified

- `src/release/topology.ts` — ordered regional/tier component contract committed to the topology hash.
- `src/release/costs/official-sources.ts` — Cloud Billing service/SKU reader and memory-only ADC token port.
- `src/release/costs/production-catalog.ts` — one-to-one component catalog validation and component provenance facts.
- `src/release/costs/live-estimator.ts` — checked component calculation and sixteen-family aggregation.
- `tests/release/production-preapproval.test.ts` — ADC, exact-SKU, component provenance, and aggregation denial coverage.

## Decisions Made

- Allocation is canonical topology data, never inferred from a catalog response or price.
- Worker public rates retain 100-second units so sub-micro per-second pricing remains exact in integer micros.
- The live probe is read-only and intentionally does not retry with alternate endpoints or inspect accessible projects after a timeout.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The required redacted live catalog probe reached the intended authenticated Cloud Billing endpoint but timed out after ten seconds. This is protected-live evidence still needed before a launch claim; it did not affect deterministic implementation or deny-effects verification.

## Known Stubs

None.

## Threat Flags

None — the only added network surface is the plan-owned Cloud Billing service/SKU GET path, with explicit origin, method, redirect, byte, token, project, and response-shape controls.

## TDD Gate Compliance

- RED: `db27053` introduced the component/SKU, token-boundary, and aggregate-provenance tests and was run failing before implementation.
- GREEN: `f8e322a` implemented the topology, source, catalog, and estimator changes; focused and full suites pass.

## Next Phase Readiness

- Plan 07-49 can resume request composition without a user-authored price or allocation seam.
- Protected live Cloud Billing connectivity must be re-observed successfully before treating this as live pricing evidence; no provider resource or financial effect was made.

## Self-Check: PASSED

- Verified all five plan files exist.
- Verified task commits `db27053` and `f8e322a` exist.
