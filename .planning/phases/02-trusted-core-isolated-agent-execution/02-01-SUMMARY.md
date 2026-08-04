---
phase: 02-trusted-core-isolated-agent-execution
plan: 01
subsystem: trusted-core
tags: [typescript, bun, zod, policy, evidence, idempotency, worker-port]
requires:
  - phase: 01-napplet-contract-artifact-verification
    provides: canonical JSON, SHA-256 identity, and fail-closed evidence patterns
provides:
  - immutable Phase 2 admission, tool, action, and sandbox policy fixture
  - strict transport-neutral worker, tool, result, and evidence contracts
  - one mediated, replay-safe trusted-core tracer with canonical evidence
affects: [phase-02-plan-02, phase-02-plan-03, phase-02-plan-04, worker-adapters, session-persistence]
tech-stack:
  added: [zod@4.4.3]
  patterns: [version-fenced-actions, canonical-replay-fingerprints, coordinator-owned-tool-mediation, copy-then-commit-test-store]
key-files:
  created:
    - src/policy/phase-02-policy.ts
    - src/phase-02/contracts.ts
    - src/phase-02/trusted-core.ts
    - tests/phase-02/tracer.test.ts
  modified:
    - package.json
    - bun.lock
key-decisions:
  - "All initial Phase 2 ceilings reside in the deeply immutable phase-02-policy-2026-08-04 fixture."
  - "Workers return strict proposals only; the coordinator derives grants, mediates the single workspace write, and owns results, versioning, and evidence."
  - "The serialized in-memory store is explicitly a copy-then-commit tracer double; Plan 03 replaces it with durable SQLite composition."
patterns-established:
  - "Exact retries compare canonical SHA-256 action fingerprints and return the frozen recorded result without rerunning side effects."
  - "Authority denials and worker uncertainty append correlated evidence but never advance the authoritative session version."
requirements-completed: [SESS-05, SAFE-01, SAFE-02, SAFE-03, SAFE-04]
coverage:
  - id: D1
    description: Immutable policy fixture and strict transport-neutral shared contracts.
    requirement: SAFE-01
    verification:
      - kind: unit
        ref: tests/phase-02/tracer.test.ts#pins every Phase 2 ceiling in one immutable fixture
        status: pass
      - kind: unit
        ref: tests/phase-02/tracer.test.ts#exports strict transport-neutral boundary schemas for downstream phases
        status: pass
    human_judgment: false
  - id: D2
    description: Bounded action tracer commits one mediated workspace write, version, and content-addressed evidence record.
    requirement: SESS-05
    verification:
      - kind: e2e
        ref: tests/phase-02/tracer.test.ts#admits one bounded action mediates one scoped write and commits canonical evidence
        status: pass
    human_judgment: false
  - id: D3
    description: Duplicate, stale, admission, authority, and uncertainty paths preserve the required fail-closed state and effect boundaries.
    requirement: SAFE-03
    verification:
      - kind: integration
        ref: bun test tests/phase-02/tracer.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 6m 15s
  completed: 2026-08-04
status: complete
---

# Phase 2 Plan 01: Trusted Core Tracer Summary

Bounded version-fenced actions now cross a strict proposal-only WorkerPort, a single coordinator-mediated workspace write, and canonical append-only evidence with exact replay safety.

## Performance

- **Duration:** 6m 15s
- **Started:** 2026-08-04T10:37:48Z
- **Completed:** 2026-08-04T10:44:03Z
- **Tasks:** 1/1
- **Files modified:** 7

## Accomplishments

- Pinned `zod@4.4.3` and established an immutable, versioned fixture for all initial Phase 2 resource ceilings.
- Added strict, transport-neutral action, worker proposal, tool request, result, evidence, session-store, and WorkerPort seams with no billing, transport, signing, deployment, or publication authority.
- Proved the tracer’s accepted, exact-replay, conflicting-key, stale-version, admission-denial, tool-scope-denial, and worker-uncertainty paths with zero forbidden effects.

## Task Commits

1. **Task 1: Prove one admitted action through complete mediation and atomic evidence commit (RED)** — `f970635` (test)
2. **Task 1: Prove one admitted action through complete mediation and atomic evidence commit (GREEN)** — `a3b4e47` (feat)
3. **Task 1: Shared contract export coverage (RED)** — `6a5d8e5` (test)
4. **Task 1: Strict shared contract completion (GREEN)** — `248cb2c` (feat)

## Files Created/Modified

- `package.json`, `bun.lock` — exact runtime Zod dependency and locked resolution.
- `src/policy/phase-02-policy.ts` — deeply frozen initial policy identity and explicit resource ceilings.
- `src/phase-02/contracts.ts` — strict Zod contracts plus `SessionStore` and proposal-only `WorkerPort` interfaces.
- `src/phase-02/trusted-core.ts` — serialized test store, action fingerprint/evidence helpers, trusted action sequencing, and fixed workspace-write dispatcher.
- `tests/phase-02/tracer.test.ts` — end-to-end positive, replay, and representative fail-closed denial coverage.

## Decisions Made

- The coordinator creates opaque action-bound grants from principal/session/action/version/policy/workspace facts; worker input cannot select or widen a grant.
- Authority and uncertainty failures retain append-only correlated evidence while preserving the current session version; only a complete validated proposal advances it.
- The in-memory implementation is a fast injected test double only, deliberately not the durable Phase 2 reference composition.

## TDD Gate Compliance

- **RED:** `f970635` failed because the planned Phase 2 modules did not exist; `6a5d8e5` then exposed the missing named shared-contract exports.
- **GREEN:** `a3b4e47` implemented the tracer; `248cb2c` completed the named strict contract surface. Focused and full Bun suites pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Completed the named shared-contract integration surface.**
- **Found during:** Task 1
- **Issue:** The first implementation had strict internal schemas but omitted named admission/action/event/tool/result/evidence exports specified by the plan’s downstream integration contract.
- **Fix:** Added the exported aliases and strict result/evidence parsing, with a focused compatibility test.
- **Files modified:** `src/policy/phase-02-policy.ts`, `src/phase-02/contracts.ts`, `src/phase-02/trusted-core.ts`, `tests/phase-02/tracer.test.ts`
- **Verification:** `bun test tests/phase-02/tracer.test.ts`, `bun test`
- **Committed in:** `248cb2c`

---

**Total deviations:** 1 auto-fixed (Rule 2)
**Impact on plan:** Required for the plan’s shared, downstream-safe contract seam; no scope expansion.

## Issues Encountered

- `bunx tsc --noEmit` is not a locked project gate and reports pre-existing Bun/Node declaration and Phase 1 typing configuration failures. The focused module bundles successfully and the full Bun suite passes; the deferred setup note is recorded in `deferred-items.md`.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 02–04 can consume the immutable policy and strict coordinator/WorkerPort seams.
- Plan 03 must replace `TransactionalMemorySessionStore` in the reference composition with the durable SQLite store; no provider, transport, billing, or publication implementation was introduced here.

## Self-Check: PASSED

- Confirmed commits `f970635`, `a3b4e47`, `6a5d8e5`, and `248cb2c` exist.
- Confirmed the policy fixture, contracts, trusted core, tracer test, package manifest, and lockfile exist.
