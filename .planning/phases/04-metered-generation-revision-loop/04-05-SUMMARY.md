---
phase: 04-metered-generation-revision-loop
plan: 05
subsystem: contextvm-session-status
tags: [contextvm, metered-generation, billing-history, cursor-security, zod]
dependency_graph:
  requires: [04-04]
  provides: [owner-safe-session-status, signed-billing-cursors, locked-contextvm-session-tools]
  affects: [phase-04-final-verification, phase-05-continuity, phase-06-preview]
tech_stack:
  added: []
  patterns: [owner-scoped-read-projections, HMAC-bound-opaque-cursors, adapter-result-allowlisting]
key_files:
  created: [src/phase-04/session-status.ts, tests/phase-04/session-status.test.ts]
  modified: [src/contextvm/adapter.ts, src/contextvm/announcement.ts, src/phase-03/funded-core.ts, tests/contextvm/adapter.test.ts]
decisions:
  - "Status cursors are versioned HMAC envelopes bound to account, session, page size, and underlying resume position."
  - "ContextVM returns only explicitly allowlisted metered action fields; account identity and protected provider material never cross the adapter boundary."
  - "Repair remains coordinator-internal; the public generation surface is exactly start_session, revise_session, and session_status."
requirements-completed: [BILL-04, BILL-05, SESS-01, SESS-03, SESS-04]
coverage:
  - id: D1
    description: Owner-scoped redacted session status and deterministic signed billing-history pagination.
    requirement: SESS-03
    verification:
      - kind: integration
        ref: tests/phase-04/session-status.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Three signed ContextVM generation/session facades with repair excluded from the public registry.
    requirement: SESS-01
    verification:
      - kind: integration
        ref: tests/contextvm/adapter.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 8m
  completed_date: 2026-08-04
status: complete
---

# Phase 04 Plan 05: Owner-Safe Status and ContextVM Tools Summary

ContextVM now exposes tightly allowlisted start, revise, and status operations over a transport-neutral metered core, while owners can inspect immutable money and session state without protected-data leakage.

## Performance

- **Duration:** 8m
- **Started:** 2026-08-04T20:11:01Z
- **Completed:** 2026-08-04T20:18:44Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Added a pure owner-scoped status projection with canonical decimal values, safe action/session facts, generic denial outcomes, and bounded immutable billing history.
- Added versioned HMAC cursors bound to owner, session, page limit, and resume position so malformed or foreign cursors disclose no data.
- Registered exactly `start_session`, `revise_session`, and `session_status` in the ContextVM adapter, with strict input schemas and result allowlists; repair remains internal.

## Task Commits

1. **Task 1: Project exact owner-safe session status and billing history** — `1c724d7` (RED), `73ca17a` (GREEN)
2. **Task 2: Expose the three locked generation tools through ContextVM** — `656b4cd` (RED), `766eba1` (GREEN)

## Files Created/Modified

- `src/phase-04/session-status.ts` — closed redacted status contract, owner-scoped reads, and signed pagination.
- `tests/phase-04/session-status.test.ts` — denial, cursor, paging, precision, and disclosure coverage.
- `src/contextvm/adapter.ts` — signed ContextVM start/revise/status facades and response allowlisting.
- `src/contextvm/announcement.ts` — truthful eight-tool capability contract with preview/publication still unavailable.
- `src/phase-03/funded-core.ts` — metered generation/status composition seam and cursor-secret ownership.
- `tests/contextvm/adapter.test.ts` — public tool and announcement contract coverage.

## Decisions Made

- Cursor MACs bind all query-sensitive fields and encapsulate the store cursor, preventing client construction or cross-owner/session reuse.
- Action results omit account identity and any provider/protected evidence from ContextVM responses, even when the transport-neutral service result contains it.
- The composition root accepts only transport-neutral metered facades and retains a server-held cursor secret; no HTTP, x402, L402, repair, preview, or publication endpoint was added.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical integration] Updated the announcement fixture and Phase 3 reference-set expectation.**
- **Found during:** Task 2
- **Issue:** The existing seven-tool fixture advertised obsolete generic `generation` and `session` entries, contradicting the locked public contract.
- **Fix:** Migrated the fixture and deterministic reference-set assertion to the eight concrete tool names while keeping preview and publication planned/unavailable.
- **Files modified:** `tests/fixtures/contextvm-phase-03.json`, `tests/evals/phase-03-reference-set.test.ts`
- **Verification:** ContextVM adapter, Phase 3 tracer, status, and deterministic reference-set tests passed.
- **Committed in:** `766eba1`

**Total deviations:** 1 auto-fixed (1 Rule 2 missing-critical integration).

## Verification

- `bun test tests/phase-04 tests/billing/price-card.test.ts tests/billing/operation-finalization.test.ts tests/billing/line-items.test.ts tests/model/reconciliation.test.ts tests/contextvm/adapter.test.ts --timeout 10000` — passed (34 tests).
- `bun test tests/contextvm/adapter.test.ts tests/phase-03/tracer.test.ts tests/phase-04/session-status.test.ts tests/evals/phase-03-reference-set.test.ts --timeout 10000` — passed (36 tests).
- `git diff --check` — passed.
- Repository-wide `tsc --noEmit` remains pre-existingly failing in unrelated Bun/toolchain and legacy source files; the new Plan 04-05 files produced no TypeScript diagnostics.

## Known Stubs

None.

## Next Phase Readiness

Plan 04-06 can perform the final Phase 4 verification with owner-safe status and the locked ContextVM public tool surface in place. Phase 04 remains active until that plan completes.

## Self-Check: PASSED

- All eight plan files exist.
- All four Task 1/2 RED and GREEN commits exist in git history.
