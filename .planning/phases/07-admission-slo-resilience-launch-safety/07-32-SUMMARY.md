---
phase: 07-admission-slo-resilience-launch-safety
plan: "32"
subsystem: worker certification and release providers
tags: [modal, fly, worker, admission-slo, evidence, security]
requires:
  - phase: 07-28
    provides: exact v2 receipt-gated release-provider boundary
  - phase: 07-29
    provides: injected native provider and original-operation patterns
provides:
  - Injected Modal and Fly worker-provider ports with bounded isolation policies
  - Exact 1,000-sample identical cohort evaluator and evidence-only worker selection
  - An explicitly unselected materializer profile until fresh protected evidence exists
affects: [07-33, 07-20, 07-25, 07-26, protected-certification]
tech-stack:
  added: []
  patterns: [injected provider SDK-command seams, exact-ready observations, original-operation reconciliation, fresh evidence-only selection]
key-files:
  created:
    - src/release/native/modal.ts
    - src/release/native/fly.ts
    - src/certification/live/worker-ports.ts
    - tests/release/modal-live-provider.test.ts
    - tests/release/fly-live-provider.test.ts
  modified:
    - src/release/materialize-certifier.ts
    - tests/release/materialize-certifier.test.ts
decisions:
  - Native adapters remain injected-only; ReleaseProviderRegistry owns exact receipt validation before mutation.
  - Modal and Fly receive the same fixed 1,000-accepted-sample schedule with forced 200 pool-hit and 200 pool-miss/cold/contention samples.
  - A worker selection is emitted only from fresh protected-live evidence that passes every isolation, cleanup, zero-backlog, and one-sided upper-p95 gate.
metrics:
  duration: 18m
  completed_date: 2026-08-06
  tasks_completed: 2
  files_modified: 7
requirements-completed: []
coverage:
  - id: D1
    description: Modal and Fly readiness ports enforce receipt-gated, bounded isolated-worker operations and reconcile the original provider operation.
    requirement: SESS-02
    verification:
      - kind: unit
        ref: tests/release/modal-live-provider.test.ts and tests/release/fly-live-provider.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Identical protected-live cohorts derive a selected provider and topology only when every locked SLO and safety threshold passes.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: tests/release/modal-live-provider.test.ts#identical protected cohorts select only fresh passed measured evidence
        status: pass
      - kind: integration
        ref: tests/release/fly-live-provider.test.ts#non-real stale unsafe or slow cohort evidence cannot select a worker
        status: pass
    human_judgment: false
status: complete
---

# Phase 07 Plan 32: Native Modal/Fly Worker Providers Summary

Modal and Fly now share receipt-gated, injected worker-provider contracts plus a locked protected-evidence benchmark that refuses to name a production winner without fresh passing observations.

## Completed Tasks

1. Added production-constructible Modal and Fly provider ports that use only injected SDK and command seams. They bind sealed image identity, bounded lifetime/resources, blocked build network, no inbound ports, original-operation reconciliation, exact-ready observations, and run-owned cleanup.
2. Added an exact shared D-116 cohort evaluator: each candidate receives 1,000 accepted samples with forced 200 pool-hit and 200 pool-miss/cold/contention samples. It structurally compares schedules and selects only fresh protected-live evidence with a one-sided p95 upper bound at or below 5,000 ms and zero backlog.

## Verification

- PASS: `bun test tests/release/modal-live-provider.test.ts tests/release/fly-live-provider.test.ts tests/release/live-operations-adapters.test.ts tests/release/materialize-certifier.test.ts` — 13 tests, 60 assertions.
- PASS: ASVS L1 high/critical block-policy source assertion.
- PASS: `git diff --check` and modified-file stub scan.
- No live provider effect occurred; all tests use injected in-process SDK/command doubles.

## TDD Gate Compliance

- RED: `2df3c56` added native provider contracts before either module existed; both suites failed with the expected missing-module errors.
- GREEN: `dd9b730` implemented injected Modal/Fly ports and passed the native adapter contracts.
- RED: `0b72062` added identical-cohort and evidence-only selection tests before the evaluator existed; both suites failed with the expected missing-module errors.
- GREEN: `69b74ab` implemented the fixed protected-evidence evaluator and removed the materializer’s default worker choice.

## Decisions Made

- Receipt validation stays at the established `ReleaseProviderRegistry` boundary; native ports neither parse credentials nor construct authenticated clients.
- Selection evidence contains only finite provider IDs, candidate/topology digests, counts, measured upper p95, rejection rate, and reason codes.
- Materialization is intentionally worker-unselected until a protected run supplies fresh selection evidence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Removed the materializer’s hardcoded Modal worker winner**
- **Found during:** Task 2
- **Issue:** `materialize-certifier.ts` set `candidate.provider` to `modal` before protected evidence could compare Modal and Fly, violating evidence-only selection.
- **Fix:** Emit explicit `unselected` worker state until the protected cohort evaluator produces fresh passed selection evidence.
- **Files modified:** `src/release/materialize-certifier.ts`, `tests/release/materialize-certifier.test.ts`
- **Verification:** Materializer and full focused adapter suites pass.
- **Committed in:** `69b74ab`

**2. [Rule 3 - Plan drift] Used current worker adapter and live-admission paths**
- **Found during:** Tasks 1–2
- **Issue:** The plan’s `src/worker/*` and `tests/certification/live-admission.test.ts` paths were renamed or absent in the repository.
- **Fix:** Used the current `src/worker-adapters/*` contracts and ran `tests/release/live-operations-adapters.test.ts`, which contains the live-admission protected-port assertions.
- **Files modified:** None outside planned artifacts.
- **Verification:** The focused suite passed all 13 tests.
- **Committed in:** `dd9b730`, `69b74ab`

**Total deviations:** 2 auto-fixed (1 security, 1 plan-drift compatibility). **Impact:** Selection is stricter and the plan’s intended behavior is preserved against the current repository layout.

## Known Stubs

None. Protected-live execution remains intentionally unavailable until its receipt-authorized plan; deterministic evidence cannot select a worker or create a live effect.

## Next Phase Readiness

Plan 07-33 can compose the next native integration through the same injected-only, receipt-gated, original-operation seams. The designated protected execution remains blocked until exact authorization and official provider consent are supplied.

## Self-Check: PASSED

- Required native provider, cohort evaluator, and test files exist.
- Task commits `2df3c56`, `dd9b730`, `0b72062`, and `69b74ab` exist in git history.
- No unresolved high/critical ASVS threat, stub, skipped test, unrun applicable verification, credential, or live provider effect was introduced.
