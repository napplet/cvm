---
phase: 04-metered-generation-revision-loop
fixed_at: 2026-08-04T23:30:00Z
review_path: /Users/sandwich/Develop/napplet-cvm/.planning/phases/04-metered-generation-revision-loop/04-REVIEW.md
iteration: 2
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 04: Code Review Fix Report

**Fixed at:** 2026-08-04T23:30:00Z
**Source review:** `/Users/sandwich/Develop/napplet-cvm/.planning/phases/04-metered-generation-revision-loop/04-REVIEW.md`
**Iteration:** 2

**Summary:**

- Findings in scope: 6
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: Provider work can be dispatched with a ceiling far above the approved action maximum

**Files modified:** `src/phase-04/metered-generation-service.ts`, `tests/phase-04/tracer.test.ts`, `tests/phase-04/revision.test.ts`
**Commit:** a65904c
**Applied fix:** Computes and reserves the profile worst-case charge before preparation and rejects lower approvals before dispatch.

### CR-02: Production finalization never advances the durable session or records its verified artifact

**Files modified:** `src/persistence/postgres-sql-funding-store.ts`
**Commit:** e8abe4b
**Applied fix:** Conditionally advances durable session state/spend and inserts a verified artifact lineage record in the settlement transaction.

### CR-03: Released action capacity remains permanently counted against later revision budgets

**Files modified:** `src/persistence/funding-store.ts`, `src/persistence/postgres-funding-store.ts`, `src/persistence/postgres-sql-funding-store.ts`, `tests/billing/operation-finalization.test.ts`
**Commit:** c17283e
**Applied fix:** Adds reservation lifecycle state and releases finalized reservation capacity; covers a second reservation using the remaining cap.

### CR-04: Reconciliation persists a terminal result that the action replay API cannot parse

**Files modified:** `src/phase-04/metered-generation-service.ts`, `src/model/reconciliation.ts`, `tests/model/reconciliation.test.ts`
**Commit:** d868b4f
**Applied fix:** Uses the shared replayable failed-action contract for reconciliation terminal outcomes.

### CR-05: Completed dispatch receipts are priced without binding them to the persisted provider operation

**Files modified:** `src/model/model-gateway.ts`, `src/model/deterministic-model-gateway.ts`, `src/model/reconciliation.ts`, `src/phase-04/metered-generation-service.ts`, `tests/model/reconciliation.test.ts`, `tests/phase-04/revision.test.ts`, `tests/phase-04/tracer.test.ts`
**Commit:** 1e0d89c
**Applied fix:** Requires the coordinator-generated persisted request correlation and operation ID before pricing or settlement.

### CR-06: Lookup exceptions strand reconciliation in its open claim state indefinitely

**Files modified:** `src/model/reconciliation.ts`, `tests/model/reconciliation.test.ts`
**Commit:** d868b4f
**Applied fix:** Releases the durable claim on every exceptional or nonterminal lookup path, with a retry regression test.

---

_Fixed: 2026-08-04T23:30:00Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 2_
