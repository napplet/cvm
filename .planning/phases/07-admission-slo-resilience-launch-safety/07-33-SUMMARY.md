---
phase: 07-admission-slo-resilience-launch-safety
plan: "33"
subsystem: payments
tags: [contextvm, cep-8, lightning, cashu, nostr, replay-safety, certification]
requires:
  - phase: 03-contextvm-funding-funded-admission
    provides: ContextVM funding adapter and rail coordinators
  - phase: 07-admission-slo-resilience-launch-safety
    plan: "28"
    provides: protected release authorization boundary
provides:
  - Receipt-gated native ContextVM provider composition
  - Original-operation CEP-8 Lightning and Cashu composition
  - Protected-live ContextVM/payment/model observation bridge
affects: [07-37, 07-38, 07-39]
tech-stack:
  added: []
  patterns: [injected-provider-seams, original-operation-reconciliation, reference-and-hash-only-evidence]
key-files:
  created:
    - src/release/native/contextvm.ts
    - src/release/native/cep8-lightning.ts
    - src/release/native/cashu.ts
    - src/certification/live/payment-ports.ts
    - tests/release/contextvm-payment-live-provider.test.ts
  modified: []
key-decisions:
  - Native ContextVM composition binds canonical signed invocations to one original event receipt before invoking the transport-neutral core.
  - Native CEP-8 adapters delegate all payment state, protected material, and ledger authority to the existing coordinators and expose only redacted configuration references.
  - Protected-suite payment evidence accepts finite exactly-once observations rather than provider payloads, receipts, proofs, invoices, or credentials.
requirements-completed: [OPS-01, OPS-02, OPS-04]
coverage:
  - id: D1
    description: Signed ContextVM invocations preserve the verified Nostr principal and replay the original event without private-key custody.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: tests/release/contextvm-payment-live-provider.test.ts#native ContextVM composition has no relay effect before an exact receipt, preserves the signed principal, and reconciles the original event
        status: pass
      - kind: integration
        ref: tests/contextvm/adapter.test.ts#verified ContextVM funding adapter
        status: pass
    human_judgment: false
  - id: D2
    description: CEP-8 Lightning and Cashu settlements use original operations and existing ledger coordinators with redacted protected-suite evidence.
    requirement: OPS-01
    verification:
      - kind: integration
        ref: tests/release/contextvm-payment-live-provider.test.ts#native CEP-8 rail composition uses original operations, existing coordinators, and redacted protected-suite observations
        status: pass
      - kind: integration
        ref: tests/funding/lightning-top-up.test.ts
        status: pass
      - kind: integration
        ref: tests/funding/cashu-top-up.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 20m
  completed: 2026-08-06
status: complete
---

# Phase 7 Plan 33: Native ContextVM and CEP-8 Payment Providers Summary

**Receipt-gated ContextVM composition and original-operation CEP-8 Lightning/Cashu adapters that preserve the existing ledger and secret boundaries.**

## Performance

- **Duration:** 20m
- **Completed:** 2026-08-06T14:48:48Z
- **Tasks:** 2/2
- **Files created:** 5

## Accomplishments

- Added a native ContextVM composition that binds canonical signed invocation identity and original event ID before the existing transport-neutral funding adapter runs.
- Added native CEP-8 Lightning and Cashu constructors that require injected provider seams, validate receipt-to-original-operation binding, and delegate all settlement/ledger work to established coordinators.
- Added the protected-live payment observation bridge, which admits only finite, redacted, exactly-once facts to the existing ContextVM/payment/model certification suite.
- Added fake-only integration coverage for zero construction effects, receipt gating, original-operation replay, exactly-once credits, and secret-free evidence.

## Files Created/Modified

- `src/release/native/contextvm.ts` — receipt-bound signed ContextVM provider composition.
- `src/release/native/cep8-lightning.ts` — Lightning coordinator and original-operation bridge.
- `src/release/native/cashu.ts` — Cashu coordinator, wallet seam, and original-operation bridge.
- `src/certification/live/payment-ports.ts` — finite protected-live observation adapter.
- `tests/release/contextvm-payment-live-provider.test.ts` — injected-only composition and replay tests.

## Decisions Made

- The native layer has only reference/hash configuration plus public server identity; it never accepts user private-key material.
- Existing funding coordinators remain the only owners of protected payment material, provider observations, idempotency state, and ledger crediting.
- Certification observations are explicit booleans and bounded operation IDs, preventing private provider material from entering evidence.

## Verification

- `bun test tests/release/contextvm-payment-live-provider.test.ts tests/contextvm/adapter.test.ts tests/funding/lightning-top-up.test.ts tests/funding/cashu-top-up.test.ts` — passed (32 tests).
- Phase 07-33 ASVS L1 high-block source assertion — passed.
- Stub-pattern scan across all plan files — no stubs found.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- All five planned files exist and all four task commits are present.
- No tracked-file deletions were introduced.

## Next Phase Readiness

Ready for 07-34 native model-provider composition. Protected live execution remains reserved for the authorization and run-only plans.
