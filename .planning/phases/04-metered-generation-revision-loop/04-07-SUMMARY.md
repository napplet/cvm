---
phase: 04-metered-generation-revision-loop
plan: 07
subsystem: verification
tags: [phase-04, runtime-observation, evidence, billing, sessions]
requires:
  - phase: 04-06
    provides: twenty deterministic Phase 04 authority probes and fail-closed evidence gate
provides:
  - fact-only dispatch into all twenty Phase 04 runtime probes
  - static anti-regression guards and cross-category wrong-oracle tests
  - evidence validation that re-derives case results and aggregates from observations
affects: [phase-04-formal-reverification, phase-07-provider-certification]
tech-stack:
  added: []
  patterns: [fact-only runtime probe inputs, observed-only evidence aggregation, static fixture-isolation guards]
key-files:
  created:
    - .planning/phases/04-metered-generation-revision-loop/04-07-SUMMARY.md
  modified:
    - tests/evals/phase-04-runtime-observation.ts
    - tests/evals/phase-04-runtime-financial.ts
    - tests/evals/phase-04-runtime-session-artifact.ts
    - tests/evals/phase-04-reference-set.test.ts
    - tests/support/phase-04/session-artifact-probes.ts
decisions:
  - "Runtime scenarios receive boundedInput, initialState, and schedule only; expected values remain comparator-only."
  - "Phase 04 remains pending formal re-verification even though this plan's evidence-integrity work is complete."
metrics:
  duration: 28m
  completed: 2026-08-05
  tasks_completed: 3
  files_changed: 6
status: complete
---

# Phase 04 Plan 07: Runtime Observation Integrity Summary

The twenty-case Phase 04 gate now feeds bounded case facts into actual authority probes and derives design evidence solely from compared runtime observations.

## Completed Tasks

1. Preserved the strict observation/comparison schema while forwarding every case's `boundedInput`, `initialState`, and `schedule` to the selected financial or session/artifact authority probe.
2. Made pricing, funded start, finalization, history pagination, revisions, ambiguity handling, artifact/repair, status, and ContextVM probes validate and use their relevant scenario facts; retained the existing named source assertions as a separate required child gate.
3. Added static fixture-isolation guards, four-category recomputed-oracle mismatch coverage, and loaded-record validation proving result/aggregate re-derivation from observed values.

## Runtime Authority Audit

| Case ID | Actual authority | Facts used |
| --- | --- | --- |
| P04-AUTH-01 | `priceReceipt` | receipt units, pinned card, price schedule |
| P04-AUTH-02 | `priceReceipt` identity rejection | reservation, pinned profile, rejection schedule |
| P04-AUTH-03 | `MeteredGenerationService.startSession` | empty idea, funded cap, admission-before-effects schedule |
| P04-AUTH-04 | `ContextVmFundingAdapter` | ContextVM transport/tool, allowlist schedule |
| P04-ACCT-01 | transactional finalization store | charge, balance/hold, finalize/replay schedule |
| P04-ACCT-02 | owner line-item store projection | page limit, history count, ascending-pages schedule |
| P04-ACCT-03 | funded service + deterministic gateway + worker + verifier | maximum, balance, cap, duplicate-start schedule |
| P04-ACCT-04 | reconciliation service + gateway | receipt lookup/action state, concurrent lookup schedule |
| P04-SER-01 | rational `priceReceipt` | dimension count, reservation, canonical-order schedule |
| P04-SER-02 | serialized `reviseSession` | revision text, session version, duplicate-revision schedule |
| P04-SER-03 | version-fenced `reviseSession` | expected/session version, stale-writer schedule |
| P04-AMB-01 | ambiguous gateway dispatch/lookup | timeout operation, persisted intent, original-lookup schedule |
| P04-AMB-02 | malformed-receipt gateway path | malformed receipt, persisted intent, normalization schedule |
| P04-AMB-03 | definitive-zero reconciliation | lookup/action state, definitive-zero schedule |
| P04-ART-01 | `ProjectNappletHarness` | workflow/artifact baseline, promoted-workflow schedule |
| P04-ART-02 | rejecting `ProjectNappletHarness` verifier | invalid candidate/artifact baseline, failure schedule |
| P04-ART-03 | `evaluateAutomaticRepair` | prior repair/session version, second-repair schedule |
| P04-ADV-01 | repair-command schema + policy | prompt exclusion/coordinator-only repair, rejection schedule |
| P04-ADV-02 | owner-gated `readSessionStatus` | missing/foreign session, owner-check schedule |
| P04-STATUS-01 | owner status projection | page limit, artifact/history baseline, cursor/page schedule |

## Verification

- `bun test tests/evals/phase-04-reference-set.test.ts --timeout 10000` — passed.
- `bun test tests/evals/phase-04-reference-set.test.ts --test-name-pattern='numeric, state|loaded design evidence|mismatched oracle' --timeout 10000` — passed.
- `bun run eval:phase04` — passed.
- `bun run verify:phase04-design` — passed; evidence digest `010225b0e5758aec9edcafd13b35eca0b722c28f78721e74b83aa1e31562f91f`.
- `bun test` — passed.
- `git diff --check` — passed.

## Decisions Made

- Fact validation is intentionally in the probes, where it configures or bounds the exercised authority; neither fixture `expected` data nor its `oracle` checksum can enter a probe signature.
- Content-addressed records and the current pointer are only created after all comparisons pass. Generated evidence remains untracked here; no transient pointer or record is staged by this plan.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Next Phase Readiness

The evidence-integrity implementation is complete. Phase 04 is deliberately still pending its formal re-verification/review workflow; this summary does not declare the phase or its requirements formally complete.

## Self-Check

PASSED — all five runtime/test files above exist, the gate executes exactly twenty comparisons, and the generated design record validates by re-evaluation.
