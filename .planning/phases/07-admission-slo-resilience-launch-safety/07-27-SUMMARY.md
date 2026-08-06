---
phase: 07-admission-slo-resilience-launch-safety
plan: "27"
subsystem: certification
tags: [cloud-sql, release-provider-port, capability-matrix, resilience, tdd]
requires:
  - phase: 07-25
    provides: protected release composition and controller-owned authorization boundary
provides:
  - Cloud SQL for PostgreSQL as the sole current Phase 7 database authority
  - Provider-family capability matrix with protected-suite and fail-closed ownership
  - Cloud SQL-bound protected infrastructure drill schemas and fixtures
affects: [07-28, 07-29, 07-30, 07-31, 07-32, 07-33, 07-34, 07-35, 07-36, 07-37, 07-38, 07-39]
tech-stack:
  added: []
  patterns: [controller-derived authorization, provider-neutral ports, candidate-bound blocked evidence]
key-files:
  created:
    - .planning/phases/07-admission-slo-resilience-launch-safety/07-27-SUMMARY.md
  modified:
    - .planning/PROJECT.md
    - .planning/research/STACK.md
    - .planning/research/SUMMARY.md
    - AGENTS.md
    - .planning/phases/07-admission-slo-resilience-launch-safety/07-CONTEXT.md
    - .planning/phases/07-admission-slo-resilience-launch-safety/07-RESEARCH.md
    - .planning/phases/07-admission-slo-resilience-launch-safety/COVERAGE.md
    - docs/runbooks/release-certification.md
    - src/certification/phase-07-reference-set.ts
    - src/resilience/fault-harness.ts
    - tests/phase-07/restore-drill.test.ts
decisions:
  - Cloud SQL for PostgreSQL is the sole current Phase 7 database provider detail; ReleaseProviderPort and the controller remain provider-neutral.
  - Every D-128 capability is integrated through a plan-owned protected suite and becomes immutable blocked evidence when discovery prerequisites are absent.
  - Protected infrastructure evidence accepts only gcs, cloud_run, and cloud_sql_postgres, and remains non-pass without protected execution.
metrics:
  duration: 5m
  completed_date: 2026-08-06
  tasks_completed: 3
  files_modified: 11
status: complete
---

# Phase 07 Plan 27: Current Authority and Capability Coverage Summary

Cloud SQL authority now flows from current product/research guidance through the closed protected-infrastructure evidence schema, while release orchestration stays provider-neutral and every live integration has a fail-closed owner.

## Completed Tasks

1. Replaced superseded current database guidance in the project, stack, research synthesis, and generated agent guidance while retaining the provider-neutral release boundary.
2. Added the D-128 capability matrix with owner plans, protected suite consumers, discovery modes, and blocked absence states; tightened the operator runbook to consent plus one exact digest approval.
3. Ran RED/GREEN TDD for the protected infrastructure inventory and updated the launch fixture, schema, and restore drill to the exact `gcs`, `cloud_run`, `cloud_sql_postgres` set.

## Verification

- PASS: current guidance authority scan finds Cloud SQL in all four required documents and no superseded database or CLI identifier.
- PASS: coverage matrix includes all 16 required capability IDs and all `SESS-02`/`OPS-01`–`OPS-04` edges.
- PASS: `bun test tests/phase-07/restore-drill.test.ts` — 6 passing tests, 49 assertions.
- PASS: targeted current-source scan confirms the three executable authority files use `cloud_sql_postgres` and contain no superseded identifiers.
- PASS: ASVS L1 high/critical blocking policy remains present in the plan.
- PASS: no executor diff in completed Phase 7 summaries or `evidence/`.

## TDD Gate Compliance

- RED: `9657c89` added the Cloud SQL component expectation; the focused test failed before implementation because the old closed schema rejected it.
- GREEN: `acbf9dd` updated schemas and `observeLaunch`; the focused suite passed afterward.

## Decisions Made

- Cloud SQL for PostgreSQL is the selected database provider detail; provider selection and release control remain behind `ReleaseProviderPort` and controller contracts.
- D-128 integrations require controller-owned discovery and protected-suite evidence; missing credentials stay explicit blocked evidence.

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

- Required current guidance, matrix, runbook, runtime source, and restore-drill files exist.
- Task commits `303f34d`, `49b5930`, `9657c89`, and `acbf9dd` exist in git history.
- No plan-owned stubs were introduced; existing empty defaults in source/test helper signatures do not flow to a UI or alter the protected evidence contract.
