---
phase: 04-metered-generation-revision-loop
plan: 02
subsystem: metered-funding
tags: [postgresql, serializable-transactions, billing, idempotency]
dependency_graph:
  requires: [04-01]
  provides: [atomic-metered-settlement, immutable-billing-history]
  affects: [generation-service, funded-admission]
tech_stack:
  added: []
  patterns: [receipt-first-finalization, serializable-row-locking, owner-scoped-cursor-pagination]
key_files:
  created: [migrations/phase-04/001_metered_generation.sql, tests/billing/operation-finalization.test.ts, tests/billing/line-items.test.ts]
  modified: [src/persistence/funding-store.ts, src/persistence/postgres-sql-funding-store.ts, src/persistence/postgres-funding-store.ts, src/persistence/postgres-funding-database.ts]
decisions:
  - "Both PostgreSQL adapters expose the same metered authority while SQL retains the sole production transaction boundary."
  - "Finalization replays the stored terminal action when receipt identity and charge match, never creating a second debit."
metrics:
  duration: 24m
  completed_date: 2026-08-04
status: complete
---

# Phase 04 Plan 02: Serializable Metered Settlement Summary

PostgreSQL-backed metered action finalization now persists receipt-derived settlement and immutable owner-scoped billing history under one serializable transaction boundary.

## Completed Tasks

1. Defined the Phase 4 append-only metered schema, funding contract, replay-safe memory oracle, and bounded line-item history.
2. Added metered authority parity to both PostgreSQL adapters, including locking, terminal replay, invariant quarantine, and database-owned exposure.

## Verification

- `bun test tests/billing/operation-finalization.test.ts tests/billing/line-items.test.ts tests/persistence/postgres-sql-funding-store.test.ts tests/persistence/postgres-funding-store.test.ts tests/phase-03/tracer.test.ts --timeout 10000` — passed (17 tests).
- `git diff --check` — passed.
- Stub-pattern scan over all plan files — no stubs found.

## Commits

- `6eeee76` — RED: failing finalization and line-item contracts.
- `1863ef9` — GREEN: schema, memory oracle, and immutable history.
- `c28f2e1` — RED: PostgreSQL adapter metering parity contracts.
- `1292542` — GREEN: serializable PostgreSQL finalization authority.

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

- Required migration, persistence adapters, and billing tests exist.
- All four task commits exist in git history.
