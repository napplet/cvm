---
phase: 07-admission-slo-resilience-launch-safety
plan: "36"
subsystem: release publication
tags: [napplet-cli, blossom, nostr, external-signer, receipt-gating]
requires:
  - phase: 06-sealed-preview-user-owned-publication
    provides: PublicationService, sealed artifact identities, signed owner-event verification, and source-contract adapter
  - phase: 07-admission-slo-resilience-launch-safety
    provides: exact v2 release authorization and external signer boundary
provides:
  - Pinned promoted napplet CLI source adapter with exact-byte upload delegation
  - Receipt-gated original-event owner and attestation relay adapters
  - Protected publication-suite bridge that preserves PublicationService as sole durable authority
affects: [07-37, 07-38, 07-26, protected-live-certification, release-promotion]
tech-stack:
  added: []
  patterns: [pinned-source revalidation, exact-byte original-operation upload, persisted signed-event relay publication, redacted protected-suite composition]
key-files:
  created:
    - src/release/native/promoted-cli.ts
    - src/release/native/upload.ts
    - src/release/native/nostr-relay.ts
    - src/certification/live/publication-ports.ts
    - tests/release/publication-live-provider.test.ts
  modified: []
key-decisions:
  - "Promoted source eligibility is rechecked before every delegated upload or relay effect, while the existing napplet source contract stays authoritative."
  - "Upload and relay adapters persist exact original operations, revalidate the exact v2 receipt immediately before mutation, and reconcile only their original IDs."
  - "The protected bridge composes source, external signer result, and PublicationService without creating another evaluator, manifest, signer, or evidence authority."
patterns-established:
  - "Native publication effects take injected clients and durable stores only; no credential, user key, network client, or live effect is created by local tests."
  - "Remote completion is accepted only when target/relay identity, exact operation ID, checksum/event ID, and configured retention or relay set match."
requirements-completed: []
coverage:
  - id: D1
    description: Promoted CLI source and exact sealed-byte uploads block unpinned source, persist before effect, and reconcile the original checksum-bound upload.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: tests/release/publication-live-provider.test.ts#wrong promoted source blocks before the sealed bytes leave the controller
        status: pass
      - kind: integration
        ref: tests/release/publication-live-provider.test.ts#persists and uploads the exact sealed bytes once, then reconciles only the original upload operation
        status: pass
    human_judgment: false
  - id: D2
    description: Owner and attestation relay events use exact persisted signed bytes and original-ID-only reconciliation under the receipt-bound relay set.
    requirement: OPS-03
    verification:
      - kind: integration
        ref: tests/release/publication-live-provider.test.ts#relay persistence binds exact signed owner and attestation events and reconciles only original IDs
        status: pass
    human_judgment: false
  - id: D3
    description: Protected publication-suite composition requires exact candidate, source, external signer, intent, and original-operation identities without exposing private keys or evidence payloads.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/release/publication-live-provider.test.ts#protected publication bridge accepts only exact source signer intent and original operation evidence
        status: pass
      - kind: integration
        ref: tests/phase-06/publication-reconciliation.test.ts#claims each effect once persists ambiguous results and reconciles only original operation identities
        status: pass
    human_judgment: false
duration: 7m
completed: 2026-08-06
status: complete
---

# Phase 7 Plan 36: Native Publication Ports Summary

**Pinned promoted CLI, exact sealed-byte upload, and persisted original-event Nostr relay adapters now compose into the protected publication suite without creating a parallel publication path.**

## Performance

- **Duration:** 7m
- **Started:** 2026-08-06T15:36:59Z
- **Completed:** 2026-08-06T15:43:39Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added a promoted CLI source seam that validates the pinned source/version/hash contract before each delegated effect and remains limited to the existing napplet CLI source surface.
- Added receipt-gated exact-byte upload handling with durable original-operation persistence, remote checksum/target/retention verification, and no replacement upload after ambiguity.
- Added owner and CVM-attestation relay publication with persisted exact event bytes, expected signer/relay/event identity fences, and original-ID-only reconciliation.
- Added a protected publication bridge that reuses PublicationService and its existing signed-manifest flow without exposing user key material or raw evidence.

## Task Commits

1. **Task 1: Verify promoted CLI and upload one exact sealed artifact** - `f681a9c`, `9e3dc6f` (TDD red, feat)
2. **Task 2: Publish and reconcile original owner and attestation relay events** - `d9b86f0`, `1a63f22` (TDD red, feat)

## Verification

- PASS: `bun test tests/release/publication-live-provider.test.ts tests/contextvm/publication-adapter.test.ts tests/phase-06/publication-reconciliation.test.ts` — 13 tests, 58 assertions.
- PASS: ASVS L1 high/critical block-policy source assertion.
- PASS: `git diff --check`.

## TDD Gate Compliance

- RED: `f681a9c` added the promoted source/upload contract before native adapter modules existed; the focused suite failed with the missing-module error.
- GREEN: `9e3dc6f` implemented the pinned source and exact upload adapters.
- RED: `d9b86f0` added the owner/attestation relay and protected bridge contract before those modules existed; the focused suite failed with the missing-module error.
- GREEN: `1a63f22` implemented persisted relay publication and protected PublicationService composition.

## Files Created/Modified

- `src/release/native/promoted-cli.ts` - Restricts native composition to the pinned promoted CLI source contract and delegates exact upload/relay effects.
- `src/release/native/upload.ts` - Receipt-gated exact-byte upload persistence, remote checksum validation, and original-operation recovery.
- `src/release/native/nostr-relay.ts` - Receipt-gated persisted signed owner/attestation event publication and original-ID reconciliation.
- `src/certification/live/publication-ports.ts` - Redacted protected-suite bridge over the existing source contract and PublicationService.
- `tests/release/publication-live-provider.test.ts` - Local injected-fake coverage for source, upload, relay, and bridge safety properties.

## Decisions Made

- Promoted CLI source verification remains a source-contract fence, not a second CLI implementation or manifest/deployment protocol.
- The exact v2 receipt is revalidated after persistence/reconciliation work immediately before every upload or relay effect.
- Owner events arrive as externally signed public results; no native publication adapter imports, receives, stores, or logs user private keys.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. Protected-live credentials, signer consent, relay connection, and actual publication remain restricted to the later protected run; this plan supplies only injected adapter composition and local protocol fixtures.

## Issues Encountered

None.

## Next Phase Readiness

- Plan 07-37 can compose these protected publication ports with the remaining provider families.
- Plan 07-26 remains the only authorized path for provider authentication, signer consent, real network/relay effects, and protected live evidence.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-06*

## Self-Check: PASSED

- Confirmed all five required adapter/test files exist.
- Confirmed TDD and implementation commits `f681a9c`, `9e3dc6f`, `d9b86f0`, and `1a63f22` exist.
- No stubs, skipped tests, unrun verification, or unplanned threat surface found.
