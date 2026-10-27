---
phase: 07-admission-slo-resilience-launch-safety
plan: "62"
subsystem: payments
status: implementation_complete
requirements-completed: []
completed: 2026-10-27
key-files:
  created:
    - src/funding/nwc-receipt-port.ts
    - migrations/phase-03/004_production_rail_material_scope.sql
    - tests/funding/lightning-lost-create.test.ts
    - tests/funding/lightning-lost-create-postgres.test.ts
  modified:
    - src/funding/lightning-provider.ts
    - src/funding/lightning-top-up.ts
    - src/persistence/postgres-funding-database.ts
    - .github/workflows/development-payments.yml
---

# Plan 62 — Original NWC invoice recovery

Lost invoice creation responses now recover through the persisted original intent without dispatching another `make_invoice`.

The coordinator persists the operation ID, production/development realm, connection scope digest, privacy-safe description hash, exact amount, incoming type and fixed creation window before provider dispatch. The NWC receipt adapter first supports observing a retained authenticated response to the original event, then bounded NWC-05 transaction history when consent permits. It includes unpaid invoices and reads complete pages of at most 20 records (200-record total bound), rejecting partial traversal, changed totals, duplicates, multiple matches, mismatches and expired records. The invoice identity is persisted before `lookup_invoice` can authorize settlement.

The adapter consumes an authenticated NIP-47 transport interface; Plan 66 owns its actual broker/relay composition and signed event persistence. Deterministic provider responses here do not establish live wallet compatibility or production certification.

## Evidence

- Focused Lightning tests: 21 passed, 120 assertions, including lost-before-hash recovery, fresh coordinators, concurrency, retained original response, unsupported permission, altered realm/scope/operation, missing or ambiguous matches and later-page duplicates.
- Lightning plus funded-admission regression: 35 passed, 176 assertions.
- `NAPPLET_RUN_POSTGRES_ISOLATION=1 bun test tests/funding/lightning-lost-create-postgres.test.ts --timeout 120000`: 1 passed, 11 assertions against PostgreSQL 17 with a restricted production role. Simultaneous first claims create one invoice; fresh repositories reconcile and credit once; public development top-ups remain empty.
- PostgreSQL test initially reproduced an unhandled serialization conflict, then a zero-credit failure from the settlement-before-custody foreign key. Both were repaired and the actual coordinator path passed.
- No TypeScript diagnostics in the new Lightning provider/coordinator/adapter/tests. Repository-wide TypeScript failures elsewhere remain unresolved and are not waived.
- No live wallet, real money, cloud deployment or protected suite effects occurred.

## Necessary integration repairs

`PostgresLightningLifecycleRepository` now uses the bounded serializable retry helper and establishes its global row before locking it. The durable creation claim remains the single dispatch authority.

Migration 004 replaces the impossible dependency from pending encrypted material to a completed monetary top-up with an immutable account/top-up/rail ownership scope. Existing encrypted rows are backfilled without deletion. A fresh scope creates a zero-money account identity; only verified funding transactions change balances. Production migration and rollback preparation must preserve these scopes and pending ciphertext.

Commits: `227d7e9` and `7db48a3`. PR review and merged-mainline CI remain acceptance prerequisites. OPS-02/OPS-04 remain unverified until the authorized protected payment suite passes.
