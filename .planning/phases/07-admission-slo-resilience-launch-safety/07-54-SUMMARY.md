---
phase: 07-admission-slo-resilience-launch-safety
plan: "54"
subsystem: ui
tags: [contextvm, nostr, postgres, playwright, chromium, napplet, continuity]
requires:
  - phase: 07-57
    provides: encrypted pre-admission checkpoints, admission binding, and revision recovery primitives
  - phase: 07-56
    provides: verified worker artifacts, grants, Paja preview, and durable artifact storage
  - phase: 07-53
    provides: metered proposal/provider operation and source-proposal persistence
provides:
  - signed development-only pre-admission save, status, and explicit resume through ContextVM
  - browser-held signing identity, durable pending-action projection, immutable version selection, and verified preview
  - Chromium evidence for top-up/restart/resume and exact duplicate revision replay
affects: [07-55-development-gui, contextvm, continuity, revisions]
tech-stack:
  added: []
  patterns: ["Optional development-only ContextVM facade with strict signed variants", "Browser projections are refreshed from signed durable status before terminal UI state"]
key-files:
  created: []
  modified:
    - src/contextvm/adapter.ts
    - src/dev-ui/contextvm-server.ts
    - src/dev-ui/browser/contextvm-client.ts
    - src/dev-ui/browser/main.ts
    - src/dev/dev-composition.ts
    - src/phase-04/session-status.ts
    - tests/dev-ui/continuation-revision.e2e.ts
    - tests/dev-ui/contextvm-server-liveness.e2e.ts
key-decisions:
  - "Pre-admission remains an optional development-composition facade; the default ContextVM composition fails closed."
  - "Resume always obtains a separate signed funded admission before sending the persisted pending-action command."
  - "Revision replay uses the original signed idempotency identity and is proven against durable effect counts."
patterns-established:
  - "Keep browser private keys in sessionStorage scoped by the stable service public key; never project them through bootstrap, DOM facts, or server logs."
  - "Display terminal generation readiness only after reloading signed session and balance projections."
requirements-completed: [DEV-GUI-02, DEV-GUI-04, DEV-GUI-05, DEV-GUI-06, DEV-GUI-07, DEV-GUI-08, DEV-GUI-10, DEV-GUI-12]
coverage:
  - id: D1
    description: Signed low-balance pre-admission intent survives restart, is funded separately, and explicitly resumes once to a verified interactive preview.
    requirement: DEV-GUI-07
    verification:
      - kind: e2e
        ref: "bun run tests/dev-ui/continuation-revision.e2e.ts --case=pre-admission-fund-restart-explicit-resume"
        status: pass
      - kind: automated_ui
        ref: "bun run tests/dev-ui/full-flow.e2e.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: Revisions retain three immutable versions through restart, with a signed duplicate request producing no second durable effect.
    requirement: DEV-GUI-06
    verification:
      - kind: e2e
        ref: "bun run tests/dev-ui/continuation-revision.e2e.ts --case=revisions-duplicates-restarts"
        status: pass
      - kind: unit
        ref: "bun test tests/phase-04/revision.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: Strict ContextVM signed variants and owner-safe session projections preserve legacy funded/worker continuation behavior.
    requirement: DEV-GUI-02
    verification:
      - kind: unit
        ref: "bun test tests/contextvm/adapter.test.ts tests/phase-04/session-status.test.ts"
        status: pass
      - kind: e2e
        ref: "bun run tests/dev-ui/contextvm-server-liveness.e2e.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: Configured external-provider operation through the browser remains conditional on explicitly supplied credentials and immutable price sources.
    requirement: DEV-GUI-11
    verification:
      - kind: other
        ref: "deterministic fixture full-flow; configured credentials intentionally absent"
        status: unknown
    human_judgment: true
    rationale: "No configured-provider credentials were supplied to this development run."
metrics:
  duration: not-recorded
  completed: 2026-10-15
status: complete
---

# Phase 07 Plan 54: Development continuity and immutable revisions Summary

**Signed ContextVM pre-admission recovery now persists a bounded action through funding and a service restart, while verified revisions retain immutable previewable versions and exact duplicate replay effects.**

## Performance

- **Duration:** Not recorded; multi-agent execution overlapped dependent work.
- **Started:** Not recorded
- **Completed:** 2026-10-15
- **Tasks:** 2/2
- **Files modified:** 11

## Accomplishments

- Added strict owner-injected ContextVM pre-admission start, pending-action status, and resume variants without exposing the optional facade from production/default composition.
- Persisted browser signing identity only in service-scoped session storage; the workspace distinguishes saved intent, credited funds, accepted admission, and resumed generation.
- Added durable status timeline/version hydration, selected artifact previews, private bounded recovery diagnostics, restart-stable service identity, and durable worker-result recovery integration.
- Proved Cashu/NWC funding, two revisions, underfunded save, detached restart, explicit resume, verified worker artifact, Paja interaction, and SQL/UI equality in one direct Chromium journey.
- Proved a replay of the same signed revision leaves actions, provider operations, usage receipts, debits, artifacts, completed worker results, and version count unchanged.
- Added an isolated forced-GC 65-second listener regression and closed development server state before browser resources during browser-tracer cleanup.

## Task Commits

1. **Task 1: Complete signed pre-admission save, fund, restart, resume, and preview in Chromium** - `c08ec6c`, `b53226e`, `1954f8f`, `a38f8ef`, `da2def9`, `7d0b1bc`, `75f23a1`, `e47299f`, `8f7bdeb`, `b62dd76`, `a38d854` (feat/fix/test)
2. **Task 2: Complete immutable revisions, version selection, and duplicate/restart recovery** - `c93dfb3`, `0f19857` (test)

Supporting dependencies included `89dc6dc` (stable service identity), `4025fb0` (durable worker result reuse), and `f4c49aa` (atomic revision version/admission fence).

## Files Created/Modified

- `src/contextvm/adapter.ts` - Strict discriminated signed start, resume, and pending-status wire variants with verified owner injection.
- `src/dev/dev-composition.ts` - Development-only pre-admission authority and configured-pricing composition.
- `src/dev-ui/contextvm-server.ts` - Restart-stable identity, state-root wiring, durable worker use, timeline/status projection, and bounded private diagnostics.
- `src/dev-ui/browser/contextvm-client.ts` - Typed ContextVM client commands and signed session identity handling.
- `src/dev-ui/browser/main.ts` - Funding, save/resume, version selection, timeline, facts, preview, and exact revision replay UX.
- `src/phase-04/session-status.ts` - Owner-scoped immutable artifacts and durable lifecycle timeline projection.
- `src/continuity/checkpoint-envelope.ts` and `src/continuity/pre-admission-session-service.ts` - Private, bounded restore-stage diagnostics while retaining generic public denials.
- `tests/dev-ui/continuation-revision.e2e.ts` - Chromium restart, revision lineage, Paja interaction, and duplicate durable-effect evidence.
- `tests/dev-ui/contextvm-server-liveness.e2e.ts` - Forced-GC idle listener regression for the local development server factory.

## Decisions Made

- A top-up only credits the account. It does not invoke admission or execute a saved action; Resume performs those separately with fresh signed requests.
- The default composition does not inject pre-admission capability. The adapter rejects unavailable variants rather than manufacturing a session.
- Toolchain identity is part of the restored pending-action pins. Local Compose builds disable provenance/SBOM attestations so its Docker image identity remains stable across a normal restart.
- Public UI errors remain generic. Bounded uppercase stage codes are written only to the local private launcher diagnostic path for restart investigations.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Stabilized local toolchain identity across detached service restart**
- **Found during:** Task 1
- **Issue:** Docker Compose provenance/SBOM attestations changed the local image ID without changing worker layers, causing the correctly pinned pending action to fail restore after a process restart.
- **Fix:** The development launcher builds with explicit `--provenance=false --sbom=false`; repeated local builds now retain the same image ID.
- **Files modified:** `scripts/dev.ts`, development Compose integration
- **Verification:** `bun run tests/dev-ui/full-flow.e2e.ts` passed all ten stages, including detached restart and explicit resume.

**2. [Rule 1 - Bug] Nested durable timeline under the strict session status projection**
- **Found during:** Task 1
- **Issue:** The server returned timeline at the response top level while the strict browser schema allowed it only inside `session`, rejecting an otherwise valid signed status response.
- **Fix:** Projected timeline inside the signed session object and refreshed it before terminal UI readiness.
- **Files modified:** `src/dev-ui/contextvm-server.ts`, `src/dev-ui/browser/main.ts`
- **Verification:** Full Chromium journey passed SQL/UI facts and all five durable timeline stages.

**3. [Rule 2 - Correctness] Added durable effect equality for signed revision replay**
- **Found during:** Task 2
- **Issue:** Version-count-only replay coverage could miss a duplicate provider, charge, worker, or receipt effect.
- **Fix:** The browser tracer snapshots account-scoped actions, provider operations, receipts, debit rows, verified artifacts, and completed worker results before and after replay.
- **Files modified:** `tests/dev-ui/continuation-revision.e2e.ts`
- **Verification:** Focused tracer passed with all counts unchanged.

---

**Total deviations:** 3 auto-fixed (2 Rule 1 bugs, 1 Rule 2 correctness gap).
**Impact on plan:** All changes preserve the planned signed, durable authority boundaries and make restart/replay evidence meaningful.

## Issues Encountered

- Cross-process pending restore initially denied after all pre-resume stages had passed. Process-isolated envelope tests proved key persistence and AEAD were correct; bounded restore diagnostics isolated the unstable local Docker image identity, and stable build flags resolved it.
- A Bun child-process/Playwright file-descriptor interaction could close the later-created development listener. The readiness probe now runs in a bounded child process; the 65-second forced-GC listener regression passed after that isolation. This fix is owned by the development readiness support work and is not represented as a Plan 54 production behavior claim.
- The configured-provider browser branch was not exercised because this run intentionally supplied no provider credentials or price-source captures. The deterministic fixture label remains visible and the summary records this as human judgment rather than treating it as coverage.

## Known Stubs

- `src/dev-ui/browser/main.ts` — “Publication unavailable in this development setup” is an intentional, accurate development-state projection. Publication is not fabricated by this workspace.

## User Setup Required

None - deterministic development fixtures and isolated local payment services supply the required test environment. A configured provider requires separately supplied credentials and immutable captured price-source inputs.

## Next Phase Readiness

- Plan 55 can rely on stable detached launcher lifecycle, the reusable full browser journey, accessible status regions, version selection, and truthful development publication state.
- Follow-on recovery work must preserve the fail-closed behavior for unknown original provider operations and must not treat configured-provider coverage as passed without credentials.
- `SESS-02` and `OPS-02` through `OPS-04` remain broader production requirements; this plan provides development-path evidence and does not mark them complete.

## Self-Check: PASSED

- Required source and tracer files exist, and all listed Plan 54 commits are present in git history.
- Focused revision replay tracer and targeted ContextVM/session/revision suite passed after the stable image fix.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-10-15*
