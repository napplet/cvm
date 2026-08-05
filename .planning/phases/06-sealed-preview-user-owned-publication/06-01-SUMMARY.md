---
phase: 06-sealed-preview-user-owned-publication
plan: "01"
subsystem: publication
tags: [preview, sealed-artifact, owner-signing, publication, tracer]
requires:
  - phase-05-continuation-artifact-lineage
provides:
  - strict Phase 6 publication contracts
  - deterministic persist-before-effect publication tracer
affects:
  - phase-06-plans-02-through-07
tech_stack:
  added: []
  patterns: [zod-boundaries, transactional-memory-authority, effect-claims, owner-safe-results]
key_files:
  created:
    - src/publication/contracts.ts
    - src/publication/preview-service.ts
    - src/publication/publication-service.ts
    - src/persistence/publication-store.ts
    - tests/phase-06/tracer.test.ts
  modified: []
decisions:
  - Preview descriptors expose only a short-lived exact-artifact read grant with allow-scripts sandboxing.
  - Publication commits its intent and each deploy/owner-manifest/attestation claim before external port calls.
metrics:
  duration: 5m 11s
  completed_date: 2026-08-05
status: complete
---

# Phase 06 Plan 01: Sealed Preview Publication Tracer Summary

One deterministic vertical slice now carries a verified sealed artifact through a sandbox-safe preview descriptor, owner-event verification, three persist-before-effect publication operations, and an exact replay-safe linked result.

## Completed Work

- Added strict, transport-neutral Zod schemas for artifact identity, capability review, preview descriptor, intent, public owner event, effect observations, status, and result.
- Added deterministic preview and publication services that preserve owner, artifact, d-tag, and capability-digest bindings.
- Added a serialized in-memory publication authority that commits intent, signed event, effect claims, observations, and final result atomically.
- Added a TDD tracer proving intent-before-signing, effect-claim-before-port-call ordering, completed linked result projection, and zero-effect replay.

## Verification

- `bun test tests/phase-06/tracer.test.ts --timeout 10000` — 3 passed, 0 failed.
- The tracer verifies one call for each of deploy, owner-manifest, and attestation, then verifies replay produces no additional verifier or effect calls.

## TDD Gate Compliance

- RED commit: `4f61c9f` — failing tracer proved the new slice was absent.
- GREEN commit: `5577583` — contracts, services, store, and tracer pass.

## Decisions Made

- Preview grants are strictly `preview_read_only` and render only with `sandbox="allow-scripts"`.
- Result completion is projected solely after all three stored observations are completed; partial outcomes direct the owner to reconciliation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected internal descriptor binding and template digest validation**
- **Found during:** Task 06-01-01 verification
- **Issue:** The preview port received a runtime selector outside its narrow artifact-read input, and the initial template digest was not a valid SHA-256 value.
- **Fix:** Narrowed the artifact read input and derived the template digest with SHA-256 before strict schema validation.
- **Files modified:** `src/publication/preview-service.ts`, `src/publication/publication-service.ts`
- **Commit:** `5577583`

## Known Stubs

None. Deterministic local ports are intentional tracer fixtures; production host, signer, CLI, relay, and attestation adapters are owned by later Phase 6 plans.

## Self-Check

PASSED — all five planned files and both TDD commits (`4f61c9f`, `5577583`) exist.
