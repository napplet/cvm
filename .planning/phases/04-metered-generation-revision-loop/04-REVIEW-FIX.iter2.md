---
phase: 04-metered-generation-revision-loop
fixed_at: 2026-08-04T23:00:00Z
review_path: /Users/sandwich/Develop/napplet-cvm/.planning/phases/04-metered-generation-revision-loop/04-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 7
skipped: 3
status: partial
---

# Phase 04: Code Review Fix Report

**Fixed at:** 2026-08-04T23:00:00Z
**Source review:** `/Users/sandwich/Develop/napplet-cvm/.planning/phases/04-metered-generation-revision-loop/04-REVIEW.md`
**Iteration:** 1

**Summary:**

- Findings in scope: 10
- Fixed: 7
- Skipped: 3

## Fixed Issues

### CR-01: Production metered SQL queries target columns and states that the migration never creates

**Files modified:** `migrations/phase-04/001_metered_generation.sql`, `tests/persistence/phase-04-sql-schema-parity.test.ts`
**Commit:** `7d0fdc6`
**Applied fix:** Added the finalized-action columns read and written by the SQL store, with a regression test that checks migration/query parity.

### CR-02: A non-owner of the provider-operation claim dispatches the provider again

**Files modified:** `src/phase-04/metered-generation-service.ts`, `tests/phase-04/revision.test.ts`
**Commit:** `adf3a92`
**Applied fix:** Only the claim owner dispatches; fresh coordinators receive a reconciliation-required result for an in-flight operation.

### CR-05: Pending or unresolved reconciliation permanently consumes the sole lookup claim

**Files modified:** `src/model/reconciliation.ts`, `src/persistence/funding-store.ts`, `src/persistence/postgres-funding-store.ts`, `src/persistence/postgres-sql-funding-store.ts`, `tests/model/reconciliation.test.ts`
**Commit:** `cebcf69`
**Applied fix:** Nonterminal lookup results release the durable claim, permitting later lookup-only recovery without redispatch.

### CR-07: Production status cursors are signed with a process-local random key

**Files modified:** `src/phase-03/funded-core.ts`, `tests/funding/funded-admission.test.ts`
**Commit:** `745be76`
**Applied fix:** Production generation compositions require injected stable cursor-secret material.

### WR-01: A thrown provider dispatch leaves an active action with no ambiguity record

**Files modified:** `src/phase-04/metered-generation-service.ts`, `tests/phase-04/revision.test.ts`
**Commit:** `41b283c`
**Applied fix:** Dispatch exceptions become durable usage-unknown records and return reconciliation-required results.

### WR-02: Status turns database failures into an invalid_cursor client response

**Files modified:** `src/phase-04/session-status.ts`, `tests/phase-04/session-status.test.ts`
**Commit:** `9ac4c86`
**Applied fix:** Durable read failures now return the distinct safe `service_unavailable` result.

### WR-03: The TypeScript source uses an invalid private-method declaration

**Files modified:** `src/phase-04/metered-generation-service.ts`
**Commit:** `45650e9`
**Applied fix:** Removed the illegal accessibility modifier from the `#` private method; the targeted compiler diagnostic is gone.

## Skipped Issues

### CR-03: The authorized action amount is user-supplied, not the computed maximum charge of the dispatched profile

**File:** `src/phase-04/metered-generation-service.ts:131`
**Reason:** Requires reworking the public action-budget contract and all low-cap deterministic fixtures to reserve the profile's 3,500-sat maximum before provider dispatch; a partial local check would make every existing action fixture fail without providing a safe migration path.
**Original issue:** Caller-provided maximum can be lower than the fixed profile's maximum external charge.

### CR-04: Finalization never advances the durable PostgreSQL session or records the verified artifact

**File:** `src/persistence/postgres-sql-funding-store.ts:209`
**Reason:** The current finalization input carries only an artifact version, not the verifier-issued artifact ID, workspace lineage, snapshot, or validation evidence required for an atomic `session_artifacts` row. This needs a coordinated contract change across harness, finalization, SQL, and tests.
**Original issue:** PostgreSQL finalization does not persist session state/artifact truth.

### CR-06: Revisions and repairs are not durably bound to their prior workspace/artifact lineage

**File:** `src/phase-04/metered-generation-service.ts:165`
**Reason:** Depends on the missing durable artifact/workspace lineage contract in CR-04; process-level harness configuration cannot safely be converted to durable lineage in isolation.
**Original issue:** Continuations use configured rather than persisted workspace and artifact lineage.

---

_Fixed: 2026-08-04T23:00:00Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 1_
