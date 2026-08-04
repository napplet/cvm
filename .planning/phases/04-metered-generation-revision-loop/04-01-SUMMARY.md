---
phase: 04-metered-generation-revision-loop
plan: "01"
subsystem: payments
tags: [typescript, zod, bigint, metering, receipts, idempotency]
requires:
  - phase: 02-trusted-core-isolated-agent-execution
    provides: canonical input/risk gates and worker/artifact authorities
  - phase: 03-contextvm-funding-funded-admission
    provides: funded cap holds and serialized action-budget reservations
provides:
  - persisted provider-operation intent and normalized receipt contracts
  - deterministic bigint/rational fixture pricing and receipt settlement
  - funded start-session tracer with duplicate replay and artifact gating
affects: [04-02, 04-03, 04-04, 04-05, 04-06]
tech-stack:
  added: []
  patterns: [intent-before-provider-io, receipt-derived-settlement, account-scoped-serialized-metering]
key-files:
  created: [src/model/model-gateway.ts, src/model/price-card.ts, src/phase-04/metered-generation-service.ts, tests/phase-04/tracer.test.ts, tests/billing/price-card.test.ts]
  modified: [src/persistence/funding-store.ts]
key-decisions:
  - "The deterministic fixture is explicitly unselected; no live provider is represented as selected or production-ready."
  - "The memory metering authority is a test-only copy-then-commit extension, preserving the existing funding-store seam for later SQL composition."
patterns-established:
  - "A provider dispatch is preceded by an account-scoped persisted operation claim and correlates receipt, debit/release, result, and artifact version."
  - "Price cards retain canonical decimal boundaries while pricing entirely with bigint quotient/remainder evidence."
requirements-completed: [BILL-03, SESS-01, SESS-03]
coverage:
  - id: D1
    description: Funded start persists one provider intent, settles one receipt, and replays exact concurrent duplicates without additional effects.
    requirement: BILL-03
    verification:
      - kind: integration
        ref: tests/phase-04/tracer.test.ts#settles one persisted provider intent
        status: pass
    human_judgment: false
  - id: D2
    description: Bounded input gates deny invalid ideas before any financial, provider, worker, or artifact effect.
    requirement: SESS-01
    verification:
      - kind: integration
        ref: tests/phase-04/tracer.test.ts#denies invalid text
        status: pass
    human_judgment: false
  - id: D3
    description: Receipt pricing uses immutable deterministic card identity and reproducible bigint rational line items.
    requirement: BILL-03
    verification:
      - kind: unit
        ref: tests/billing/price-card.test.ts
        status: pass
    human_judgment: false
  - id: D4
    description: Successful start exposes a stable owner-scoped session/result with confirmed spend and next revision action.
    requirement: SESS-03
    verification:
      - kind: integration
        ref: tests/phase-04/tracer.test.ts#settles one persisted provider intent
        status: pass
    human_judgment: false
duration: 5min
completed: 2026-08-04
status: complete
---

# Phase 04 Plan 01: Metered Generation Start Tracer Summary

**A funded, bounded idea now creates one persisted, receipt-priced, artifact-gated session result with exact duplicate replay.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-08-04T19:24:00Z
- **Completed:** 2026-08-04T19:29:43Z
- **Tasks:** 2/2
- **Files modified:** 6

## Accomplishments

- Defined provider-neutral, protected-evidence receipt and operation-intent contracts.
- Added a serialized test-only metering transaction that finalizes receipt-derived debits, releases unused action budget, and records durable action results.
- Proved input-gate ordering, single dispatch/debit/artifact advancement under concurrent duplicate starts, and bigint/rational price-card boundaries.

## Task Commits

1. **Task 1: Wire one funded start through exact receipt settlement and verified artifact commit**
   - `3c0afd1` — failing tracer test
   - `390d6dc` — funded start implementation
2. **Task 2: Close integer/rational price-card boundary and precision cases**
   - `f77fe0e` — failing price-card tests
   - `a428c8e` — price-card boundary implementation

## Files Created/Modified

- `src/model/model-gateway.ts` — strict project-owned provider intent, receipt, and gateway contracts.
- `src/model/price-card.ts` — immutable deterministic fixture cards and bigint receipt pricing.
- `src/persistence/funding-store.ts` — metered action/receipt lifecycle inside the test-only serialized authority.
- `src/phase-04/metered-generation-service.ts` — transport-neutral start-session coordinator.
- `tests/phase-04/tracer.test.ts` — end-to-end funded start and effect-fencing proof.
- `tests/billing/price-card.test.ts` — canonical rational price and reservation boundary proof.

## Decisions Made

- Deterministic provider/profile identity remains `unselected`; this is offline design proof, not production provider selection.
- A receipt is priced only against the action-time fixture profile/card and is charged from the receipt total rather than the maximum reservation.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

`bunx tsc --noEmit` reports pre-existing repository-wide Bun typing and legacy type errors. The plan’s targeted Bun test commands pass; no unrelated type errors were changed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 04-02 onward can extend the persisted metered action seam with reconciliation, revision, and durable session behavior. SQL metering composition remains intentionally deferred to the planned follow-up work.

## Self-Check: PASSED

- Confirmed all six key implementation/test files exist.
- Confirmed task commits `3c0afd1`, `390d6dc`, `f77fe0e`, and `a428c8e` exist.
- Re-ran `bun test tests/phase-04/tracer.test.ts tests/billing/price-card.test.ts tests/phase-03/tracer.test.ts --timeout 10000` successfully (7 passing tests).
