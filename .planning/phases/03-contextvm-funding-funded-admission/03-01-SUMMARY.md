---
phase: 03-contextvm-funding-funded-admission
plan: 01
subsystem: payments
tags: [typescript, zod, funding, ledger, idempotency, bigint]
requires:
  - phase: 02-trusted-core-isolated-agent-execution
    provides: canonical replay-before-effect and transport-neutral persistence patterns
provides:
  - strict transport-neutral Phase 3 funding schemas and command identity
  - test-only serialized funding authority with immutable credit, hold, evidence, and outbox results
  - one verified-settlement-to-funded-admission tracer
affects: [phase-03-plans-02-through-07, phase-04-metered-generation, phase-05-continuity]
tech-stack:
  added: []
  patterns: [canonical command fingerprint, bigint internal monetary values, decimal-string boundaries, replay-before-effect]
key-files:
  created:
    - src/phase-03/contracts.ts
    - src/domain/account-command.ts
    - src/persistence/funding-store.ts
    - src/funding/funding-service.ts
    - tests/phase-03/tracer.test.ts
  modified: []
key-decisions:
  - "Funding commands bind a verified normalized pubkey, account ID, semantic payload hash, idempotency key, policy version, and protocol version."
  - "The memory store is explicitly test-only; adapters can request verified credit or admission transactions but cannot post arbitrary ledger entries."
  - "Cap admission creates a hold only and never a revenue, fee, usage debit, worker dispatch, or queue record."
patterns-established:
  - "Financial JSON uses canonical integer decimal strings while values remain bigint inside the core."
  - "Read-only replay lookup precedes one serialized transaction, which repeats the lookup before effects."
requirements-completed: [CTX-02, CTX-03, PAY-04, PAY-05, BILL-01, BILL-02, BILL-06]
coverage:
  - id: D1
    description: Verified-settlement credit, capped funded admission, redacted status, exact replay, and zero-effect denials.
    requirement: BILL-01
    verification:
      - kind: integration
        ref: tests/phase-03/tracer.test.ts#Phase 3 funded-account tracer
        status: pass
      - kind: unit
        ref: bun test
        status: pass
    human_judgment: false
duration: 10m
completed: 2026-08-04
status: complete
---

# Phase 3 Plan 1: Funded Admission Tracer Summary

**A strict, transport-neutral funding core now derives stable accounts from verified pubkeys, credits verified settlement once, reserves a non-debit cap hold, and replays immutable results.**

## Performance

- **Duration:** 10m
- **Started:** 2026-08-04T15:49:00Z
- **Completed:** 2026-08-04T15:59:28Z
- **Tasks:** 1/1
- **Files modified:** 5
- **Verification:** 2 focused tests; 191 full-suite tests passing.

## Accomplishments

- Added closed Zod contracts for verified principals, settlements, top-up status, cap admission, and redacted account status.
- Added canonical SHA-256 account-command fingerprints and deterministic verified-pubkey account derivation.
- Added a serialized copy-then-commit memory authority for tests that atomically records credit projection, one balanced posting, hold, safe evidence, outbox result, and immutable replay.
- Proved the funded happy path plus conflict, invalid amount, and unavailable-capacity no-effect refusals in an end-to-end tracer.

## Task Commits

1. **Task 1: Prove one verified settlement through funded admission and replay** - `fb19b62` (test RED), `8a9d5bf` (feat GREEN)

## Files Created

- `src/phase-03/contracts.ts` - Sole strict schemas and inferred immutable funding types.
- `src/domain/account-command.ts` - Stable account derivation and canonical command fingerprints.
- `src/persistence/funding-store.ts` - Financial authority port and explicitly test-only deterministic implementation.
- `src/funding/funding-service.ts` - Parse, derive, replay, validate, transact, and redact orchestration.
- `tests/phase-03/tracer.test.ts` - Funded-account end-to-end tracer with zero-effect refusal coverage.

## Decisions Made

- Monetary arithmetic stays bigint inside the core; the contract boundary accepts and emits canonical decimal strings only.
- A cap hold is bounded by available settled balance and records no fee or usage debit.
- Rail, transport, worker, provider, signer, deployment, and publication objects remain outside the financial authority.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Bun's object matcher can substitute its asymmetric matcher into the received object in this test context. The tracer captures the account ID before the matcher assertion, preserving the intended state assertion without altering production behavior.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The next Phase 3 plans can add ContextVM/CEP-8 adapters and durable persistence behind the established transport-neutral `FundingStore` port.
- Production SQL, rail verification I/O, exact usage debit, top-up pause/resume, worker allocation, and provider certification remain deferred to their planned phases.

## Self-Check: PASSED

- Verified all five delivered files exist on disk.
- Verified RED commit `fb19b62` and GREEN commit `8a9d5bf` exist in git history.

---
*Phase: 03-contextvm-funding-funded-admission*
*Completed: 2026-08-04*
