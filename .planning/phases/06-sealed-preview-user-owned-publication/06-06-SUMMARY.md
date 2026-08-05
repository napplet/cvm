---
phase: 06-sealed-preview-user-owned-publication
plan: "06"
subsystem: contextvm-publication-host-surface
tags: [contextvm, zod, preview, publication, host-surface]
requires:
  - phase: 06-02
    provides: sealed preview descriptors and capability review
  - phase: 06-03
    provides: owner-signed manifest and publication intent fencing
  - phase: 06-05
    provides: exact promoted CLI source contract and reconciled publication status
provides:
  - signed owner-scoped preview and publication ContextVM actions
  - fail-closed publication availability projection
  - compact host-native sealed preview/publication rendering contract
affects: [06-07, contextvm, publication, host-runtime]
tech-stack:
  added: []
  patterns: [strict-discriminated-actions, source-contract-gating, owner-safe-projection, pure-host-surface]
key-files:
  created:
    - src/publication/host-surface.ts
    - tests/contextvm/publication-adapter.test.ts
    - tests/phase-06/host-surface.test.ts
  modified:
    - src/contextvm/adapter.ts
    - src/contextvm/announcement.ts
    - src/phase-03/funded-core.ts
key-decisions:
  - "Preview and publication retain one ContextVM tool name each, with strict discriminated action schemas rather than a broader public API."
  - "Publication is never announced or dispatched unless the Plan 05 promoted-source contract reports available; unavailable calls return only publication_unavailable."
  - "The host surface is a pure owner-safe rendering projection with no DOM, HTTP route, dashboard, signing, or runtime-message authority."
patterns-established:
  - "ContextVM facades receive a verified principal, derived domain account identity, request event ID, and canonical invocation hash while wire output is explicitly allowlisted."
  - "Host rendering contracts encode responsive, accessibility, overflow, acknowledgement, and recovery constraints as schemas rather than implicit UI convention."
requirements-completed: [PREV-01, PREV-02, PREV-03, PREV-04, PUB-01, PUB-02, PUB-03, PUB-04, PUB-05]
coverage:
  - id: D1
    description: Signed ContextVM preview and publication action routing, owner scoping, replay correlation, safe notification projection, and fail-closed source availability.
    requirement: PUB-04
    verification:
      - kind: integration
        ref: tests/contextvm/publication-adapter.test.ts
        status: pass
      - kind: integration
        ref: bun test tests/contextvm/publication-adapter.test.ts tests/contextvm/adapter.test.ts tests/contextvm/announcement.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: Compact linear host surface contract for empty, loading, error, populated, partial, overflow, cardinality, and long-text states.
    requirement: PREV-03
    verification:
      - kind: unit
        ref: tests/phase-06/host-surface.test.ts
        status: pass
      - kind: unit
        ref: bun test tests/phase-06 --timeout 10000
        status: pass
    human_judgment: false
metrics:
  duration: 13m
  completed_date: 2026-08-05
status: complete
---

# Phase 06 Plan 06: Signed Preview, Publication, and Host Surface Summary

**Signed ContextVM preview/publication actions now gate source availability and project into a compact, strict owner-safe host surface.**

## Performance

- **Duration:** 13m
- **Started:** 2026-08-05T09:25:00Z
- **Completed:** 2026-08-05T09:38:38Z
- **Tasks:** 2/2
- **Files modified:** 6

## Accomplishments

- Added strict `preview` descriptor/review and `publication` create/submit/status/reconcile actions to the signed ContextVM boundary, deriving domain ownership only from the verified pubkey.
- Made preview availability facade-dependent and publication availability additionally fail closed on the Plan 05 promoted-source contract; unavailable publication actions make no facade or external-effect call.
- Defined a pure compact host-surface schema covering the artifact-first linear flow, acknowledgement, safe recovery, capability cardinality, partial effects, responsive layout, scrolling, copied identifiers, and accessible long-text behavior.

## Task Commits

1. **Task 06-06-01: Expose strict signed preview and publication ContextVM actions** — `c735ae8` (RED), `afe4775` (GREEN)
2. **Task 06-06-02: Define the compact linear host surface contract** — `a2f3eef` (RED), `bcc6ee7` (GREEN)

## Verification

- `bun test tests/contextvm/publication-adapter.test.ts tests/contextvm/adapter.test.ts tests/contextvm/announcement.test.ts tests/phase-06/host-surface.test.ts --timeout 10000` — 20 passed.
- `bun test tests/phase-06 --timeout 10000` — 39 passed.
- Serialized adapter projections were searched for provider/store/private/secret leakage; fake unsafe fields are intentionally present only in denial assertions and do not cross responses.

## Decisions Made

- Publication is only an invocable ContextVM tool when a configured facade and a validated Plan 05 source-contract result are both present; no fallback CLI path exists.
- The host contract declares rendering facts only. It cannot create publication effects, handle a signer, expose a dashboard, or trust runtime messages.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test assertion] Avoided treating the required `mobileLayout: stacked` rendering token as a forbidden stack trace.**
- **Found during:** Task 06-06-02
- **Issue:** The safe-error serialization assertion matched the required `stacked` mobile-layout value instead of an exposed raw error detail.
- **Fix:** Narrowed the assertion to provider, secret, and raw fields while retaining the mandatory stacked mobile contract.
- **Files modified:** `tests/phase-06/host-surface.test.ts`
- **Verification:** Host surface suite passes all covered UI state assertions.
- **Committed in:** `bcc6ee7`

**Total deviations:** 1 auto-fixed (Rule 1).
**Impact on plan:** The correction preserves the specified responsive token and strengthens the intended safe-error check without expanding scope.

## Known Stubs

None. Live host, signer, CLI, relay, and provider observations remain explicitly outside this deterministic Plan 6 projection and are not represented as runtime stubs.

## User Setup Required

None. A production composition must supply the already validated Plan 05 source-contract result; absent input remains truthfully unavailable.

## Next Phase Readiness

Plan 06-07 can evaluate the sealed owner flow through the exact signed ContextVM and host projection contracts. ContextVM remains the sole v1 public transport and no signing custody or public HTTP surface was added.

## Self-Check: PASSED

- All six planned source/test artifacts and this summary exist.
- RED/GREEN commits `c735ae8`, `afe4775`, `a2f3eef`, and `bcc6ee7` exist in git history.
