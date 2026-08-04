---
phase: 03-contextvm-funding-funded-admission
reviewed: 2026-08-04T00:00:00Z
depth: deep
files_reviewed: 25
files_reviewed_list:
  - migrations/phase-03/001_funding.sql
  - src/contextvm/adapter.ts
  - src/contextvm/sdk-bridge.ts
  - src/funding/account-status.ts
  - src/funding/cashu-provider.ts
  - src/funding/cashu-top-up.ts
  - src/funding/funded-admission.ts
  - src/funding/funding-service.ts
  - src/funding/lightning-provider.ts
  - src/funding/lightning-top-up.ts
  - src/funding/protected-rail-material.ts
  - src/persistence/funding-store.ts
  - src/persistence/postgres-funding-database.ts
  - src/persistence/postgres-funding-store.ts
  - src/persistence/postgres-sql-funding-store.ts
  - src/phase-03/contracts.ts
  - src/phase-03/funded-core.ts
  - src/verification/phase-03-design-evidence.ts
  - tests/contextvm/adapter.test.ts
  - tests/evals/phase-03-reference-set.test.ts
  - tests/funding/cashu-top-up.test.ts
  - tests/funding/funded-admission.test.ts
  - tests/funding/lightning-top-up.test.ts
  - tests/persistence/postgres-sql-funding-store.test.ts
  - tests/verification/phase-03-design-slice.test.ts
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 03: Final Code Review Re-Review Report

**Reviewed:** 2026-08-04
**Depth:** deep
**Files Reviewed:** 25
**Status:** clean

## Summary

The audit-closure work resolves the earlier owner-status, Cashu owner-scope, fixture-oracle, response-redaction, database-port, vault-composition, and basic deadline findings. Lightning and coordinator-level Cashu waits now return `reconciliation_pending` on expiry and abort their signals. The evidence registry is independent of `item.expected.evidence`, including a mutation regression.

The final closure is sound at the reviewed boundaries. Cashu mint requests receive the operation signal, an opaque deadline becomes `reconciliation_pending`, and query-only proof-state reconciliation can credit a consumed proof exactly once. Capacity compensation now attempts external release even when the preliminary fence write fails; the exact FAIL_4 dual-persistence-failure and previous FAIL_5 finalization-failure scenarios both refuse without a second reservation or acceptance.

No remaining blockers or warnings were found in the reviewed Phase 3 scope.

## Narrative Findings (AI reviewer)

## Revalidated Audit-Closure Work

- `AccountStatusService` now merges an injected rail-status projection. `PostgresRailStatusProjection` filters both Lightning and Cashu rows by `accountId`, and ContextVM tests cover pending, failed, reconciliation-pending, credited, cross-owner exclusion, and redaction.
- Cashu `submit()` compares existing/claimed records' owner, idempotency key, amount, and commitment before replaying a lifecycle result; the cross-owner regression now denies access.
- The reference evaluator maps every fixture input to an individual in-process oracle. Its complete `scenarioEvidence` registry is not read from `item.expected.evidence`; the T-03-26 mutation regression proves a fixture-controlled evidence value disagrees with the independently produced evidence value.
- `ContextVmFundingAdapter` parses a coordinator result but serializes only an explicit wire allowlist; bearer tokens, proofs, invoices, and protected-material references cannot pass through newly added coordinator fields.
- `PostgresFundingDatabase` owns the narrow rail repositories, encrypted-material repository, and owner-filtered status port; production composition rejects substitute rail coordinators and builds both rails around that database-owned vault.
- `PostgresSqlFundingStore` and capacity operations have bounded waits. Lightning receiver calls and Cashu mint HTTP requests receive the operation signal and return durable reconciliation state at their deadline. The default Cashu adapter's proof-state query reconstructs the token only inside the protected rail boundary and reconciles a consumed proof without a second swap.
- The exact FAIL_4 reproduction now has the required result: first and retry both refuse, with `reserves: 1`, `releases: 1`, `observations: 0`, `acceptance: 0`, and `holds: 0`. `bestEffortCapacityFence()` cannot suppress external compensation, and the final released state prevents later reuse.
- The previous FAIL_5 path remains closed: external release followed by finalization-write failure is reconciliation-pending and a retry observes rather than accepts. The default Cashu adapter regression proves every mint HTTP request gets the coordinator signal and a spent proof is credited once through query-only reconciliation.
- The design-evidence gate enforces the complete named threat mapping set and rejects raw bearer/secret-like material.

## Gates Run

- `bun test` — PASS (266 tests)
- `bun run eval:phase-03` — PASS (22 fixture-specific oracle cases)
- `bun run test:phase-03-design-slice` — PASS (`design-ready`; all live-provider observations remain blocked/unselected)

---

_Reviewed: 2026-08-04T00:00:00Z_
_Reviewer: gsd-code-reviewer_
_Depth: deep_
