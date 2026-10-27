---
phase: 07-admission-slo-resilience-launch-safety
plan: "60"
subsystem: production-accounting
tags: [postgresql, accounting-realm, custody, recovery, serializable]
requires:
  - phase: 07-58
    provides: production architecture and no-effect migration boundary
provides:
  - Zero-funded production-real PostgreSQL monetary realm isolated from development-test history
  - Realm-bound funding database, immutable encrypted custody, and replay-safe rail-operation persistence
affects: [07-61, 07-62, production funding, rail reconciliation]
tech-stack:
  added: []
  patterns: [schema-per-realm, least-privilege roles, catalog-verified cloned constraints, bounded serializable retries]
key-files:
  created: [migrations/phase-03/002_production_accounting.sql, src/funding/accounting-realm.ts, tests/funding/production-accounting-realm.test.ts]
  modified: [src/persistence/postgres-funding-database.ts, src/phase-03/funded-core.ts, tests/persistence/postgres-sql-funding-store.test.ts]
decisions:
  - "Development history remains in public under its writable private development login; the history role is read-only, while production-real money starts empty in its own schema and role."
  - "Cloned Phase 04-06 foreign keys and trigger functions are reconstructed against production_real and rejected if any bind to public."
  - "Rail custody is ciphertext-only and append-only; serializable retries resolve only the original immutable operation identity."
metrics:
  tasks_completed: 2
  files_changed: 7
  completed_at: 2026-10-27
status: complete
---

# Phase 07 Plan 60: Production Accounting Realm Summary

**A zero-funded, least-privilege PostgreSQL production ledger now remains structurally separate from preserved development-test history, with encrypted custody and replay-safe rail recovery.**

## Accomplishments

- Classified legacy public monetary history as `development-test` without changing its balances or receipts; active development sessions reset to their private writable login and pin `public, pg_catalog`, while the history role is read-only.
- Bound `PostgresFundingDatabase` to its selected realm and blocked either current-user or session-user superuser authority, wrong roles, development markers, and custom store/executor production bypasses.
- Added encrypted, immutable Cashu/Lightning custody records and original-operation persistence with account/rail FKs, semantic proof replay fencing, transition audits, and bounded serializable retries.
- Rebuilt every cloned Phase 04-06 foreign key only after all production tables exist, bound cloned immutability triggers to production-local functions, and fail the migration for public FK/default/trigger bindings.

## Task Commits

1. **Task 1: Bind accounts, receipts, holds, and operations to an accounting realm** — `2b92e37`, `a567ed9`, `8b40218`, `2c58eb7`, `cd97de5`
2. **Task 2: Add durable custody and uncertain-operation records** — `411fd4c`, `2c58eb7`

## Verification

- `NAPPLET_RUN_POSTGRES_ISOLATION=1 bun test tests/funding/production-accounting-realm.test.ts --timeout 130000` — **3 passed, 51 assertions**.
  - Runs one uniquely named PostgreSQL 17 container on Docker `bridge` with a dynamic loopback port and removes only that container.
  - Proves ordinary development migrations permit a private, writable `createDevelopmentFunding()` credit, while the production role cannot read or write public history and a public-funded mapped principal is refused before a production credit.
  - Proves a session authenticated as PostgreSQL superuser cannot bind the production realm, even where `SET ROLE` could otherwise obscure that authority.
  - Proves production credit, reservation, actual metered usage receipt plus final settlement/billing records, and concurrent cap competition against the restricted role. Receipt and ledger data remain immutable to that application role.
  - Audits `pg_constraint`, defaults, and trigger function namespaces to ensure cloned production relations do not resolve to public authority.
  - Proves original-operation replay returns the current state without redispatch, concurrent create/replay elects exactly one creator, and semantic Cashu proof reuse across accounts fails.
- `bun test tests/funding tests/persistence tests/phase-03 tests/phase-04 --timeout 30000` — **94 passed, 1 intentional opt-in PostgreSQL skip, 0 failed**.
- `bun test tests/funding/production-accounting-realm.test.ts tests/persistence/postgres-sql-funding-store.test.ts tests/funding/funded-admission.test.ts --timeout 30000` — **25 passed, 1 intentional opt-in PostgreSQL skip, 0 failed**.

## Decisions Made

- Production deployment must connect through a least-privilege member of `napplet_production_real`; application code selects the fixed realm role and cannot impersonate a superuser.
- Development execution retains its existing private writable login and is explicitly pinned to `public`; `napplet_development_history` is a read-only history authority, never an active application role.
- A `testOnly` funded-core composition cannot receive `production-real` accounting authority, preventing fixtures and test rails from touching the real ledger.
- Custody stores only ciphertext, a 12-byte AES-GCM nonce, digest, broker key reference, and safe rail metadata. Raw Cashu proofs, NWC connection strings, invoices, and preimages remain absent.
- Future rail dispatch must call `uncertainRailOperations.createOrReplay()` first and observe only its returned original operation ID. Retries return stored state instead of issuing a second effect.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical verification] Added and completed real PostgreSQL 17 isolation coverage**
- **Found during:** Task 1
- **Issue:** Scripted clients could not prove role privileges, production/public constraint targets, clone bindings, or real funding serialization.
- **Fix:** Added an opt-in local PG17 test covering actual production-role credit, reservation, concurrent cap competition, custody, operation replay, and catalog isolation.
- **Files modified:** `tests/funding/production-accounting-realm.test.ts`
- **Verification:** Explicit `NAPPLET_RUN_POSTGRES_ISOLATION=1` command passes.
- **Committed in:** `2c58eb7`

**2. [Rule 1 - Bug] Repaired cloned realm references and the leaked test connection**
- **Found during:** Task 1 review verification
- **Issue:** Clone-generated FKs could resolve to public, cloned tables lacked local immutability trigger bindings, and an assertion failure held a checked-out test client so pool shutdown appeared to hang.
- **Fix:** Rebuilt all clone FKs after creating the full graph, bound production-local trigger functions, asserted catalog isolation, and released the test client in `finally`.
- **Files modified:** `migrations/phase-03/002_production_accounting.sql`, `tests/funding/production-accounting-realm.test.ts`
- **Verification:** PG17 catalog audit and test shutdown pass.
- **Committed in:** `2c58eb7`

**3. [Rule 2 - Missing critical functionality] Added bounded replay-safe custody and operation transactions**
- **Found during:** Task 2 review verification
- **Issue:** New production repositories had unbounded/no retry handling; custody attempted `FOR UPDATE` despite the deliberate absence of UPDATE privilege.
- **Fix:** Added a three-attempt serializable transaction helper with database lock/statement bounds and unique-key replay handling; custody remains append-only.
- **Files modified:** `src/persistence/postgres-funding-database.ts`
- **Verification:** Concurrent operation test and real PG custody flow pass.
- **Committed in:** `2c58eb7`

**4. [Rule 1 - Compatibility bug] Restored the active development funding realm**
- **Found during:** Post-review verification
- **Issue:** The realm binder unconditionally rejected a superuser and attempted `SET ROLE napplet_development_history`, but ordinary development migrations do not create that history role and development funding needs a writable private authority.
- **Fix:** Development binding now resets any pooled role and pins `public, pg_catalog`; production remains strict and checks both `current_user` and `session_user` for superuser authority.
- **Files modified:** `src/funding/accounting-realm.ts`, `tests/funding/production-accounting-realm.test.ts`
- **Verification:** The real PG17 test performs an ordinary-development `createDevelopmentFunding()` credit before the production migration, then rejects a superuser production bind.
- **Committed in:** `cd97de5`

**5. [Rule 2 - Missing critical boundary] Denied production authority in test-only composition and proved real settlement**
- **Found during:** Post-review verification
- **Issue:** `testOnly` could be combined with a supplied production database, allowing fixture rails/rates to access real accounting. The prior PG proof did not reach receipt/final settlement writes.
- **Fix:** Reject production realm at `createFundedCore()` before construction; add the mapped-public-balance refusal and an actual restricted-role reserve, receipt, finalize, replay, and immutability proof.
- **Files modified:** `src/phase-03/funded-core.ts`, `migrations/phase-03/002_production_accounting.sql`, `tests/funding/production-accounting-realm.test.ts`
- **Verification:** PG17 test passes with 51 assertions.
- **Committed in:** `cd97de5`

**Total deviations:** 5 auto-fixed (3 Rule 1, 2 Rule 2). **Impact:** Both real production isolation and ordinary local development remain usable without crossing monetary authorities.

## Known Limitations

- This is no-effect preparation: it does not provision Cloud SQL, assign production login credentials, connect Lightning/Cashu/NWC, or authorize real-money movement.
- The PG17 proof is intentionally opt-in locally and explicitly run by the payment CI workflow; ordinary unit runs do not start Docker.
- `bun scripts/dev-payments.ts test` could not start its Docker Compose network because this machine's predefined Docker address pools are exhausted. No shared networks were pruned or changed; the ordinary-development migration/credit path is nevertheless covered by the isolated PG17 proof above.

## Next Phase Readiness

Plans 07-61 and 07-62 can use the narrow `custody` and `uncertainRailOperations` ports for encrypted recovery and query-only reconciliation. They must keep provider dispatch outside retries and retain the original persisted operation ID.

## Self-Check: PASSED

- Required migration, realm contract, database capability, funded-core, and focused test files exist.
- Task commits `2b92e37`, `411fd4c`, `a567ed9`, `8b40218`, `2c58eb7`, and `cd97de5` exist on the current branch.
- The final real-PG and requested Phase 03/04 regression commands passed as recorded above.
