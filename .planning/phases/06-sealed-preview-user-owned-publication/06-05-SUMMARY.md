---
phase: 06-sealed-preview-user-owned-publication
plan: "05"
subsystem: publication
tags: [napplet-cli, sealed-deployment, source-contract, reconciliation]
requires:
  - phase: 06-04
    provides: durable publication intents, claims, and observations
provides:
  - Exact promoted CLI source contract probe with fail-closed availability
  - Narrow exact-byte, pre-signed named-deployment adapter
  - Original-operation-only publication reconciliation and linked safe status
affects: [06-06, 06-07, publication]
tech-stack:
  added: []
  patterns: [pinned source contract, structured source facade, claim-then-observe reconciliation]
key-files:
  created:
    - src/publication/napplet-cli-source-contract.ts
    - src/publication/napplet-cli-adapter.ts
    - src/publication/public-status.ts
  modified:
    - src/publication/publication-service.ts
    - src/publication/contracts.ts
    - src/persistence/publication-store.ts
key-decisions:
  - "Publication remains unavailable until a source checkout verifies the promoted CLI commit, Linux asset SHA, and source hashes."
  - "Only structured lower-level upload and pre-signed relay calls are eligible; no CLI command, npm package, signer, or stdout path is reachable."
  - "Unknown effects reconcile strictly by their stored original operation IDs and cannot dispatch a replacement."
patterns-established:
  - "Source contract: exact immutable identity and closed unsafe-route inventory precede adapter construction."
  - "Terminal publication: require linked full-server upload, owner relay, and attestation relay observations."
requirements-completed: [PUB-04, PUB-05]
coverage:
  - id: D1
    description: Exact promoted CLI source facts and fail-closed availability probe.
    requirement: PUB-04
    verification:
      - kind: unit
        ref: tests/phase-06/cli-source-contract.test.ts
        status: pass
      - kind: other
        ref: bun run scripts/probe-phase-06-cli-source-contract.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Exact sealed byte and completed owner-event deployment through the structured source facade.
    requirement: PUB-04
    verification:
      - kind: unit
        ref: tests/phase-06/sealed-deployment.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Single-dispatch publication effects with original-operation-only reconciliation and safe partial status.
    requirement: PUB-05
    verification:
      - kind: integration
        ref: tests/phase-06/publication-reconciliation.test.ts
        status: pass
      - kind: integration
        ref: tests/phase-06/publication-store-parity.test.ts
        status: pass
    human_judgment: false
duration: 8m 27s
completed: 2026-08-05
status: complete
---

# Phase 06 Plan 05: Promoted CLI Source Contract and Reconciliation Summary

**Pinned promoted CLI source validation, exact sealed deployment adapter, and durable original-operation reconciliation without CVM signing custody.**

## Performance

- **Duration:** 8m 27s
- **Started:** 2026-08-05T09:15:19Z
- **Completed:** 2026-08-05T09:23:46Z
- **Tasks:** 3/3
- **Files modified:** 14

## Accomplishments

- Bound publication eligibility to commit `1a38b9150f3a3da148091c11bce4d0365f7298e5` and Linux SHA-256 `46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e` with eight pinned source hashes.
- Added a source-checkout probe that returns `publication_unavailable` rather than attempting an unverified CLI, package, signer, build, manifest, or command path.
- Added exact-byte, single-named-target deployment and completed-owner-event relay through an injected typed promoted-source facade.
- Made publication effects claim-before-dispatch, safely preserve unknown/failed/partial observations, and reconcile by observing original IDs only.

## Task Commits

1. **Task 06-05-01: Probe the exact promoted source** — `e8955b2` (test), `8e3a2ba` (feat)
2. **Task 06-05-02: Adapt pre-signed named deployment** — `a1e3662` (test), `a132391` (feat)
3. **Task 06-05-03: Persist/reconcile original effects** — `29acbc2` (test), `8bff9ad` (feat)
4. **Task 06-05 follow-up: Preserve existing public status and exact replay** — `f0f0340` (fix)

## Files Created/Modified

- `src/publication/napplet-cli-source-contract.ts` — fail-closed promoted-source identity and surface validator.
- `scripts/probe-phase-06-cli-source-contract.ts` — checkout-hash verifier emitting structured probe results only.
- `src/publication/napplet-cli-adapter.ts` — exact sealed payload and completed-event structured facade.
- `src/publication/publication-service.ts` — one-claim dispatch and original-ID observation flow.
- `src/publication/public-status.ts` — linked safe publication completion projection while retaining preview-safe status behavior.
- `src/persistence/publication-store.ts` — preserves durable partial observations.
- `tests/phase-06/cli-source-contract.test.ts` — contract mutation/fail-closed coverage.
- `tests/phase-06/sealed-deployment.test.ts` — exact-byte and signer-path denial coverage.
- `tests/phase-06/publication-reconciliation.test.ts` — replay, ambiguity, and observation-only coverage.

## Decisions Made

- The repository does not claim live publication availability without a verified promoted-source checkout; the current probe correctly reports `SOURCE_CHECKOUT_NOT_PROVIDED` as `publication_unavailable`.
- The adapter is strictly source-port injected and consumes typed structured data; it never installs or invokes npm `@napplet/cli@0.0.0`.
- A terminal complete status requires a full server upload, owner event relay, and distinct attestation relay; all other effect states remain safely visible.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Preserve durable partial observations**
- **Found during:** Task 06-05-03
- **Issue:** The existing publication observation schema collapsed partial external outcomes to `unknown`, preventing the required distinct partial state.
- **Fix:** Added `partial` observation support across the publication contract and memory/SQLite/PostgreSQL persistence mappings.
- **Files modified:** `src/publication/contracts.ts`, `src/persistence/publication-store.ts`, `src/persistence/sqlite-publication-store.ts`, `src/persistence/postgres-sql-funding-store.ts`
- **Verification:** Phase 06 reconciliation and persistence parity tests pass.
- **Committed in:** `8bff9ad`

**2. [Rule 1 - Bug] Retain preview-safe status exports and exact replay behavior**
- **Found during:** Task 06-05-03 full Phase 06 verification
- **Issue:** Extending `public-status.ts` displaced preview status exports, and a stored exact replay re-ran owner-event verification.
- **Fix:** Restored preview-safe projections and returned the stored result for an exact persisted event before verification or effect dispatch.
- **Files modified:** `src/publication/public-status.ts`, `src/publication/publication-service.ts`
- **Verification:** `bun test tests/phase-06 --timeout 10000` passes all 30 tests.
- **Committed in:** `f0f0340`

**Total deviations:** 2 auto-fixed (1 Rule 2, 1 Rule 1).

## Issues Encountered

None blocking. The source probe ran without `NAPPLET_CLI_SOURCE_CHECKOUT` and correctly returned a structured `publication_unavailable` result rather than contacting or executing a live provider.

## User Setup Required

None. A future live-certification environment must provide an independently verified source checkout through `NAPPLET_CLI_SOURCE_CHECKOUT`; that remains Phase 7 evidence, not a user runtime configuration.

## Next Phase Readiness

Plan 06-06 can consume fail-closed publication status and the new safe reconciliation projection. Live CLI, Blossom, relay, and signer execution remain explicitly `not_observed` for Phase 7.

## Self-Check: PASSED

- Required source, adapter, service, script, fixture, and tests exist.
- Task commits `e8955b2`, `8e3a2ba`, `a1e3662`, `a132391`, `29acbc2`, `8bff9ad`, and `f0f0340` exist.

---
*Phase: 06-sealed-preview-user-owned-publication*
*Completed: 2026-08-05*
