---
phase: 05-funding-interruption-durable-resume
plan: 05
subsystem: continuity
tags: [contextvm, resume, checkpoint, lease-fencing, zod]
requires:
  - phase: 05-02
    provides: atomic checkpoint resume claims and allocation-intent persistence
  - phase: 05-03
    provides: authenticated exact-generation checkpoint envelope and lease-bound restore port
  - phase: 05-04
    provides: payment hints that never resume post-grace work
provides:
  - Explicit owner-signed resume command bound to exact pending action approval
  - Atomic resume budget, checkpoint claim, fresh lease, allocation, and restore coordinator
  - Thin ContextVM resume_session branch with safe owner-scoped response projection
affects: [05-06, 05-07, continuation, contextvm, metered-generation]
tech-stack:
  added: []
  patterns: [explicit-resume-consent, claim-before-allocation, exact-generation-restore, verified-owner-adapter]
key-files:
  created: [tests/phase-05/resume-session.test.ts]
  modified: [src/continuity/contracts.ts, src/continuity/continuation-service.ts, src/contextvm/adapter.ts, src/contextvm/announcement.ts, src/phase-03/funded-core.ts, tests/contextvm/adapter.test.ts, tests/fixtures/contextvm-phase-03.json]
key-decisions:
  - "Resume authorization compares server-owned pending-action and compatibility pins before claiming budget or allocating a worker."
  - "The ContextVM adapter derives the resume principal from verifiedClientPubkey and exposes only an allowlisted result."
patterns-established:
  - "Post-grace retries retain one deterministic allocation intent and lease token derived from the signed command fingerprint."
requirements-completed: [CONT-06, CONT-07]
coverage:
  - id: D1
    description: Explicit resume requires exact owner, session, checkpoint, approval, cap reference, pending fingerprint, and server-owned compatibility pins before external effects.
    requirement: CONT-06
    verification:
      - kind: integration
        ref: bun test tests/phase-05/resume-session.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: One durable claim drives one reconciled allocation and authenticated restore under a fresh worker lease.
    requirement: CONT-07
    verification:
      - kind: integration
        ref: bun test tests/phase-05/resume-session.test.ts tests/contextvm/adapter.test.ts --timeout 10000
        status: pass
    human_judgment: false
metrics:
  duration: 5 min
  completed: 2026-08-05
status: complete
---

# Phase 05 Plan 05: Explicit ContextVM Resume Summary

**A verified ContextVM owner can explicitly resume one compatible post-grace checkpoint, while deposits, stale commands, and duplicate calls cannot create another worker, restore, provider operation, or charge.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-08-05T01:40:28Z
- **Completed:** 2026-08-05T01:45:34Z
- **Tasks:** 2/2
- **Files modified:** 8

## Accomplishments

- Added strict transport-neutral resume contracts binding owner, checkpoint, expected versions, exact pending-action approval, cap approval reference, and idempotency key.
- Added a coordinator that performs read-only replay, server-owned compatibility checks, atomic budget/claim/lease creation, reconciled allocation, authenticated exact-generation restore, and persisted restore observations.
- Added only `resume_session` to the signed ContextVM surface; its principal comes solely from the verified client pubkey and its response is a safe allowlist.
- Proved concurrent replay and denial behavior together with the full project suite.

## Task Commits

1. **Task 1: Claim and restore one checkpoint from explicit pending-action approval** — `9029113` (test), `49db49c` (feat)
2. **Task 2: Add only resume_session to the signed ContextVM surface** — `efeaa49` (test), `7de2b1f` (feat)
3. **Compatibility correction** — `c9babd7` (fix)

## Files Created/Modified

- `src/continuity/contracts.ts` — Strict explicit-resume command, compatibility, approval, and safe result schemas.
- `src/continuity/continuation-service.ts` — Claim-before-allocation coordinator and authenticated lease-bound restore flow.
- `src/contextvm/adapter.ts` — Verified-owner `resume_session` dispatch, correlation, and response allowlist.
- `src/contextvm/announcement.ts` — Resume-aware registry validation.
- `src/phase-03/funded-core.ts` — Transport-neutral continuation facade composition.
- `tests/phase-05/resume-session.test.ts` — Replay, consent, owner, funding, compatibility, allocation, and restore coverage.
- `tests/contextvm/adapter.test.ts` and `tests/fixtures/contextvm-phase-03.json` — Canonical ContextVM announcement and transport contract coverage.

## Decisions Made

- A top-up remains only a balance change after grace; it cannot invoke the resume coordinator.
- Compatibility is accepted only when durable server-owned action pins and authenticated checkpoint metadata agree; no generated/archive/package text decides trust.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 1 - Bug] Preserved existing deterministic ContextVM reference fixtures.**
   - **Found during:** Task 2 full-suite verification.
   - **Issue:** The new nine-tool registry made an older Phase 3 fixture invalid, and renaming a referenced adapter test broke the Phase 4 deterministic selector.
   - **Fix:** Kept legacy eight-tool fixture validation while the default core registry advertises `resume_session`, and retained the established test selector prefix.
   - **Files modified:** `src/contextvm/announcement.ts`, `tests/contextvm/adapter.test.ts`.
   - **Verification:** Phase 03/04 reference sets, adapter suite, and full suite pass.
   - **Committed in:** `c9babd7`.

**Total deviations:** 1 auto-fixed (Rule 1 bug).
**Impact on plan:** Compatibility-only correction; the default public registry still adds exactly `resume_session` and no transport scope expanded.

## Issues Encountered

None.

## Known Stubs

None.

## Next Phase Readiness

- Subsequent Phase 5 plans can use explicit resume results without granting payment signals or ContextVM transport any worker, storage, provider, or billing authority.
- Live provider and production storage certification remain deferred to Phase 7.

## Self-Check: PASSED

- All declared production and test files exist on disk.
- Task commits `9029113`, `49db49c`, `efeaa49`, `7de2b1f`, and `c9babd7` exist in git history.
- `bun test --timeout 10000` passed: 340 tests, 0 failures.
