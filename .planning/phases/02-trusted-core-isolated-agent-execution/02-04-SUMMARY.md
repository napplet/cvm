---
phase: 02-trusted-core-isolated-agent-execution
plan: 04
subsystem: worker-capabilities
tags: [typescript, zod, capability-grants, worker-port, isolation, checkpointing]
requires:
  - phase: 02-trusted-core-isolated-agent-execution
    provides: immutable Phase 2 policy fixture and proposal-only tracer contract
provides:
  - strict, grant-bound workspace, command, evidence, and checkpoint tool requests
  - replay-safe coordinator gateway with zero-effect denials
  - deterministic isolated WorkerPort fake and portable checkpoint validation
affects: [worker-adapters, session-persistence, checkpoint-resume, phase-02-plan-05]
tech-stack:
  added: []
  patterns: [complete-mediation, closed-tool-union, call-fingerprint-replay, deterministic-worker-isolation, portable-hash-bound-checkpoints]
key-files:
  created:
    - src/capabilities/scoped-tool-gateway.ts
    - src/worker-port/fake-worker.ts
    - tests/capabilities/scoped-tool-gateway.test.ts
    - tests/worker-port/contracts.test.ts
    - tests/worker-port/fake-worker.test.ts
  modified:
    - src/phase-02/contracts.ts
key-decisions:
  - "New worker tools use a closed discriminated union; the Plan 01 proposal is retained solely as a non-authoritative compatibility envelope."
  - "Only successful dispatcher effects receive idempotent replay records; every decision appends redacted correlation evidence."
  - "Checkpoint proposals are portable bytes plus canonical inventory and hashes, while storage, retention, and resume remain out of scope."
patterns-established:
  - "Gateway authorization validates strict shape, call duplication, grant state, exact binding, containment, and allowlist before dispatch."
  - "Deterministic worker tests use injected time/barriers and per-workspace synthetic files; they do not claim Bun Worker isolation."
requirements-completed: [SAFE-03, SAFE-04]
coverage:
  - id: D1
    description: Closed complete-mediation worker tool gateway with stable no-effect denials and exact replay.
    requirement: SAFE-03
    verification:
      - kind: integration
        ref: bun test tests/capabilities/scoped-tool-gateway.test.ts tests/worker-port/contracts.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Deterministic isolated WorkerPort fake with cancellation fencing, turn limits, and portable checkpoint binding.
    requirement: SAFE-04
    verification:
      - kind: integration
        ref: bun test tests/worker-port/fake-worker.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 5m 11s
  completed: 2026-08-04
status: complete
---

# Phase 02 Plan 04: Scoped Capability Gateway and Deterministic Worker Summary

Worker proposals now cross a closed, grant-bound tool gateway, while the deterministic worker proves workspace isolation, cancellation fences, and portable checkpoint boundaries without ambient authority.

## Performance

- **Duration:** 5m 11s
- **Started:** 2026-08-04T10:48:57Z
- **Completed:** 2026-08-04T10:54:08Z
- **Tasks:** 2/2
- **Files modified:** 6

## Accomplishments

- Added strict canonical WorkerPort request, event, result, tool, and checkpoint schemas in `src/phase-02/contracts.ts`.
- Implemented a coordinator-owned grant registry and complete-mediation tool gateway with exact duplicate replay, conflict denial, path containment, and redacted decision evidence.
- Added a deterministic fake worker with a per-session synthetic workspace, no credential/network surface, action-turn ceiling, cancellation/late-event fence, and hash-bound checkpoint proposals.

## Task Commits

1. **Task 1: Enforce complete mediation for every typed worker tool request (RED)** — `4241419` (test)
2. **Task 1: Enforce complete mediation for every typed worker tool request (GREEN)** — `d7f0734` (feat)
3. **Task 2: Prove WorkerPort isolation, interruption, and checkpoint semantics with a deterministic fake (RED)** — `dd95213` (test)
4. **Task 2: Prove WorkerPort isolation, interruption, and checkpoint semantics with a deterministic fake (GREEN)** — `1c6a010` (feat)

## Files Created/Modified

- `src/phase-02/contracts.ts` — single authority for strict worker, tool, result, event, and checkpoint contracts.
- `src/capabilities/scoped-tool-gateway.ts` — coordinator-owned grant lookup, validation-before-effect dispatch, and immutable replay results.
- `src/worker-port/fake-worker.ts` — deterministic proposal worker, workspace harness, and checkpoint binding validator.
- `tests/capabilities/scoped-tool-gateway.test.ts` — allow, malformed, conflict, expiry, binding, containment, and zero-side-effect matrix.
- `tests/worker-port/contracts.test.ts` — canonical schema strictness and authority exclusion coverage.
- `tests/worker-port/fake-worker.test.ts` — worker availability, isolation, interruption, limits, checkpoint, and concurrent-session coverage.

## Decisions Made

- The strict gateway tool union intentionally contains only workspace read/write, approved command IDs, evidence capture, and checkpoint export; it has no session, policy, financial, signing, deployment, or publication authority.
- Grant records are coordinator-owned and bind the exact session, action, version, policy, workspace, allowed tools, expiry, and terminal state.
- The fake routes every configured effect through `ScopedToolGateway`; its synthetic workspace is a deterministic conformance harness, not a production sandbox claim.

## TDD Gate Compliance

- **RED:** `4241419` failed because the gateway and canonical result contract did not exist; `dd95213` failed because the deterministic worker module did not exist.
- **GREEN:** `d7f0734` and `1c6a010` satisfy the focused matrices. `bun test` passes with 139 tests.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Future provider adapters can implement the canonical `WorkerPort` while retaining gateway-only authority.
- Phase 5 can add durable archive storage, retention, and resume only after revalidating the portable checkpoint binding.

## Self-Check: PASSED

- Confirmed all six Plan 04 implementation/test files and this summary exist.
- Confirmed TDD commits `4241419`, `d7f0734`, `dd95213`, and `1c6a010` exist.
