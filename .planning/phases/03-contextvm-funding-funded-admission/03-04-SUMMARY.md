---
phase: 03-contextvm-funding-funded-admission
plan: 04
subsystem: payments
tags: [lightning, bolt11, aes-gcm, funding, idempotency]
requires:
  - phase: 03-02
    provides: serializable funding authority and sole settlement-credit service
provides:
  - AES-GCM protected rail-material boundary
  - service-owned Lightning invoice intent/reconciliation coordinator
  - authoritative receipt validation and exactly-once funding credit
affects: [03-05, 03-06, phase-03-funded-core]
tech-stack:
  added: []
  patterns: [intent-before-provider-I/O, encrypted-rail-material, query-only-ambiguity-reconciliation, provider-observation-seam]
key-files:
  created: [src/funding/protected-rail-material.ts, src/funding/lightning-provider.ts, src/funding/lightning-top-up.ts, tests/funding/lightning-top-up.test.ts]
  modified: []
key-decisions:
  - "Lightning receivers return strictly normalized observations only; FundingService remains the only ledger-credit authority."
  - "A non-terminal invoice-create intent is reconciled by immutable reference and never authorizes a repeat create effect."
  - "Invoice payloads are AES-GCM protected with account/top-up/rail-bound associated data; public status stores only safe references and hashes."
patterns-established:
  - "Rail I/O: persist intent, dispatch once, then record an authoritative observation or reconciliation_pending state."
  - "Settlement: match receiver authentication, top-up, amount, unit, invoice identity, payment hash, expiry/finality, and stable reference before credit."
requirements-completed: [PAY-01, PAY-02, PAY-04, PAY-05]
coverage:
  - id: D1
    description: Service-owned Lightning creation persists and replays a protected invoice intent without duplicate external creation.
    requirement: PAY-01
    verification:
      - kind: unit
        ref: tests/funding/lightning-top-up.test.ts#initiation persists one invoice intent before I/O and exact replay never creates a second invoice
        status: pass
    human_judgment: false
  - id: D2
    description: A fully matched receiver-authenticated BOLT11 receipt credits exactly once across coordinator instances.
    requirement: PAY-02
    verification:
      - kind: integration
        ref: tests/funding/lightning-top-up.test.ts#credits one authoritative fully matched settled receipt exactly once across coordinator instances
        status: pass
    human_judgment: false
  - id: D3
    description: Invalid, failed, expired, and unknown receipt observations remain non-crediting and reconcilable.
    requirement: PAY-04
    verification:
      - kind: unit
        ref: tests/funding/lightning-top-up.test.ts#Lightning settlement receipt matrix
        status: pass
    human_judgment: false
  - id: D4
    description: Duplicate and opaque provider outcomes converge through durable command state rather than repeated effects.
    requirement: PAY-05
    verification:
      - kind: integration
        ref: tests/funding/lightning-top-up.test.ts#initiation reconciles an opaque create result by the original service reference without blind invoice reissue
        status: pass
    human_judgment: false
metrics:
  duration: 5min
  completed: 2026-08-04
status: complete
---

# Phase 3 Plan 04: Lightning BOLT11 Funding Summary

**Service-owned Lightning top-ups now persist intent before I/O, encrypt bearer invoice material, and credit a matched final receiver receipt once.**

## Accomplishments

- Added a caller-keyed AES-GCM vault with account/top-up/rail-bound associated data and ciphertext-only repositories.
- Added a narrow Lightning receiver port/fake that returns observations but has no funding-store or ledger authority.
- Added durable-style invoice intent, replay, ambiguity reconciliation, receipt matching, expiry enforcement, duplicate convergence, and protected-material expiry after credit.

## Task Commits

1. Task 1 RED — `dc88950` (`test`)
2. Task 1 GREEN — `fe3e1fa` (`feat`)
3. Task 2 RED — `790bfaa` (`test`)
4. Task 2 GREEN — `36d0b1c` (`feat`)
5. Task 2 ambiguity correction — `a6120a5` (`fix`)

## Verification

- `bun test tests/funding/lightning-top-up.test.ts` — 7 pass
- `bun test` — 217 pass, 0 fail

## Decisions Made

- Only a normalized receiver-authenticated receipt that matches all service-held facts can reach `FundingService`.
- Provider errors, timeouts, restart ambiguity, and unknown observations become `reconciliation_pending`; reconciliation queries the original service reference and never creates again.
- The production composition must inject durable rail/protected-material repositories; the in-memory repositories are deterministic test doubles only.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reconciled unfinished creation intents after restart ambiguity**
- **Found during:** Task 2
- **Issue:** An intent committed before provider I/O could be replayed after a crash without first querying its original receiver reference.
- **Fix:** Treat every non-completed creation intent as query-only reconciliation, never a fresh create permit.
- **Files modified:** `src/funding/lightning-top-up.ts`
- **Verification:** Focused Lightning suite and full repository suite pass.
- **Committed in:** `a6120a5`

**Total deviations:** 1 auto-fixed (Rule 1).

## Next Phase Readiness

- Plan 03-05 can reuse `ProtectedRailMaterialVault` for Cashu bearer protection.
- Plan 03-06 can compose Lightning only through explicit durable repositories and the existing funding authority.
- Live receiver credentials and provider certification remain a Phase 7 operational gate; this plan deliberately proves deterministic semantics only.

## Self-Check: PASSED

- All four planned source/test files exist.
- Commits `dc88950`, `fe3e1fa`, `790bfaa`, `36d0b1c`, and `a6120a5` exist.
