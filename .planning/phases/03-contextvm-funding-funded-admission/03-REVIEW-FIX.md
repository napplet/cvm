---
phase: 03-contextvm-funding-funded-admission
fixed_at: 2026-08-04T18:32:00+01:00
review_path: .planning/phases/03-contextvm-funding-funded-admission/03-REVIEW.md
iteration: 3
findings_in_scope: 9
fixed: 9
skipped: 0
status: all_fixed
---

# Phase 03: Architectural Review Fix Report

## Fixed Issues

### Durable owner-scoped account status

`AccountStatusService` now joins the monetary projection with a narrow `AccountTopUpStatusPort`. The PostgreSQL database adapter reads redacted Lightning and Cashu lifecycle records, filters them by the principal-derived account ID, and merges them with credited ledger rows without duplicating a top-up. Pending, verifying, failed, reconciliation-pending, and credited states use one strict public schema with optional settlement-only fields.

Regression coverage exercises the database projection, cross-owner exclusion, lifecycle merge, recursive redaction, and the public ContextVM `account_status` route.

### Database-only SQL ownership

Raw `PostgresSqlPool` access and PostgreSQL repository classes were removed from both rail modules. `PostgresFundingDatabase` is now the sole SQL owner and exposes only capability-specific ports for the monetary store, Lightning lifecycle, Cashu lifecycle, rail status, and protected material. Rail coordinators receive those narrow ports and have no arbitrary query or credential capability.

### Encrypted durable Cashu composition

The public `createFundedCore` boundary no longer trusts coordinator `durable` booleans or caller-composed rail facades. A configured public surface requires a real `PostgresFundingDatabase`, both provider ports, a pinned Cashu policy registry, and a valid 32-byte key. The core constructs one AES-GCM `ProtectedRailMaterialVault` over the database-owned ciphertext repository and then constructs both coordinators itself. Structural durability claims fail closed.

The migration now persists account/top-up/rail-bound AES-GCM nonce, payload digest, ciphertext, expiry, and tombstone state; it has no plaintext column and no pre-credit foreign-key dependency on the credited-only `top_ups` table.

### Fixture-bound reference evaluation

The Phase 3 reference evaluator no longer spawns broad test-file groups. All 19 unique fixture inputs dispatch to an in-process scenario that starts from a fresh deterministic harness, exercises the relevant production boundary, and compares the observed result label, state delta, allowed/forbidden effect counts, and evidence oracle list exactly with that fixture's `expected` value.

Actual evidence now comes from a separate, complete named scenario-evidence registry. No executor reads or defaults from `item.expected.evidence`. A mutation regression changes fixture-expected evidence and proves the exercised oracle disagrees rather than reflecting attacker-controlled expected data.

### Complete threat mapping

Design evidence now requires every threat declared by plans 03-01 through 03-07, including supply-chain threats: `T-03-01` through `T-03-29` plus `T-03-02-SC`, `T-03-03-SC`, and `T-03-05-SC`. Missing, duplicate, or unknown mappings block the offline verdict.

### Bounded external waits

PostgreSQL-wire connection/query/retry work now has a validated absolute deadline as well as a maximum attempt count. Capacity reserve, observe, and release calls also have bounded waits; reserve/observe timeout becomes a durable reconciliation-pending outcome without a hold, while release timeout remains bounded and fail-closed.

Lightning invoice create/query and Cashu settle/observe/treasury calls now receive server-owned abort signals and share a validated coordinator deadline. Create/swap timeout records `reconciliation_pending` against the original durable intent, and replay is query-only rather than a blind second value effect. Treasury timeout records an explicit durable `unknown` state.

### Post-reservation compensation

Every durable write after an available capacity reservation, including the available-observation write and cap-hold transaction, is inside the compensation guard. Confirmed release durably closes the capacity intent and returns refusal. A timed-out or failed release instead persists `reconciliation_pending` with the original provider reference. Failure-injection coverage proves one reservation, one compensation attempt, no stranded hold, and no second reserve on retry.

## Regression and Implementation Commits

- `5d85e19` — RED regressions exposing the remaining architecture gaps.
- `683e6a2` — GREEN funded-core architecture, persistence ports, lifecycle status, threat mapping, fixture oracles, and bounded waits.
- `e1a6926` — RED regressions for evidence mutation, rail deadlines, and stranded capacity.
- `c38394a` — GREEN independent evidence oracles, bounded rail effects, and safe capacity compensation.
- `0bf4694` — abort-signal propagation for deadline-bound rail adapters.

## Verification

- `bun test` — pass: 262 tests, 0 failures, 1,151 expectations.
- `bun run eval:phase-03` — pass: 22 tests, 0 failures, 102 expectations; 19 fixture-bound scenario/oracle cases plus evidence-mutation regression.
- `bun run test:phase-03-design-slice` — pass: `design-ready`, offline verdict `passed`, evidence `5d000be03ef48a9aa03f3472389c85ba92280f36a944f36f0f99a4672d328b08`.
- `git diff --check` — pass.

All live ContextVM, Lightning, Cashu, PostgreSQL, capacity, and Modal observations remain honestly `blocked` / `unselected`; Phase 7 still owns live provider and SLO certification.

_Fixer: Phase 03 architectural audit worker_
