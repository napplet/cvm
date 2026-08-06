---
phase: 07-admission-slo-resilience-launch-safety
plan: "38"
subsystem: release-certification
tags: [release-controller, authorization, native-registry, protected-evidence, tdd]
requires:
  - phase: 07-37
    provides: complete native provider registry and real protected-port composition
provides:
  - receipt-bound versioned release-controller execution and resume states
  - immutable native-operation and exact-eight protected-record journals
  - materialization guarded by fresh Modal/Fly selection evidence
affects: [07-39, protected-live-run, release-promotion]
tech-stack:
  added: []
  patterns: [persist-before-effect, original-operation reconciliation, exact-eight evidence indexing]
key-files:
  created: [tests/release/live-controller.test.ts]
  modified: [src/release/contracts.ts, src/release/controller.ts, src/release/materialize-certifier.ts]
key-decisions:
  - "Live execution upgrades to v2 state only after an exact authorization receipt; v1 historical state remains decodable."
  - "Only fresh passed same-candidate/topology Modal or Fly comparison evidence may select a worker in materialized configuration."
  - "The production protected registry remains the sole evaluator and every one of its eight records is indexed before finalization."
patterns-established:
  - "Persist operation identity before plan/apply; resume unknown work by observing that same operation ID."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Receipt-gated resumable controller path with no native effect for malformed authorization.
    requirement: SESS-02
    verification:
      - kind: integration
        ref: tests/release/live-controller.test.ts#authorized tracer rejects absent or mismatched receipt before a native effect
        status: pass
    human_judgment: false
  - id: D2
    description: Exact eight protected records retain blocked results and stop finalization.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: tests/release/live-controller.test.ts#all protected-suite records are retained and block finalization when real evidence is unavailable
        status: pass
    human_judgment: false
  - id: D3
    description: Materializer accepts only fresh evidence-selected Modal/Fly worker identity bound to the observed topology.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/release/materialize-certifier.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 7m
  completed: 2026-08-06
status: complete
---

# Phase 07 Plan 38: Resumable Authorized Release Controller Summary

**Receipt-bound release execution now journals native provision, observed topology, evidence-selected worker materialization, and exact-eight protected-suite results without creating provider clients or bypass evaluators.**

## Performance

- **Duration:** 7m
- **Started:** 2026-08-06T15:55:04Z
- **Completed:** 2026-08-06T16:01:59Z
- **Tasks:** 2/2
- **Files modified:** 4

## Accomplishments

- Added backwards-compatible v2 live-controller states, digest-chain checks, exact receipt binding, and explicit blocked terminal paths.
- Persisted native operation identities before planning/applying and reconciled ambiguous operations by their original IDs.
- Materialized only observed topology inputs and fresh passed Modal/Fly worker selection evidence; composed the production exact-eight registry and retained every non-pass record.

## Task Commits

1. **Task 1: Resume one authorized run through provisioning and one protected suite** - `f15a74e`, `9051ecd` (test, feat)
2. **Task 2: Execute all protected suites and every requirement edge** - `ca6ee1f`, `6fbedca` (test)

## Files Created/Modified

- `src/release/contracts.ts` - Versioned live execution states and finite block reasons.
- `src/release/controller.ts` - Exact-receipt runner, persisted native-operation reconciliation, production protected-suite composition, and immutable suite indexes.
- `src/release/materialize-certifier.ts` - Fresh evidence-selected worker materialization with same candidate/topology binding.
- `tests/release/live-controller.test.ts` - Injected fake coverage for no-effect authorization rejection and exact-eight non-pass retention.

## Decisions Made

- Preserve v1 records and migrate only a receipt-authorized run to v2, avoiding historical-record rewrites.
- Keep the production registry and its canonical eight suites as the sole evaluation route.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Issues Encountered

Repository-wide TypeScript checking reports existing errors outside this plan's owned files. Focused release suites pass.

## User Setup Required

None - all verification used injected fakes; no provider, network, credential, spend, payment, publication, or external-resource effect was performed.

## Next Phase Readiness

Plan 07-39 can consume the receipt-bound execution and exact-eight evidence journals. A protected run still requires the separately authorized provider/consent checkpoint.

## Self-Check: PASSED

- Required source files and `tests/release/live-controller.test.ts` exist.
- Task commits `f15a74e`, `9051ecd`, `ca6ee1f`, and `6fbedca` exist.
