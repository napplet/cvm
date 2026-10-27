---
phase: 07-admission-slo-resilience-launch-safety
plan: "61"
subsystem: payments
tags: [cashu, cashu-ts, postgres, custody, nut-09, replay-protection]
requires:
  - phase: 07-60
    provides: production accounting realm and PostgreSQL custody capabilities
provides:
  - encrypted Cashu swap input/output custody journal with one-dispatch fencing
  - NUT-09 recovery constrained to persisted original blinded messages
  - semantic proof replay identities in both public and production PostgreSQL realms
affects: [funding, ContextVM top-ups, production accounting]
tech-stack:
  added: []
  patterns: [persist-before-swap, original-message-only recovery, semantic proof claim fencing]
key-files:
  created: [migrations/phase-03/003_cashu_custody_and_identities.sql]
  modified: [src/funding/cashu-provider.ts, src/funding/cashu-top-up.ts, src/persistence/postgres-funding-database.ts, src/phase-03/funded-core.ts]
key-decisions:
  - "A spent input is insufficient for credit; only encrypted verified owned outputs or NUT-09 recovery of the original output data can verify a settlement."
  - "Production composition admits only the default custody-capable Cashu adapter; explicit fake/custom operations remain test-only."
requirements-completed: []
coverage:
  - id: D1
    description: Durable encrypted Cashu input/output custody and restart-safe dispatch fencing
    verification:
      - kind: integration
        ref: NAPPLET_RUN_POSTGRES_ISOLATION=1 bun test tests/funding/production-accounting-realm.test.ts --timeout 120000
        status: pass
      - kind: unit
        ref: tests/funding/cashu-top-up.test.ts#threads the encrypted custody callback through the coordinator before a swap adapter reports verified
        status: pass
    human_judgment: false
  - id: D2
    description: Semantic proof replay rejection and unknown handling for ambiguous spent inputs
    verification:
      - kind: unit
        ref: bun test tests/funding/cashu-treasury-recovery.test.ts tests/funding/cashu-top-up.test.ts tests/dev/funding.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D3
    description: Original-message-only NUT-09 recovery and DLEQ/keyset/output binding
    verification:
      - kind: unit
        ref: tests/funding/cashu-treasury-recovery.test.ts
        status: pass
    human_judgment: false
duration: 34min
completed: 2026-10-27
status: implementation_complete
---

# Phase 07 Plan 61: Cashu Custody and Replay Safety Summary

**Cashu top-ups now journal encrypted original swap material before dispatch and credit only durably owned, verified outputs.**

## Accomplishments

- Added per-proof semantic identities so reordered, re-encoded, overlapping, subset, and cross-account proof claims cannot create another top-up.
- Persisted encrypted input bearer material, exact `OutputData.serialize()` output data, pinned mint/keyset/amount facts, dispatch state, and encrypted owned outputs before verified settlement.
- Added query-only NUT-09 recovery via `Mint.restore({ outputs: originalBlindedMessages })`; it never calls seed/counter `Wallet.restore` or dispatches a replacement swap.
- Added additive public and production-realm migrations for already-applied databases, with tested PostgreSQL 17 claim/dispatch concurrency.

## Task Commits

1. **Task 1: Persist Cashu inputs and recovery material before swap** - `6e8c3b5`, `a362f82`
2. **Task 2: Reject spent-input inference and re-encoded replay** - `30ed6ad`, `a362f82`

## Verification

- `bun test tests/funding/cashu-top-up.test.ts tests/funding/cashu-treasury-recovery.test.ts tests/dev/funding.test.ts tests/funding/funded-admission.test.ts --timeout 10000` — 36 passed.
- `NAPPLET_RUN_POSTGRES_ISOLATION=1 bun test tests/funding/production-accounting-realm.test.ts --timeout 120000` — 3 passed, using a local `postgres:17-alpine` container.
- The repository-wide TypeScript check still reports unrelated existing errors in concurrent production/pricing, worker, and legacy files; no failures were reported for the changed Cashu source files after the local fixes.

## Decisions Made

- Input `SPENT` observations remain `reconciliation_pending` unless the service has previously encrypted/validated owned outputs or validates NUT-09 results tied to the exact persisted blinded messages.
- Buffers created for envelope encryption and decryption are zeroed. JavaScript strings and library-owned objects cannot be reliably wiped, so no stronger memory-erasure claim is made.
- Input-fee output totals are checked against the persisted preview amount and requested credit; a mismatch fails closed rather than crediting face value.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Lifecycle result updates could overwrite custody state**
- **Found during:** Task 1
- **Issue:** A settlement result was built from a stale top-up record after the adapter appended custody material.
- **Fix:** Re-read the durable record before updating the public lifecycle projection.
- **Verification:** Custody callback integration test retains `owned_outputs` after credit.
- **Committed in:** `a362f82`

**2. [Rule 3 - Blocking] Existing public authorities lacked semantic identity DDL**
- **Found during:** Task 2 / CI follow-up
- **Issue:** The repository queried `cashu_top_up_proof_identities`, but only the production bootstrap DDL created it.
- **Fix:** Added idempotent public and production realm migration with the restricted-role grant.
- **Verification:** Local PostgreSQL 17 integration passes concurrent replay and dispatch claims.
- **Committed in:** `a362f82`

**Total deviations:** 2 auto-fixed (Rule 1: 1, Rule 3: 1). All changes are required for custody correctness; no live money, mint, cloud, or protected publication effects were performed.

## Known Stubs

None. Deterministic fake/custom Cashu operations remain explicitly rejected by production composition; they are retained only for development tests.

## Next Phase Readiness

OPS-02, OPS-03, and OPS-04 remain protected-unverified. This local implementation is not live Cashu/mint, real-money, or protected production certification evidence.

Cashu custody is ready for production-integrated verification. Protected live mint evidence, real-money funding, and production certification remain unperformed and unclaimed.

## Self-Check: PASSED

- Task commits `6e8c3b5`, `30ed6ad`, and `a362f82` exist.
- Custody source, PostgreSQL migration, and adversarial test coverage exist on disk.
