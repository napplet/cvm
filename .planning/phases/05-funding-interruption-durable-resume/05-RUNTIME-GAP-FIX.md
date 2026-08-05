# Phase 05 Runtime Gap Fix

## Closed blockers

- CR-03: The third lookup-only `unknown` now atomically moves the original wake authorization to `released`, records an auditable release ledger/billing entry and outbox event, and leaves the pause/session in terminal reconciliation. Exact late `completed` evidence is retained as `late_evidence_requires_operator`, emits one explicit late-evidence outbox event, never redispatches, and never creates a second debit. Memory and SQL implementations use the same bounded state machine.
- CR-05: Resume preparation persists an immutable action ID, operation ID, and action-budget reference alongside the lease/allocation claim, then prepares and claims that exact metered action. Completion now requires all persisted fencing identities plus a terminal metered finalization; accounting, session finalization, and pause retirement share one transaction. Public ContextVM resume responses no longer expose allocation, budget, or lease capabilities.

## Commit

- `26dac16` `fix(05): close durable wake dispatch lifecycle gaps`
- `17c2ddc` `fix(05): lock latest pause generation compatibly`
- `04f177a` `fix(05): reconcile claimed wakes and fence live pauses`
- `5a166a1` `fix(05): wire wake recovery and resume retirement`
- `338fb55` `fix(05): close wake and resume accounting fences`

## Verification

- Focused final-review persistence, wake, status, deadline, resume, ContextVM, and SQL-parity tests: 51 passed, 0 failed.
- `bun test --timeout 10000`: 362 passed, 0 failed.
- Final code review: clean, 0 critical findings, 2 non-blocking warnings.
- `bunx tsc --noEmit`: blocked by existing project-wide Bun typings, `pg` declaration, and unrelated strictness errors; it is not a usable repository-wide gate yet.

## Remaining risk

The PostgreSQL-wire schema and transaction paths have deterministic SQL parity coverage only. Live PostgreSQL/provider certification remains explicitly deferred to Phase 7; no live-provider behavior is claimed here.
