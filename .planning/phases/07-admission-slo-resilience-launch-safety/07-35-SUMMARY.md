---
phase: 07-admission-slo-resilience-launch-safety
plan: "35"
subsystem: release certification
tags: [nip-5d, chromium, external-signer, nostr, candidate-evidence]
requires:
  - phase: 06-sealed-preview-user-owned-publication
    provides: HostSurface, PreviewService, publication intent, and local owner-event verification contracts
  - phase: 07-admission-slo-resilience-launch-safety
    provides: protected live security-host certification seam
provides:
  - Candidate-bound compatible-host Chromium observation adapter
  - Public-only external signer adapter with exact-intent local verification
  - Protected-suite composition bridge for host and signer observations
affects: [07-20, 07-26, protected-live-certification, release-promotion]
tech-stack:
  added: []
  patterns: [injected package-host/browser observations, public-only signer results, exact candidate identity fences]
key-files:
  created:
    - src/release/native/compatible-host.ts
    - src/release/native/external-signer.ts
    - src/certification/live/host-ports.ts
    - tests/release/host-signer-live-provider.test.ts
  modified: []
key-decisions:
  - "Compatible-host evidence encodes the package and Chromium versions in existing strict evidence fields while preserving the established HostBrowserEvidenceSchema."
  - "External signing accepts only public discovery, consent state, receipt, and signed event; local verification remains delegated to the existing OwnerEventVerifierPort."
  - "OPS-01 and OPS-04 remain unverified until protected live execution; this plan supplies composable ports and local fixture coverage only."
patterns-established:
  - "Protected live bridges compose injected observation ports and never construct browsers, signers, provider clients, or evidence writers."
  - "Signer authorization binds the exact candidate digests, expected owner pubkey, required capabilities, intent digest, and receipt before returning a public event."
requirements-completed: []
coverage:
  - id: D1
    description: Candidate-bound compatible-host browser evidence blocks non-Chromium, identity, authority, console, responsiveness, and capability failures.
    verification:
      - kind: integration
        ref: tests/release/host-signer-live-provider.test.ts#candidate-bound compatible host observes the full real-browser UI matrix
        status: pass
    human_judgment: false
  - id: D2
    description: External signer returns only a public exact-intent result after local owner-event verification and rejects wrong signer, digest, or consent.
    verification:
      - kind: integration
        ref: tests/release/host-signer-live-provider.test.ts#external signer returns only a locally verified exact-intent public result
        status: pass
    human_judgment: false
duration: 7m
completed: 2026-08-06
status: complete
---

# Phase 7 Plan 35: Compatible Host and External Signer Summary

**Candidate-bound compatible-host evidence and a public-only, locally verified external signer boundary, ready for the later protected live run.**

## Performance

- **Duration:** 7m
- **Started:** 2026-08-06T15:01:00Z
- **Completed:** 2026-08-06T15:08:01Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added an injected NIP-5D-compatible host/Chromium observation port that carries the exact sealed and aggregate hashes through the full desktop, tablet, mobile, keyboard/touch, focus/dialog/live-region, and capability matrix.
- Kept browser evidence fail-closed for identity mismatch, non-Chromium execution, console failures, direct authority, responsive/accessibility failure, or capability bypass.
- Added an external signer boundary that exposes only public identity, capabilities, official consent state, exact intent digest, receipt, and signed event; it never imports, generates, persists, logs, or receives a user private key.

## Task Commits

1. **Task 1: Render one sealed napplet in the real compatible host** - `457b9ad`, `e1adf1e` (TDD red, feat)
2. **Task 2: Prove external signer custody without exposing a private key** - `d8cd911`, `2c7b669` (TDD red, feat)

## Files Created/Modified

- `src/release/native/compatible-host.ts` - Composes package-host and browser observations into strict candidate-bound host evidence.
- `src/release/native/external-signer.ts` - Verifies externally signed, public manifest results against the exact expected intent.
- `src/certification/live/host-ports.ts` - Bridges injected host and signer adapters into the existing protected security-host suite.
- `tests/release/host-signer-live-provider.test.ts` - Local fixture coverage for the host matrix and signer custody boundary.

## Decisions Made

- Reused the existing strict `HostBrowserEvidenceSchema` instead of adding a second evaluator; the existing version and digest fields bind the host/runtime/package/browser report facts.
- Kept the adapter request-only: an actual browser, user consent, signer, credentials, spend, or publication effect can occur only in the later protected-live path.
- Did not mark OPS-01 or OPS-04 complete because their real compatible-host and provider observations remain non-waivable protected-live evidence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Replaced an absent planned test path with the existing live integration gate**
- **Found during:** Task 1 verification
- **Issue:** `tests/certification/live-security-host.test.ts` does not exist in the repository.
- **Fix:** Ran the new focused provider suite together with `tests/release/live-integration-adapters.test.ts`, which exercises the existing `runLiveSecurityHostCertification` deterministic-port rejection gate.
- **Files modified:** None
- **Verification:** All focused suites passed.
- **Committed in:** N/A (verification-only)

---

**Total deviations:** 1 auto-fixed (1 Rule 3 blocking verification-path correction)
**Impact on plan:** No scope expansion or live effect. The absent path remains a pre-existing planning mismatch; protected live certification is still required.

## Issues Encountered

- The plan’s legacy `tests/certification/live-security-host.test.ts` path is absent; the repository’s existing security-host gate is covered through `tests/release/live-integration-adapters.test.ts`.

## User Setup Required

None - no external service configuration or consent was requested in this local-fixture implementation.

## Next Phase Readiness

- Plan 07-26 can inject real package-host, Chromium, and external-signer implementations only after the exact authorization receipt and protected-live credentials are available.
- The current plan deliberately provides no live certification, private-key handling, provider authentication, browser launch, consent request, spend, or publication effects.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-06*

## Self-Check: PASSED

- Confirmed all four task files exist.
- Confirmed TDD and implementation commits `457b9ad`, `e1adf1e`, `d8cd911`, and `2c7b669` exist.
