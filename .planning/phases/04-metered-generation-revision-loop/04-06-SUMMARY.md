---
phase: 04
plan: 06
subsystem: verification
tags: [billing, reconciliation, session, artifact, contextvm, evidence]
requires:
  - 04-01
  - 04-02
  - 04-03
  - 04-04
  - 04-05
provides:
  - deterministic 20-case Phase 4 release evidence gate
  - immutable Phase 4 design evidence
affects: [phase-04-verification, phase-07-provider-certification]
tech-stack:
  added: []
  patterns: [actual-service reference cases, canonical content-addressed evidence, provider-separated observations]
key-files:
  created:
    - tests/fixtures/phase-04-reference-set.json
    - tests/evals/phase-04-reference-set.test.ts
    - src/verification/phase-04-design-evidence.ts
    - scripts/verify-phase-04-design-slice.ts
  modified:
    - package.json
decisions:
  - "The deterministic gateway remains unselected; live-model observation is explicitly not observed."
  - "Phase 4 evidence uses twenty actual authority tests with exact effect signatures and immutable create-or-verify records."
metrics:
  duration: 34m 37s
  completed: 2026-08-04
  tasks_completed: 2
  files_changed: 7
status: complete
---

# Phase 04 Plan 06: Deterministic Phase 4 Evidence Gate Summary

Twenty deterministic authority cases now verify the Phase 4 billing, provider-operation, ambiguity, serialized revision/repair, retained-artifact, owner-status, and thin ContextVM boundaries; their canonical evidence remains provider-separated and immutable.

## Completed Tasks

1. Added exactly twenty uniquely identified reference cases, each mapped to actual Phase 4 service tests, requirements, D-59–D-78, threats, bounded inputs, durable setup, schedule, and exact effect oracle.
2. Added a strict content-addressed evidence evaluator/writer plus `eval:phase04` and `verify:phase04-design` commands. The verifier runs Phase 4 wave suites, validates mappings and redaction, rereads canonical evidence, and reports zero credential inputs.

## Verification

- `bun test` — 301 passed, 0 failed.
- `bun run eval:phase04` — 5 passed, 0 failed.
- `bun run verify:phase04-design` — 34 Phase 4 suite tests and 5 evidence-gate tests passed.
- Evidence digest: `b206699843fc03d3803c41fddef895d215f59885e3427603a731bb8084183217`.

## Decisions Made

- Live provider/model selection, credentialed execution, latency, availability, and cost certification stay `unselected`/`not_observed` for Phase 7.
- Reference-case evidence exercises project-owned deterministic authorities rather than making fixtures an authority.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Self-Check

PASSED — required files and commits `00d40f2`, `46d7bbd`, `fef92b0`, and `858b45b` exist; no task commit deleted tracked files.
