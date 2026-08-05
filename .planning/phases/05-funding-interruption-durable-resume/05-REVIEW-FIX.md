---
phase: 05
iteration: final
findings_in_scope: 9
fixed: 7
skipped: 2
status: all_fixed
---

# Phase 05: Code Review Fix Report

All blocking review findings are closed. The two remaining items are explicit,
non-blocking verification/provider deferrals recorded in the clean review.

## Closed findings

- Durable funding pauses now use one persisted intent across memory and SQL paths, including first-start insufficient-funding cases.
- Continuation SQL persists the full resumable intent and enforces monotonic pause generations under a row lock.
- Checkpoint deletion records append-only audit outcomes and distinguishes pending, deleted, and terminal failure states.
- Worker effects, wake dispatch, and resume completion are fenced by the exact lease, action, operation, allocation, and accounting identities.
- Unknown wake outcomes reconcile to a single terminal release; late evidence cannot redispatch or debit, and public responses do not disclose private capabilities.
- Verified Lightning and Cashu credits now trigger owner-only durable pause discovery and feed exact stored tuples through the same-worker wake authority; replay and post-grace delivery remain no-duplicate/no-resume.
- Verified-credit PostgreSQL pause discovery shares the configured deadline across pool checkout and query execution.

## Fix commits

`6ebf0f7`, `3538362`, `c10cd0e`, `85ba0d1`, `07f0845`, `9d6bd93`,
`bcfa239`, `16c4242`, `6bfe3f2`, `26dac16`, `17c2ddc`, `04f177a`,
`5a166a1`, `338fb55`, `43f2f63`, and `6ce550e`.

## Deferred warnings

- The design-evidence observation table remains a closed, case-specific static mapping after exact named tests execute. Replacing it with richer per-case runtime extraction is verification-evidence design debt, not a Phase 5 runtime blocker.
- Live Modal, PostgreSQL, object-storage, KMS, latency, and multi-region certification remains intentionally assigned to Phase 7. No live-provider readiness is claimed by Phase 5.

## Verification

- Focused final gap-closure review suite: 43 passed, 0 failed.
- Full repository suite: 366 passed, 0 failed.
- Final review status: `clean` with no findings in the gap-closure scope; the two accepted design/provider deferrals remain documented above.
