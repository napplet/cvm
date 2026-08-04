---
phase: 04-metered-generation-revision-loop
fixed_at: 2026-08-04T23:59:00Z
review_path: /Users/sandwich/Develop/napplet-cvm/.planning/phases/04-metered-generation-revision-loop/04-REVIEW.md
iteration: 3
findings_in_scope: 4
fixed: 3
skipped: 1
status: partial
---

# Phase 04: Code Review Fix Report

**Fixed at:** 2026-08-04T23:59:00Z
**Source review:** `/Users/sandwich/Develop/napplet-cvm/.planning/phases/04-metered-generation-revision-loop/04-REVIEW.md`
**Iteration:** 3

**Summary:**

- Findings in scope: 4
- Fixed: 3
- Skipped: 1

## Fixed Issues

### CR-01: Production metered sessions reference profile/card rows that are never created

**Files modified:** `migrations/phase-04/001_metered_generation.sql`
**Commit:** a9068d4
**Applied fix:** The Phase 04 migration idempotently promotes the canonical pinned `code-proposal` profile and deterministic price card, including their normalized JSON and SHA-256 identities, before metered actions reference them.

### CR-02: Finalization discards the verifier-issued artifact and session-bound workspace/snapshot lineage

**Files modified:** `migrations/phase-04/001_metered_generation.sql`, `src/persistence/funding-store.ts`, `src/persistence/postgres-sql-funding-store.ts`, `src/phase-04/metered-generation-service.ts`, `src/phase-04/session-status.ts`, `tests/phase-04/session-status.test.ts`
**Commits:** e19cff7, 7ba345a
**Applied fix:** Atomic finalization now persists the verifier-issued artifact identity plus session-scoped workspace/checkpoint/snapshot and validation references; revisions read the prior durable lineage and status exposes the stored verified identity.

### CR-03: Stored terminal results retain placeholder cap and balance values, so replay lies after a restart

**Files modified:** `src/persistence/funding-store.ts`, `src/persistence/postgres-sql-funding-store.ts`, `src/phase-04/metered-generation-service.ts`, `src/model/reconciliation.ts`
**Commit:** 6d99431
**Applied fix:** The serializable finalization path overwrites terminal receipt financials with its committed charge, remaining cap, and remaining balance, and every first/replay/reconciliation caller returns that stored object.

## Skipped Issues

### WR-01: Design evidence marks self-declared effects as passed without observing them

**File:** `scripts/verify-phase-04-design-slice.ts:26`
**Reason:** The current reference-suite tests expose only exit status, not a common structured runtime-effect channel for all twenty fixtures. Adding that channel safely requires a coordinated test-harness contract across the fixtures; fabricating observations from the fixture was intentionally not used in this final pass.
**Original issue:** Evidence currently copies fixture effect counts and marks cases passed based on test exit codes rather than comparing runtime observations to every fixture oracle.

---

_Fixed: 2026-08-04T23:59:00Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 3_
