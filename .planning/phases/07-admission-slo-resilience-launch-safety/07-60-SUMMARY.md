---
phase: 07-admission-slo-resilience-launch-safety
plan: "60"
subsystem: production-accounting
tags: [postgresql, accounting-realm, custody, recovery]
dependency_graph:
  requires: [07-58]
  provides: [production-real-ledger-realm, encrypted-rail-custody, uncertain-operation-audit]
  affects: [07-61, 07-62]
tech_stack:
  added: []
  patterns: [schema-per-realm, least-privilege-roles, serializable-operation-transitions]
key_files:
  created: [migrations/phase-03/002_production_accounting.sql, src/funding/accounting-realm.ts, tests/funding/production-accounting-realm.test.ts]
  modified: [src/persistence/postgres-funding-database.ts, src/phase-03/funded-core.ts]
decisions:
  - "Existing public monetary rows are permanently classified development-test; production money uses a fresh production_real schema and role."
  - "Cashu/NWC recovery stores ciphertext, digests, broker key references, and original operation identities only."
metrics:
  tasks_completed: 2
  files_changed: 5
  completed_at: 2026-10-27
status: complete
---

# Phase 07 Plan 60: Production Accounting Realm Summary

Preserved development-test ledger history is separated from a zero-funded production-real PostgreSQL realm with role enforcement, encrypted custody metadata, and immutable rail-operation recovery identities.

## Tasks Completed

1. **Bind accounts, receipts, holds, and operations to an accounting realm** — `2b92e37`
   - Added the additive migration that classifies legacy public monetary rows as `development-test` without changing balances or receipt values.
   - Created the zero-funded `production_real` schema plus distinct production/history roles and grants.
   - Bound `PostgresFundingDatabase` and `createFundedCore` to a finite realm contract; non-test construction defaults to `production-real` and checks development-only configuration markers.

2. **Add durable custody and uncertain-operation records** — `411fd4c`
   - Added immutable ciphertext-only custody rows with key references, digests, Cashu identity metadata, and no bearer material columns.
   - Added an original-operation repository with serializable create/replay, state transitions, and append-only audit rows.
   - Exposed only narrow custody and uncertain-operation ports from `PostgresFundingDatabase`.

## Verification

- `NAPPLET_RUN_POSTGRES_ISOLATION=1 bun test tests/funding/production-accounting-realm.test.ts tests/persistence/postgres-sql-funding-store.test.ts --timeout 120000`
  - 12 passed, 0 failed, 47 assertions.
  - The integration test starts a uniquely named PostgreSQL 17 container on Docker's existing `bridge` network with a dynamic loopback port, and removes only that container.
  - It proves retained test history, an empty production ledger, equal account/idempotency identifiers in separate realms, mutual role denial, replay identity conflict, invalid state-transition rejection, and immutable custody rejection.

## Decisions Made

- Application SQL is realm-bound through a per-connection `search_path`; deployment credentials must log in as the matching least-privilege database role rather than application code impersonating a role.
- `rail_custody_material` accepts ciphertext, AES-GCM nonce, digest, and secret-broker key reference. Cashu proof bytes and NWC connection material are intentionally absent.
- Rail reconciliation in Plans 07-61/62 must call `uncertainRailOperations.createOrReplay()` before a provider dispatch, use the returned original operation ID for observation only, and persist encrypted inputs/outputs through `custody`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical verification] Added a real PostgreSQL 17 isolation test**
- **Found during:** Task 1
- **Issue:** The existing scripted SQL-client test cannot prove schema separation, role privileges, constraints, or trigger behavior.
- **Fix:** Added an opt-in real container test and ran it with `NAPPLET_RUN_POSTGRES_ISOLATION=1`.
- **Files modified:** `tests/funding/production-accounting-realm.test.ts`
- **Commit:** `2b92e37`, `411fd4c`

**Total deviations:** 1 auto-fixed. **Impact:** The plan has database-engine evidence instead of mock-only coverage.

## Known Limitations

- This is a no-effect schema and repository change. It does not provision Cloud SQL, assign production login credentials, migrate later Phase 4–6 tables into the production schema, or perform Lightning/Cashu/NWC I/O.
- The PG17 check is intentionally environment-gated so ordinary unit runs do not start Docker; production accounting changes require the explicit command above in CI/release validation.

## Self-Check: PASSED

- Required migration, realm contract, and focused test files exist.
- Task commits `2b92e37` and `411fd4c` exist on the current branch.
