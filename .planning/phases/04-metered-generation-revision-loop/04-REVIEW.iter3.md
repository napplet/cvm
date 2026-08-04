---
phase: 04-metered-generation-revision-loop
reviewed: 2026-08-04T22:32:25Z
depth: standard
files_reviewed: 31
files_reviewed_list:
  - migrations/phase-04/001_metered_generation.sql
  - package.json
  - scripts/verify-phase-04-design-slice.ts
  - src/contextvm/adapter.ts
  - src/contextvm/announcement.ts
  - src/model/deterministic-model-gateway.ts
  - src/model/model-gateway.ts
  - src/model/price-card.ts
  - src/model/reconciliation.ts
  - src/persistence/funding-store.ts
  - src/persistence/postgres-funding-database.ts
  - src/persistence/postgres-funding-store.ts
  - src/persistence/postgres-sql-funding-store.ts
  - src/phase-03/funded-core.ts
  - src/phase-04/metered-generation-service.ts
  - src/phase-04/napplet-harness.ts
  - src/phase-04/repair-policy.ts
  - src/phase-04/session-status.ts
  - src/verification/phase-04-design-evidence.ts
  - tests/billing/line-items.test.ts
  - tests/billing/operation-finalization.test.ts
  - tests/billing/price-card.test.ts
  - tests/contextvm/adapter.test.ts
  - tests/evals/phase-04-reference-set.test.ts
  - tests/fixtures/phase-04-reference-set.json
  - tests/model/reconciliation.test.ts
  - tests/phase-04/artifact-outcome.test.ts
  - tests/phase-04/repair.test.ts
  - tests/phase-04/revision.test.ts
  - tests/phase-04/session-status.test.ts
  - tests/phase-04/tracer.test.ts
findings:
  critical: 6
  warning: 0
  info: 1
  total: 7
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-08-04T22:32:25Z
**Depth:** standard
**Files Reviewed:** 31
**Status:** issues_found

## Summary

All 43 scoped tests pass, but they exercise deterministic memory stores rather than the production PostgreSQL lifecycle. Iteration 1 correctly fixed the migration/query-column parity, non-owner dispatch, nonterminal reconciliation release, dispatch-exception ambiguity recording, durable-read error response, invalid private syntax, and production cursor-secret requirement. Three original blockers remain unresolved (profile ceiling, durable session/artifact state, and lineage), and this review found three additional correctness failures in reservation reuse, terminal reconciliation replay, and exception recovery.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Provider work can be dispatched with a ceiling far above the approved action maximum

**Classification:** BLOCKER

**File:** `src/phase-04/metered-generation-service.ts:131-145`

**Issue:** The service authorizes and reserves the caller-provided `command.maximum`, then always dispatches the `code-proposal` profile. Its own `maximumOperationCharge()` calculates that profile's maximum charge as 3,250 sats (`src/model/price-card.ts:68-74`), but a caller may authorize one sat. The service only rejects an oversized receipt after dispatch at line 164, so the provider can consume up to the profile limit before the user-approved cap is enforced.

**Fix:** Compute the profile/card maximum before `authorizeActionBudget`; reject insufficient action/session capacity before dispatch and reserve that verified ceiling (or constrain the provider request to a similarly verified lower ceiling). Add a one-sat authorization test asserting zero dispatches.

### CR-02: Production finalization never advances the durable session or records its verified artifact

**Classification:** BLOCKER

**File:** `src/persistence/postgres-sql-funding-store.ts:175-182,216-229`

**Issue:** Preparation inserts a `metered_sessions` row as `prepared`, but finalization only mutates `metered_actions`, account balances, and line items. It never updates `metered_sessions.version`, `state`, `confirmed_spend_sat`, or `current_verified_artifact_version`, and never inserts the migration's `session_artifacts` record (`migrations/phase-04/001_metered_generation.sql:61-65`). Production `sessionStatus()` consequently keeps returning `prepared`; `reviseSession()` rejects the completed session as not revision-ready. There is also no durable artifact ID/evidence for a successful result.

**Fix:** Extend finalization with artifact identity, lineage, and evidence; in the same serializable transaction conditionally advance the session on its expected version, update spend/current verified version, and insert a verified `session_artifacts` row. Preserve the prior verified artifact on failed actions and cover production-backed start → status → revision.

### CR-03: Released action capacity remains permanently counted against later revision budgets

**Classification:** BLOCKER

**File:** `src/persistence/postgres-sql-funding-store.ts:174,216-228`

**Issue:** `reserveActionBudget()` rejects a new reservation using the sum of every historical `action_budget_reservations.amount` (line 174). Finalization emits a `release` line item for `action.maximum - charge` (line 228), but it never marks/releases that reservation, so the next action still counts the whole previous maximum. For example, a 200-sat cap, a 100-sat first reservation, and a 15-sat charge leaves 185 sats held, but a second 100-sat revision is rejected because `185 - 100 < 100`. The memory stores repeat the same defect at `src/persistence/funding-store.ts:233-239,288-308` and `src/persistence/postgres-funding-store.ts:132-135,168-179`.

**Fix:** Give action-budget reservations a consumed/released state (or calculate reserved capacity from active residual reservations only) and atomically release `maximum - charge` during finalization. Add a test that spends below a first action maximum and successfully uses the resulting remaining session cap in a later revision.

### CR-04: Reconciliation persists a terminal result that the action replay API cannot parse

**Classification:** BLOCKER

**File:** `src/model/reconciliation.ts:71-92`

**Issue:** Reconciliation finalizes the metered action with `ReconciliationResult` values such as `{ status: "failed", code: "RECONCILED_RECEIPT_FOUND" }`. The normal idempotent start/revision and status-by-key paths parse every persisted action result with `SessionActionResultSchema` (`src/phase-04/metered-generation-service.ts:61-63,126-128`), whose failed branch only permits `WORKER_OR_ARTIFACT_FAILED` and requires spend, balance, cap, and version fields. Retrying an action after a receipt-found reconciliation therefore throws a Zod error instead of returning the durable result.

**Fix:** Persist a canonical `SessionActionResult` for reconciliation finalization (or widen the shared durable result contract and every consumer deliberately), including final balances/versions. Add an idempotent retry test after both receipt-found and definitive-not-accepted reconciliation.

### CR-05: Completed dispatch receipts are priced without binding them to the persisted provider operation

**Classification:** BLOCKER

**File:** `src/phase-04/metered-generation-service.ts:145-170`

**Issue:** Unlike reconciliation, the normal dispatch path never checks `receipt.operationId` or `receipt.providerRequestId` before calling `priceReceipt`, recording the receipt, and debiting the account. `NormalizedUsageReceiptSchema` only validates shape, and `priceReceipt()` checks model/profile/card but not the current operation correlation. A compromised or faulty gateway can therefore attach a syntactically valid receipt from another request to this action, producing an inaccurate irreversible debit and receipt attribution.

**Fix:** Persist a coordinator-generated provider request correlation before dispatch, then require both it and `receipt.operationId` to match the claimed operation before pricing. Treat any mismatch as `usage_unknown`/reconciliation rather than settling it; add a dispatch-path mismatch test.

### CR-06: Lookup exceptions strand reconciliation in its open claim state indefinitely

**Classification:** BLOCKER

**File:** `src/model/reconciliation.ts:59-90`

**Issue:** The iteration-1 fix releases claims for returned `pending` and `unresolved` observations, but `gateway.lookup()`, receipt parsing/correlation, and finalization are outside a recovery `try` block. If lookup throws after `claimReconciliation()` succeeds, the durable `provider_reconciliations` row remains `open`. All later callers take the `!claim.claimed` branch at lines 60-63 and return `RECONCILIATION_PENDING` without another lookup, permanently stranding a recoverable charged operation.

**Fix:** Wrap lookup and subsequent nonterminal validation in a `try/finally` that releases the claim unless terminal finalization committed; preserve no-redispatch behavior. Add a lookup-throws-then-receipt-found retry test.

## Info

### IN-01: Reference-set effect totals are declared rather than measured

**Classification:** INFO

**File:** `tests/evals/phase-04-reference-set.test.ts:79-83`

**Issue:** The evaluator runs a named test and checks only its exit code. The fixture's expected effect counts are self-declared, and `scripts/verify-phase-04-design-slice.ts:26-39` merely aggregates those declarations. A test can pass while no runtime oracle verifies the claimed dispatch, receipt, debit, and release counts.

**Fix:** Have each reference case expose structured runtime effect data from its actual store/gateway double and compare each field to the fixture before evidence generation.

---

_Reviewed: 2026-08-04T22:32:25Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
