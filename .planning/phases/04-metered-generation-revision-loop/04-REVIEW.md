---
phase: 04-metered-generation-revision-loop
reviewed: 2026-08-04T22:20:46Z
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
  critical: 7
  warning: 3
  info: 1
  total: 11
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-08-04T22:20:46Z
**Depth:** standard
**Files Reviewed:** 31
**Status:** issues_found

## Summary

The deterministic in-memory tests pass, but the production PostgreSQL path is not executable against its migration and does not uphold the metering/session guarantees required by D-59 through D-77.  The primary concerns are a schema-to-query mismatch, duplicate billable dispatch after a crash or multi-instance retry, an authorization ceiling that does not bound the dispatched model profile, and missing durable session/artifact lineage updates.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Production metered SQL queries target columns and states that the migration never creates

**Classification:** BLOCKER

**File:** `src/persistence/postgres-sql-funding-store.ts:74`

**Issue:** The production store selects and updates `receipt_charge`, `provider_receipt_reference`, `session_version`, `artifact_version`, `remaining_cap_sat`, and `remaining_balance_sat` (also at lines 176, 207, and 220). `metered_actions` in the supplied migration has none of those columns, and its state constraint allows `active`/`verified`, while the code writes/reads the mapped action lifecycle. The first production action will therefore fail with PostgreSQL “column does not exist” errors; the passing Phase 04 suite only exercises the memory store.

**Fix:** Make one authoritative schema contract. Add the required columns and compatible state transitions in a forward migration (or change every query to the actual columns), then add a PostgreSQL migration/integration test that performs prepare → claim → receipt → finalization.

### CR-02: A non-owner of the provider-operation claim dispatches the provider again

**Classification:** BLOCKER

**File:** `src/phase-04/metered-generation-service.ts:139-142`

**Issue:** `claimProviderOperation` is the durable external-effect fence, but a caller that receives `{ claimed: false, action: { result: undefined } }` falls through to `gateway.dispatch`. This happens after a process restart, when another Cloud Run instance owns the active operation, or whenever the original caller has persisted the claim but not yet finalized it. It converts a persisted “exactly once” provider intent into multiple fresh billable provider requests, violating D-65/D-67.

**Fix:** Dispatch only when `claim.claimed` is true. When it is false and no terminal result exists, return a non-dispatch pending/usage-unknown result or perform the original-operation lookup recovery; never call `dispatch` from that branch. Add a cross-instance/crash-after-claim test using a fresh service instance.

### CR-03: The authorized action amount is user-supplied, not the computed maximum charge of the dispatched profile

**Classification:** BLOCKER

**File:** `src/phase-04/metered-generation-service.ts:131-142`

**Issue:** The service reserves `command.maximum` and passes that same value as the operation reservation, but dispatches the fixed `code-proposal` profile whose maximum units are 1,000 input + 1,000 output + 500 cached + 500 reasoning tokens. At the pinned rates this profile can cost 3,500 sats, while a caller can submit `maximum: "1"`. The receipt is only rejected after the provider has already been asked to spend up to the profile maximum, so the service does not enforce the approved cap before external spend as D-59 requires.

**Fix:** Calculate `maximumOperationCharge({ card, profile })` before authorization; reject an action whose remaining approved cap/balance cannot cover it, and reserve that calculated ceiling (or a verified, profile-bounded sub-reservation). Add a test with a one-sat command maximum and profile-max receipt that proves no dispatch occurs.

### CR-04: Finalization never advances the durable PostgreSQL session or records the verified artifact

**Classification:** BLOCKER

**File:** `src/persistence/postgres-sql-funding-store.ts:209-222`

**Issue:** `finalizeMeteredAction` debits and stores the action result, but never updates `metered_sessions.version`, `state`, `confirmed_spend_sat`, or `current_verified_artifact_version`, and never inserts `session_artifacts`. Consequently `sessionStatus()` continues to return the `prepared` session inserted at line 179, and a production revision is denied as not revision-ready even after a completed action. It also leaves the database without the accepted artifact identity it claims to expose.

**Fix:** In the same serializable finalization transaction, conditionally advance the session version/state and spend, persist a verified `session_artifacts` row only for a verified artifact, and retain the previous artifact/version on failure. Fence the update on expected session version and test a production-backed start followed by revision/status.

### CR-05: Pending or unresolved reconciliation permanently consumes the sole lookup claim

**Classification:** BLOCKER

**File:** `src/model/reconciliation.ts:59-68`

**Issue:** The service first inserts/claims a reconciliation record, then returns `RECONCILIATION_PENDING` or `RECONCILIATION_UNRESOLVED` without releasing or expiring that claim. Every later call sees `claimed: false` and returns pending at lines 60-63 without another original-operation lookup. A temporary provider pending state therefore blocks the user's session indefinitely, contrary to the required durable lookup recovery.

**Fix:** Model an in-flight reconciliation lease with expiry (or release the claim after a nonterminal lookup), preserving the “no fresh dispatch” invariant while allowing a later lookup of the original request. Add a test where the first lookup is pending and a subsequent lookup finds a receipt, asserting one dispatch and two lookups.

### CR-06: Revisions and repairs are not durably bound to their prior workspace/artifact lineage

**Classification:** BLOCKER

**File:** `src/phase-04/metered-generation-service.ts:165`

**Issue:** The harness invocation always constructs `workspaceLineage` from the session ID and injects a service-wide `snapshotReference` and `priorArtifactId`; it does not read them from durable session state. No reviewed implementation writes the migration's `session_artifacts` table or a workspace/checkpoint lineage record. Thus different sessions can be run with the same configured prior artifact/snapshot, and a successful result is represented only by an incremented number rather than the verifier's artifact ID. This breaks D-70/D-71/D-74's same-lineage and artifact-truth guarantees.

**Fix:** Persist a session-bound workspace/checkpoint reference and accepted artifact identity during finalization; load and verify those facts before revision/repair; pass them to the harness instead of process configuration. Validate the supplied repair failed-artifact/report references against persisted evidence, and add a two-session isolation test plus restart/resume lineage tests.

### CR-07: Production status cursors are signed with a process-local random key

**Classification:** BLOCKER

**File:** `src/phase-03/funded-core.ts:103-106`

**Issue:** If `statusCursorSecret` is omitted, every `createFundedCore` instance creates a new random HMAC key. A cursor issued by one Cloud Run replica (or before a restart) is invalid on another replica, even for the same owner/session and unchanged billing history. This violates the promised stable paginated owner history in the multi-instance/multi-region deployment model.

**Fix:** Require a stable server-managed cursor secret in every non-test composition (for example, injected from the secret manager), rotate it deliberately with a versioned cursor key ID, and add a test that a cursor issued by one independently created production composition is accepted by another.

## Warnings

### WR-01: A thrown provider dispatch leaves an active action with no ambiguity record

**Classification:** WARNING

**File:** `src/phase-04/metered-generation-service.ts:142`

**Issue:** Only a returned `usage_unknown` observation is persisted. If `gateway.dispatch` throws after the provider may have accepted the request, the exception escapes before `recordUsageUnknown`; the durable action remains `dispatching` and the next invocation reaches the duplicate-dispatch path. This loses the user-visible reconciliation state and makes a transient transport failure unsafe to retry.

**Fix:** Wrap dispatch in an ambiguity boundary. Persist `usage_unknown` with the stored provider request correlation/evidence whenever acceptance cannot be disproved, then return the reconciliation-required result. Test a gateway that throws after acceptance.

### WR-02: Status turns database failures into an `invalid_cursor` client response

**Classification:** WARNING

**File:** `src/phase-04/session-status.ts:142-167`

**Issue:** The broad `catch` covers account and billing-store reads, not just cursor parsing. A database outage, serialization failure, or malformed stored record is silently reported as `invalid_cursor`, which is false, prevents callers/operators from distinguishing service failure, and makes retry behavior misleading.

**Fix:** Limit cursor-error handling to cursor decode/verification and return or propagate a separate safe internal-unavailable result for durable-read failures. Add fault-injection coverage for `status()` and `listBillingLineItems()` throws.

### WR-03: The TypeScript source uses an invalid private-method declaration

**Classification:** WARNING

**File:** `src/phase-04/metered-generation-service.ts:185`

**Issue:** `private async #serializeSession` combines an accessibility modifier with a `#` private identifier. TypeScript rejects this form (`TS18010`), so a normal type-check cannot compile this changed module even though Bun's test transpilation runs it.

**Fix:** Use either `async #serializeSession(...)` or `private async serializeSession(...)`, and add the repository's Bun-aware TypeScript check to CI.

## Info

### IN-01: The design-evidence gate does not compare declared effect counts with runtime observations

**Classification:** INFO

**File:** `tests/evals/phase-04-reference-set.test.ts:79-83`

**Issue:** Each reference case merely runs the named test and treats its exit code as execution proof. The fixture's expected counts are self-declared and the verifier copies/sums them at `scripts/verify-phase-04-design-slice.ts:26-39`; no runtime result is captured and compared to each case's provider/worker/receipt/debit/release oracle. A changed test with incomplete assertions can therefore leave the evidence claiming unchanged exact effect totals.

**Fix:** Have each reference case emit a structured runtime oracle from the actual service double/store, parse it in the evaluator, and compare every field against the fixture before building evidence.

---

_Reviewed: 2026-08-04T22:20:46Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
