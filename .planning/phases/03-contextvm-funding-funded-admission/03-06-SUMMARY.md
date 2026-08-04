---
phase: 03-contextvm-funding-funded-admission
plan: 06
subsystem: funding
tags: [funded-admission, capacity, cap-hold, account-status, contextvm]
requires:
  - phase: 03-01
    provides: canonical funding commands and memory test double
  - phase: 03-02
    provides: PostgreSQL-wire funding authority seam
  - phase: 03-03
    provides: signed ContextVM funding adapter
  - phase: 03-04
    provides: verified Lightning settlement coordinator
  - phase: 03-05
    provides: verified Cashu settlement coordinator
provides:
  - immediate-capacity-funded cap admission facade
  - non-debit per-action budget reservation seam
  - authenticated redacted account/status projection
  - provider-separated final Phase 3 composition
affects: [04-metered-generation, 05-pause-resume, 06-preview-publication, 07-production-certification]
tech-stack:
  added: []
  patterns: [capacity-before-hold, replay-before-reserve, explicit-offline-provider-state, owner-scoped-projection]
key-files:
  created: [src/funding/funded-admission.ts, src/funding/account-status.ts, src/phase-03/funded-core.ts, tests/funding/funded-admission.test.ts]
  modified: []
key-decisions:
  - "A capacity attempt happens before the monetary hold, and an available reservation is released when the hold cannot commit."
  - "Action-budget authorization is a bounded reservation seam only; it does not post usage or debit the account."
  - "Offline composition labels unavailable external surfaces blocked and leaves Modal unselected."
metrics:
  duration: 25min
  completed: 2026-08-04
status: complete
---

# Phase 3 Plan 06: Funded Admission and Account Status Summary

**Funded admission now pairs an immediately usable capacity reservation with a bounded prepaid hold, while account status and composition remain owner-scoped and provider-separated.**

## Accomplishments

- Added `FundedAdmissionService` with replay-before-reserve behavior, safe-integer sat caps, durable capacity intents, immediate available/refused/unknown capacity handling, compensation release, and a durable action-budget reservation seam that cannot debit or invoke a worker.
- Added `AccountStatusService`, which joins strict FundingStore facts with a transport-neutral session-status port into an immutable, recursively redacted owner-only projection.
- Added `createFundedCore`, requiring an explicit PostgreSQL authority for production use and reporting missing ContextVM, rails, PostgreSQL, and capacity as blocked/offline design evidence. Modal remains unselected.
- Added deterministic coverage for cap clamping, no-hold ambiguity, observation without re-reservation, action-budget bounds, cross-account status isolation, redaction, and offline composition.

## Task Commits

1. Task 1 RED — `67a1ceb` (`test`)
2. Task 1 GREEN — `8b4f489` (`feat`)
3. Task 2 RED — `548bd26` (`test`)
4. Task 2 GREEN — `e978393` (`feat`)

## Verification

- `bun test tests/funding/funded-admission.test.ts tests/persistence/postgres-funding-store.test.ts tests/phase-03/tracer.test.ts` — 10 pass
- `bun test` — 221 pass, 0 fail

## Decisions Made

- Capacity is never queued: unavailable capacity returns a retryable refusal before a hold, and ambiguous capacity is observed by its original intent before any later action.
- The action budget records an approved maximum beneath the existing hold but intentionally does not create a Phase 4 usage charge, debit, provider call, or worker/model action.
- A non-PostgreSQL funding store requires the explicit `testOnly` composition flag; offline design readiness is not a provider, SLO, or production-readiness claim.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical durability] Extended the funding authority with persistent capacity intent and action-budget records.**

- **Found during:** Final Plan 06 review.
- **Issue:** The original FundingStore exposed durable accepted holds but not the capacity-intent/refusal/reconciliation or action-budget records required by D-55 through D-57. A process-local journal would lose ambiguity and reservation correlation on restart.
- **Fix:** Added transactional capacity-intent observation/release and action-budget reservation operations to the FundingStore contract, both deterministic store implementations, and the PostgreSQL migration. External capacity calls remain outside retryable store transactions.
- **Files modified:** `src/persistence/funding-store.ts`, `src/persistence/postgres-funding-store.ts`, `migrations/phase-03/001_funding.sql`, `tests/persistence/postgres-funding-store.test.ts`, `src/funding/funded-admission.ts`.
- **Verification:** Fresh PostgresFundingStore/FundedAdmissionService instances resume the original ambiguity with `observe`, never issue a second reserve, and replay the one durable action budget.
- **Commit:** `df4fcaa`.

## Deferred Items

- Phase 4 owns exact provider-usage measurement, line-item finalization, and ledger debit.
- Phase 5 owns `needs_top_up`, live-worker pause, durable checkpointing, and explicit resume.
- Phase 7 owns live PostgreSQL/rail/capacity certification, measured five-second readiness, and any provider selection claim.

## Self-Check: PASSED

- `src/funding/funded-admission.ts`, `src/funding/account-status.ts`, `src/phase-03/funded-core.ts`, and `tests/funding/funded-admission.test.ts` exist.
- Task commits `67a1ceb`, `8b4f489`, `548bd26`, and `e978393` exist.
