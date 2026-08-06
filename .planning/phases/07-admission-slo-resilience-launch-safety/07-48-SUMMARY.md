---
phase: 07-admission-slo-resilience-launch-safety
plan: "48"
subsystem: release-certification
tags: [official-pricing, cloud-billing, topology, preapproval, deny-effects]
requires:
  - phase: 07-47
    provides: receipt-gated production dependency composition
provides:
  - allowlisted, byte-preserving official Google, Modal, and Fly pricing readers
  - non-uniform, topology-hashed release quantity contract
  - create-only receipt-free execution-readiness materialization with pin remeasurement
affects: [07-49, 07-20, 07-26]
tech-stack:
  added: []
  patterns: [bounded official-source parsing, non-enumerable JSON-safe topology extension, receipt-free candidate artifact]
key-files:
  created:
    - src/release/costs/official-sources.ts
    - src/release/preapproval-materializer.ts
  modified:
    - src/release/costs/production-catalog.ts
    - src/release/topology.ts
    - tests/release/production-preapproval.test.ts
key-decisions:
  - "Official price source bytes are retained before strict parsing; redirects, pagination, unknown tiers, regions, units, currencies, and fractional-micro precision are rejected."
  - "Worker rates use exact 100-second pricing units so decimal public per-second rates can be represented in checked integer USD micros."
  - "Preapproval records only inert candidate/source/topology/catalog and local pin facts; authorization receipts and protected-evidence authority remain exclusively on the later protected path."
patterns-established:
  - "Topology extension: hash JSON-safe quantity strings into the topology while exposing the local contract as a non-enumerable property to preserve strict persisted schemas."
  - "Readiness artifacts: create once beneath a candidate-addressed workspace root, then rehash both artifact and pinned local sources before reuse."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Official pricing readers preserve bytes and reject malformed or redirected source data while binding exact non-uniform topology quantities.
    requirement: OPS-01
    verification:
      - kind: unit
        ref: tests/release/production-preapproval.test.ts#captures only allowlisted official pricing bytes and derives ordered non-uniform topology quantities
        status: pass
      - kind: integration
        ref: NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: Receipt-free execution-readiness artifacts are root-confined, immutable, and remeasured without protected authority fields.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: tests/release/production-preapproval.test.ts#materializes create-only receipt-free preapproval bytes and remeasures every pin
        status: pass
      - kind: integration
        ref: NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-preapproval.test.ts tests/release/materialize-certifier.test.ts --timeout 10000
        status: pass
    human_judgment: false
metrics:
  duration: 68m
  completed_date: 2026-08-06
  tasks_completed: 2
  files_changed: 5
status: complete
---

# Phase 07 Plan 48: Official Pricing and Receipt-Free Preapproval Summary

Strict official pricing readers now bind current source bytes to a mechanically derived, non-uniform topology quantity contract, while an inert candidate-addressed readiness artifact stays separate from receipt-bound protected materialization.

## Performance

- **Duration:** 68 min
- **Started:** 2026-08-06T21:05:28Z
- **Completed:** 2026-08-06T22:13:18Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added allowlisted HTTPS GET readers for the public Google Cloud Billing Catalog, Modal pricing, and Fly pricing documents. They capture bytes before parsing and fail closed on redirects, non-success responses, oversized bodies, parser drift, wrong currency/region/unit, tier ambiguity, and precision loss.
- Added the complete exact sixteen-provider quantity contract derived from two regions, six warm Cloud Run instances, bounded runtimes, 30-day retention, locked worker cohorts, and finite operation ceilings. Its JSON-safe form is included in the topology hash.
- Added create-only receipt-free execution-readiness materialization with candidate-root containment, opaque reference names only, and remeasurement of the artifact plus pinned factory/config modules.

## Task Commits

1. **Task 1: Bind current official source bytes to exact topology quantities** — `5d14639` (TDD RED), `8b8c4fc` (TDD GREEN), `55d3d35` (compatibility fix)
2. **Task 2: Materialize and remeasure receipt-free preapproval execution inputs** — `6e59fe5` (TDD RED), `769a624` (TDD GREEN)

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-preapproval.test.ts tests/release/production-catalog.test.ts tests/release/live-cost-estimator.test.ts --timeout 10000` — passed (7 tests).
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-preapproval.test.ts tests/release/materialize-certifier.test.ts --timeout 10000` — passed (8 tests).
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — passed (666 tests, 0 failures).

## Files Created/Modified

- `src/release/costs/official-sources.ts` — bounded production source readers and strict parsers for official pricing bytes.
- `src/release/costs/production-catalog.ts` — validates supplied topology contract coverage and unit agreement before binding a quote hash.
- `src/release/topology.ts` — derives exact, ordered quantities and commits their JSON-safe representation to the topology hash.
- `src/release/preapproval-materializer.ts` — creates and verifies isolated receipt-free execution-readiness artifacts.
- `tests/release/production-preapproval.test.ts` — deny-effects coverage for source integrity, quantity shape, containment, and authority confusion.

## Decisions Made

- Public provider documents are source material, not remembered rates: parsing derives price only from captured bytes and fails on unsupported source shapes.
- Exact 100-second worker units avoid rounding away sub-micro per-second official rates.
- The receipt-free artifact contains no receipt identity, worker selection, protected observation, trust/evaluator authority, status, or secret value; `materializeProtectedCertifier` remains unchanged and receipt-bound.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserved strict persisted topology compatibility**
- **Found during:** Task 1 full deny-effects verification
- **Issue:** Exposing bigint quantity lines as enumerable topology properties broke canonical JSON serialization and strict topology parsing in existing controller paths.
- **Fix:** Kept quantity strings inside the topology hash and exposed the local contract as a non-enumerable JSON-safe extension.
- **Files modified:** `src/release/topology.ts`, `tests/release/production-preapproval.test.ts`
- **Verification:** Focused controller/live-controller tests and the 666-test deny-effects suite pass.
- **Committed in:** `55d3d35`

**Total deviations:** 1 auto-fixed (Rule 1)

## Known Stubs

None.

## Threat Flags

None — the only new network surface is the plan-owned allowlisted official pricing read path, which is covered by strict origin, byte, response, parser, unit, and freshness controls.

## TDD Gate Compliance

- RED: `5d14639` and `6e59fe5` each introduced tests that failed because their planned module was absent.
- GREEN: `8b8c4fc` and `769a624` implemented the minimum production paths; `55d3d35` fixed a directly caused serialization compatibility defect.

## Next Phase Readiness

- Plan 07-49 can consume the bounded source/topology facts and inert readiness artifact to complete the safe local setup and exact review boundary.
- No provider mutation, worker/model/payment/signer/host/publication/suite/evidence/trust/promotion/cleanup effect was performed.

## Self-Check: PASSED

- Verified all five plan files exist.
- Verified commits `5d14639`, `8b8c4fc`, `6e59fe5`, `769a624`, and `55d3d35` exist.
