---
phase: 03-contextvm-funding-funded-admission
plan: 05
subsystem: payments
tags: [cashu, cep-8, settlement, policy, reconciliation]
requires:
  - phase: 03-02
    provides: Serializable transport-neutral funding authority and exact package lock
  - phase: 03-04
    provides: ProtectedRailMaterialVault encryption boundary
provides:
  - Immutable versioned multi-mint Cashu policy registry
  - Adapter-confined online Cashu settlement and proof-state observations
  - Exactly-once Cashu credit coordination and non-crediting treasury reconciliation
affects: [03-03, 03-06, 03-07, funding, ContextVM]
tech-stack:
  added: []
  patterns: [pinned rail policy, protected bearer reference, observation-only reconciliation]
key-files:
  created: [src/funding/cashu-mint-policy.ts, src/funding/cashu-provider.ts, src/funding/cashu-top-up.ts, tests/fixtures/cashu-phase-03.json, tests/funding/cashu-top-up.test.ts]
  modified: []
key-decisions:
  - "Cashu policy rotation changes only an active pointer; each top-up retains its immutable policy version."
  - "A raw bearer is sealed before provider I/O and re-opened only for bounded reconciliation; records retain commitments and protected references only."
  - "Unknown swap completion is reconciliation_pending and is observed via the original commitment rather than resubmitted."
requirements-completed: [PAY-01, PAY-03, PAY-04, PAY-05, PAY-06, PAY-07]
coverage:
  - id: D1
    description: Immutable multi-mint policy rotation and policy-pinned online Cashu validation.
    requirement: PAY-03
    verification:
      - kind: unit
        ref: tests/funding/cashu-top-up.test.ts#Cashu policy and Cashu validation and swap
        status: pass
    human_judgment: false
  - id: D2
    description: Commitment-deduplicated credit, unknown-effect observation, and non-crediting treasury reconciliation.
    requirement: PAY-07
    verification:
      - kind: unit
        ref: tests/funding/cashu-top-up.test.ts#Cashu credit and treasury
        status: pass
    human_judgment: false
metrics:
  duration: 30min
  completed: 2026-08-04
status: complete
---

# Phase 3 Plan 05: Cashu Policy-Pinned Settlement Summary

**Cashu top-ups now pin immutable trusted-mint policy, secure bearer material, require a normalized online swap observation before credit, and reconcile treasury state without a second credit path.**

## Accomplishments

- Added strict multi-mint policy versions with canonical HTTPS mints, sat-only keysets, DLEQ/condition rules, immutable history, and explicit rotation.
- Confined `@cashu/cashu-ts` to the settlement adapter; it checks bounded tokens, mint/unit/keyset/proof facts and uses mint load plus receive/complete-swap as the value gate.
- Added deterministic coverage for duplicate proofs, effect-then-timeout recovery, reconciliation queries, protected bearer expiry, and replay-stable treasury outcomes.

## Task Commits

1. Task 1 RED — `4dd8328` (`test`)
2. Task 1 GREEN — `e679175` (`feat`)
3. Task 2 RED — `0ab727c` (`test`)
4. Task 2 GREEN — `36adeff` (`feat`)
5. Rule 2 security correction — `700d7df` (`fix`)

## Verification

- `bun test tests/funding/cashu-top-up.test.ts` — 10 pass, 0 fail.
- Full `bun test` was run while Plans 03-03/03-04 were concurrently landing: Cashu tests passed, while the ContextVM adapter had an unrelated missing SDK export (`computeCanonicalInvocationIdentity`).
- Import firewall scan confirms `@cashu/cashu-ts` occurs only in `src/funding/cashu-provider.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Removed the coordinator's raw bearer copy.**

- **Found during:** Task 2.
- **Issue:** The coordination journal retained a `Uint8Array` after sealing it, violating the protected-reference-only boundary.
- **Fix:** Retained only the opaque vault reference and commitment; reconciliation re-opens through the protected vault when required.
- **Files modified:** `src/funding/cashu-top-up.ts`
- **Verification:** Focused suite passes and source scan finds no persisted raw bearer field.
- **Commit:** `700d7df`

## Known Stubs

None.

## Next Phase Readiness

The ContextVM adapter can negotiate the exact Cashu PMI into this coordinator. Live trusted-mint credentials and end-to-end provider certification remain Phase 7 validation work; the deterministic adapter fake is not a production-certification claim.

## Self-Check: PASSED

- All five planned source/fixture/test files exist.
- Task commits `4dd8328`, `e679175`, `0ab727c`, `36adeff`, and `700d7df` exist.
