---
phase: 07-admission-slo-resilience-launch-safety
plan: "24"
subsystem: protected-live-integration-adapters
tags: [typescript, zod, contextvm, cep-8, publication, supply-chain, key-custody]
requires:
  - phase: 07-22
    provides: Candidate-bound materialization and protected trust-root contracts
  - phase: 07-23
    provides: Local-only protected operational adapter conventions
provides:
  - Four fail-closed integration/security adapter seams for the Plan 07-25 protected runner
  - Deterministic-port contract tests that prove zero protected effects and evidence writes
affects: [07-20-authorization, 07-25-protected-live-certification, release-promotion]
tech-stack:
  added: []
  patterns: [protected-live-port-gate, digest-only-observations, original-operation-reconciliation]
key-files:
  created: [src/certification/live/security-host.ts, src/certification/live/supply-chain.ts, src/certification/live/contextvm-payment-model.ts, src/certification/live/publication.ts, tests/release/live-integration-adapters.test.ts]
  modified: []
key-decisions:
  - "All four adapters reject deterministic ports before their first method call; Plan 07-25 alone can inject protected-live implementations after Plan 07-20 authorization."
  - "Security-host and supply-chain claims require exact digest-bound records, real-host evidence, external signer custody checks, two distinct build identities, and strict existing verifiers."
  - "Payment/model and publication claims retain original-operation-only reconciliation and expose only finite status or digest facts."
metrics:
  duration: 4m
  completed: 2026-08-06
status: complete
---

# Phase 07 Plan 24: Protected Integration Adapter Contracts Summary

**Four project-owned adapter seams now describe the eventual protected security-host, supply-chain, ContextVM/payment/model, and publication runs while refusing every local deterministic fixture before an external or protected effect.**

## Performance

- **Duration:** 4m
- **Started:** 2026-08-06T11:51:22Z
- **Completed:** 2026-08-06T11:55:19Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added a sealed-build, hostile-matrix, real compatible-host browser, and external-signer adapter that requires exact artifact identity and key-custody observations.
- Added a two-build adapter that delegates only to the existing reproducibility and pinned Cosign/CycloneDX/in-toto validators, returning finite record digests rather than source or verifier output.
- Added a signed ContextVM/CEP-8/payment/model adapter that requires verified-principal replay/reconnect facts, exact-once settlements, and lookup-only original-operation reconciliation.
- Added a promoted-source, external-owner-signing, sealed-publication adapter that binds deploy, owner-manifest, and attestation reconciliation to their fixed operation IDs.
- Added local contract tests proving all four deterministic ports are rejected without any browser, signer, payment, model, upload, relay, provider, or protected-evidence effect.

## Task Commits

1. **Task 1: Implement protected security-host and supply-chain certification adapters** — `73546bc` (RED), `04a3366` (GREEN)
2. **Task 2: Implement protected ContextVM/payment/model and publication certification adapters** — `50390fe` (RED), `eb735b0` (GREEN)

## Files Created

- `src/certification/live/security-host.ts` — sealed build, hostile-matrix, host-browser, and external-signer custody gate.
- `src/certification/live/supply-chain.ts` — distinct-build and strict reproducibility/supply-chain verifier gate.
- `src/certification/live/contextvm-payment-model.ts` — signed transport, CEP-8 rail, and original-model-operation gate.
- `src/certification/live/publication.ts` — promoted source, external signature, fixed publication operation, and reconciliation gate.
- `tests/release/live-integration-adapters.test.ts` — local deterministic-port/no-effect contracts for the four adapters.

## Decisions Made

- Adapter output is limited to finite claims, reason codes, and verification digests; raw keys, receipts, proofs, source, browser output, and provider-native details cannot become certification observations.
- The public-side adapters never construct their own provider client, browser, signer, payment rail, upload client, relay client, or evidence writer.
- Partial or unavailable operations remain non-pass. No local fixture can label itself `protected_live` or create a substitute protected record.

## Verification

- Focused security/supply-chain contract test: 2 passed.
- Focused ContextVM/payment/model/publication contract test: 2 passed.
- Relevant integration, reproducibility, supply-chain, model reconciliation, and publication reconciliation suite: 27 passed.
- Full local test suite: 543 passed, 0 failed.

## Deviations from Plan

None - plan executed exactly as written.

The plan metadata references OPS-02/OPS-04, but their protected-live evidence remains deliberately pending for Plan 07-25; this local-only adapter plan does not change their release-verification status.

## Known Stubs

None. Protected-live ports remain explicit unavailable prerequisites and cannot contribute a claim without Plan 07-20 authorization and Plan 07-25 execution.

## Threat Flags

None. The adapters expose only injected non-network ports and no new external endpoint, credential, filesystem, or schema trust boundary.

## Next Phase Readiness

Plan 07-25 can inject authenticated protected-live ports only after the Plan 07-20 authorization checkpoint. This plan created no credentials, protected records, provider effects, browser invocation, signing request, spend, upload, or relay publication.

## Self-Check: PASSED

- All five planned source/test artifacts exist.
- Task commits `73546bc`, `04a3366`, `50390fe`, and `eb735b0` are reachable in Git history.
