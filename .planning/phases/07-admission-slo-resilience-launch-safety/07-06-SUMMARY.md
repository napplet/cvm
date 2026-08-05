---
phase: 07-admission-slo-resilience-launch-safety
plan: "06"
subsystem: resilience
tags: [bun, fault-injection, reconciliation, publication, original-operation]
requires:
  - phase: 07-01
    provides: durable admission and capacity replay boundaries
  - phase: 07-05
    provides: persisted publication effects with fixed child operation identities
provides:
  - closed D-122 port-boundary fault schedule inventory
  - comparator-only exact-effect oracle with a one-writer fence
  - finite reconciliation observations for model and publication recovery
affects: [07-07, 07-09, chaos-certification, release-certification]
tech-stack:
  added: []
  patterns: [original-operation-only recovery, bounded fault schedules, finite protected observations]
key-files:
  created: [src/resilience/fault-harness.ts]
  modified: [src/model/reconciliation.ts, src/publication/publication-service.ts, tests/phase-07/fault-matrix.test.ts]
key-decisions:
  - "Fault schedules carry only bounded input, initial state, and port outcomes; expected facts stay in the comparator-only oracle."
  - "Regional, SQL-unavailability, model, and publication rows retain protected-live certification status instead of becoming synthetic live passes."
patterns-established:
  - "Recovery observes the claimed original operation and never exposes a replacement dispatch, signer, deploy, relay, or attestation capability."
requirements-completed: [OPS-02]
coverage:
  - id: D1
    description: "Original ambiguous model and partial-publication recovery retain exactly one original operation and no replacement effect."
    requirement: OPS-02
    verification:
      - kind: integration
        ref: "tests/phase-07/fault-matrix.test.ts#original-operation tracer settles one ambiguous model operation without redispatch"
        status: pass
      - kind: integration
        ref: "tests/phase-07/fault-matrix.test.ts#partial publication reconciles fixed children by observation only"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every D-122 deterministic fault family has an executable one-writer exact-effect schedule; live-only rows remain protected certification work."
    requirement: OPS-02
    verification:
      - kind: unit
        ref: "tests/phase-07/fault-matrix.test.ts#D-122 matrix executes every fault family with one-writer exact-oracle schedules"
        status: pass
      - kind: unit
        ref: "bun test --timeout 10000"
        status: pass
    human_judgment: false
duration: 3m 43s
completed: 2026-08-05
status: complete
---

# Phase 07 Plan 06: Original-Operation Fault Matrix Summary

**A closed D-122 fault harness that proves bounded recovery keeps one writer and only observes original model and publication operations.**

## Performance

- **Duration:** 3m 43s
- **Started:** 2026-08-05T16:18:00Z
- **Completed:** 2026-08-05T16:21:43Z
- **Tasks:** 2/2
- **Files modified:** 4

## Accomplishments

- Added strict fault classes, durable boundaries, schedules, effect oracles, and a runner that has no direct durable-state or external-effect authority.
- Proved concurrent ambiguous-model reconciliation settles the stored operation once, with one lookup and no redispatch.
- Proved partial publication observes fixed deploy, owner-event, and attestation children without a replacement deployment or signing effect.
- Registered all D-122 fault families, preserving protected-live rows as certification requirements.

## Task Commits

1. **Task 1: Trace one ambiguous model-to-ledger-to-publication recovery through original IDs only** - `7e0f46e` (test), `db38efb` (feat)
2. **Task 2: Execute every D-122 failure class at every durable boundary** - `8c87132` (test), `0d8f55e` (feat)

## Files Created/Modified

- `src/resilience/fault-harness.ts` - closed failure schedule and exact-effect comparison boundary.
- `src/model/reconciliation.ts` - finite claim, lookup, record, and release observations.
- `src/publication/publication-service.ts` - finite publication claim, observe, and record observations.
- `tests/phase-07/fault-matrix.test.ts` - original-operation tracers and complete D-122 schedule inventory.

## Decisions Made

- Reconciliation observations are frozen, allowlisted lifecycle facts only; callbacks receive no state mutation or external-effect capability.
- The deterministic suite provides contract proof for protected-live rows but does not certify those provider or regional failures as live passes.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

The pre-existing Wave 0 `test.todo` in `tests/phase-07/fault-matrix.test.ts` remains owned by Plan 07-09 and is already recorded in `.planning/WINDOWS.md`; this plan adds executable D-122 coverage without claiming that later cross-plan authority observation.

## User Setup Required

None.

## Next Phase Readiness

Plan 07-09 can consume the closed schedule/oracle surface for its actual-authority evidence without allowing synthetic recovery to certify protected-live provider or regional cases.

## Self-Check: PASSED

- Declared source and test files exist.
- All four task commits exist.
- Focused matrix and full Bun suite passed: 454 pass, 5 intentional existing TODOs, 0 failures.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-05*
