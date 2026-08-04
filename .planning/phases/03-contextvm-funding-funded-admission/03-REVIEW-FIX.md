---
phase: 03-contextvm-funding-funded-admission
fixed_at: 2026-08-04T18:51:51+01:00
review_path: .planning/phases/03-contextvm-funding-funded-admission/03-REVIEW.md
iteration: 5
findings_in_scope: 12
fixed: 12
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

### Query-reconcilable default Cashu settlement

The production `CashuTsSettlementAdapter` now binds the server-owned `AbortSignal` to every mint request made by the real cashu-ts `Mint` and `Wallet` path, including mint loading, key discovery, swap, and proof-state observation. An ambiguous swap keeps the original top-up and token commitment as its operation identity; reconciliation opens the encrypted token only for a NUT-07 proof-state query and never performs a second swap. All-spent proofs resolve the original operation as verified, all-unspent proofs resolve it as failed, and mixed or pending states remain unknown.

Regression coverage exercises the default cashu-ts wallet path with only the HTTP request function stubbed. It proves that the load and swap requests receive the aborted settlement signal and that a later query with a fresh signal observes consumed proofs and credits exactly once under the original operation reference.

### Durable capacity-release ambiguity fence

Capacity compensation now persists `reconciliation_pending` before calling the external release. If the provider confirms release but the final `released` persistence write fails, the durable pre-release fence prevents a retry from trusting the stale `available` observation and admitting work. Retry must query capacity state before it can proceed.

The exact `FAIL_5_RELEASE_INTENT_PERSISTENCE` regression proves one external reserve, one external release, one retry observation, one acceptance attempt, zero cap holds, and zero accepted admissions.

### Persistence failures cannot suppress capacity release

The pre-release reconciliation fence is now best effort: failure to persist it cannot prevent the already-reserved external capacity from being released. After the bounded release attempt, compensation persists the confirmed `released` result when possible and otherwise retries the `reconciliation_pending` fence. In the reproduced initial-write failure, the durable dispatch claim remains fail-closed until one of those later states can be recorded.

The exact dual-failure regression rejects both the initial available-state write and the pre-release fence with `FAIL_3` and `FAIL_4`. It proves the first call still completes as refused and an exact retry remains refused with one reserve, one release, zero observations, zero acceptance attempts, and zero holds.

## Regression and Implementation Commits

- `5d85e19` — RED regressions exposing the remaining architecture gaps.
- `683e6a2` — GREEN funded-core architecture, persistence ports, lifecycle status, threat mapping, fixture oracles, and bounded waits.
- `e1a6926` — RED regressions for evidence mutation, rail deadlines, and stranded capacity.
- `c38394a` — GREEN independent evidence oracles, bounded rail effects, and safe capacity compensation.
- `0bf4694` — abort-signal propagation for deadline-bound rail adapters.
- `e4494a3` — RED regressions for default-wallet Cashu reconciliation and failed capacity-release finalization.
- `a23596b` — GREEN query-reconcilable Cashu settlement and durable capacity-release ambiguity fencing.
- `1f938f3` — RED regression proving a failed pre-release fence suppressed external compensation.
- `490768c` — GREEN best-effort pre-fencing with post-release result persistence and ambiguity fallback.

## Verification

- `bun test` — pass: 266 tests, 0 failures, 1,172 expectations.
- `bun run eval:phase-03` — pass: 22 tests, 0 failures, 102 expectations; 19 fixture-bound scenario/oracle cases plus evidence-mutation regression.
- `bun run test:phase-03-design-slice` — pass: `design-ready`, offline verdict `passed`, evidence `7beb4957b2bc3ff79ba9207f8d91ed1f86b3e06eabf2d7a64e8b9681192f2f08`.
- `git diff --check` — pass.

All live ContextVM, Lightning, Cashu, PostgreSQL, capacity, and Modal observations remain honestly `blocked` / `unselected`; Phase 7 still owns live provider and SLO certification.

_Fixer: Phase 03 architectural audit worker_
