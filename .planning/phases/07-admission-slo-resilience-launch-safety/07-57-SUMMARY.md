---
phase: 07-admission-slo-resilience-launch-safety
plan: "57"
subsystem: payments
tags: [postgres, aes-gcm, encrypted-checkpoint, metered-generation, docker]
requires:
  - phase: 07-56
    provides: pinned local worker, proposal, verifier, artifact, and real-preview path
provides:
  - encrypted, owner-scoped pre-admission pending actions with no execution effects
  - explicit accepted-admission resume into the original metered operation
  - lookup-only recovery for an already claimed provider operation
affects: [07-54, 07-55, development-payments, continuation]
tech-stack:
  added: []
  patterns: [pre-admission authority is independent from legacy continuation, authenticated envelope before durable resume binding]
key-files:
  created: [migrations/development/005_pending_actions.sql, src/continuity/pre-admission-session-service.ts, src/dev/local-checkpoint-store.ts]
  modified: [scripts/dev-payments.ts, src/continuity/checkpoint-envelope.ts, src/phase-04/metered-generation-service.ts, src/persistence/funding-store.ts, src/persistence/postgres-sql-funding-store.ts, tests/dev/pre-admission-session.integration.test.ts]
key-decisions:
  - "Pending actions retain only encrypted command material and safe binding metadata; they never reuse accepted-session continuation rows."
  - "Envelope authentication and pin checks run before the admission/resume claim is committed."
  - "A provider operation already claimed by another coordinator is recovered only with gateway.lookup using its original deterministic intent."
patterns-established:
  - "Use account- and session-derived action IDs because metered action primary keys are global."
  - "Use prepared durable IDs when reconstructing worker and artifact lineage for replay."
requirements-completed: []
requirements-advanced: [DEV-GUI-04, DEV-GUI-05, DEV-GUI-06, DEV-GUI-08, DEV-GUI-12]
requirements-deferred: [SESS-02, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Encrypted low-balance command saves in PostgreSQL with no admission, provider, worker, or artifact effect.
    verification:
      - kind: integration
        ref: tests/dev/pre-admission-session.integration.test.ts#save restart fund resume original operation
        status: pass
    human_judgment: false
  - id: D2
    description: Explicit accepted admission resumes the exact original command once through the local Docker worker and durable artifact path.
    verification:
      - kind: integration
        ref: tests/dev/pre-admission-session.integration.test.ts#pre-admission resume drives the original command through the real worker once
        status: pass
    human_judgment: false
  - id: D3
    description: Tampered pins/ciphertext, an insufficient hold, replay, and provider-claim recovery fail safely or converge without a second provider POST.
    verification:
      - kind: integration
        ref: tests/dev/pre-admission-session.integration.test.ts
        status: pass
      - kind: unit
        ref: tests/phase-04/revision.test.ts#a fresh coordinator recovers a claimed operation by lookup without a second provider post
        status: pass
    human_judgment: false
metrics:
  duration: 16min
  completed: 2026-10-15
status: complete
---

# Phase 07 Plan 57: Pre-admission authority Summary

**Encrypted owner-scoped pending actions now survive restart and enter their original metered Docker-worker operation only after a separate accepted admission and explicit resume.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-10-15T17:21:46Z
- **Completed:** 2026-10-15T17:37:33Z
- **Tasks:** 2/2
- **Files modified:** 11

## Accomplishments

- Added migration 005 and a serializable PostgreSQL authority that stores only an encrypted pending-action envelope and safe replay metadata, with no foreign key to legacy session/continuation state.
- Added restart-stable local pending-action key storage and an AEAD envelope that binds owner, command fingerprint, zero session/artifact versions, expiry, and policy/toolchain pins before resume can bind an admission.
- Factored post-admission start handling through the existing metered/provider/worker path; provider-claim recovery reconstructs the original intent and calls `gateway.lookup` without a replacement POST.
- Registered the concurrent worker-results migration 006 in the development runner so a clean local startup applies it after the Plan 57 pending-action schema.

## Scope and deferred coverage

This plan proves the transport-neutral pre-admission foundation only. ContextVM/browser pending-action presentation and full GUI flow remain for Plans 54 and 55. The production/session operational requirements `SESS-02` and `OPS-02` through `OPS-04` remain deferred; the complete cross-process windows after worker completion, charge, and version changes are owned by the durable worker-output work in Plan 54.

## Task Commits

1. **Task 1: Save, restart, fund, and resume one original command through actual SQL** - `b0bc1d3` (feature)
2. **Task 2: Close tamper, replay, concurrency, and crash windows without changing legacy continuation** - `7e2b54e` (fix)
3. **Task 2 regression: Cover lookup-only provider recovery** - `a5abe1c` (test)
4. **Task 2 regression: Isolate the real-worker SQL trace** - `3c20c26` (test)

Related coordinated commits: `2a9c8d4` provides the local checkpoint key store; `854bebd` restores the legacy continuation affordability default while keeping the explicit development option.

## Files Created/Modified

- `migrations/development/005_pending_actions.sql` - independent pending-action schema.
- `scripts/dev-payments.ts` - checksum-registers migrations 005 and 006.
- `src/continuity/contracts.ts` and `src/continuity/checkpoint-envelope.ts` - bounded command and authenticated encrypted envelope contracts.
- `src/continuity/pre-admission-session-service.ts` - save, safe status, one-time explicit resume, and terminal replay.
- `src/dev/local-checkpoint-store.ts` - server-only restart-stable AEAD key material.
- `src/persistence/funding-store.ts` and `src/persistence/postgres-sql-funding-store.ts` - serializable pending-action persistence and admission binding.
- `src/phase-04/metered-generation-service.ts` - factored funded start, owner-scoped action IDs, and lookup-only provider recovery.
- `tests/dev/pre-admission-session.integration.test.ts` and `tests/phase-04/revision.test.ts` - actual SQL/Docker replay, rejection, and provider-claim recovery evidence. The Docker trace uses an isolated `developmentStack(true)` database and containers.

## Verification

- `bun scripts/dev-payments.ts up && bun test tests/dev/pre-admission-session.integration.test.ts tests/phase-04/revision.test.ts tests/phase-05/resume-session.test.ts tests/phase-05/checkpoint-envelope.test.ts --timeout 240000` — 14 passed, 93 assertions.
- `bun run tests/dev-ui/generation-preview.e2e.ts --case=deterministic-real-worker-compatible-host` — passed as a Plan 56 generation-preview regression against the local deterministic provider and real Docker worker; it does not exercise a pending-action browser flow.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reused metered action IDs could collide across owners**
- **Found during:** Task 2
- **Fix:** Derive global action IDs from account/session/idempotency identity while preserving the durable ID for existing operation recovery.
- **Files modified:** `src/phase-04/metered-generation-service.ts`, `tests/phase-04/revision.test.ts`
- **Verification:** Phase 04 revision suite and actual PostgreSQL handoff test.
- **Committed in:** `7e2b54e`, `a5abe1c`

**2. [Rule 2 - Security] A tampered or stale envelope could consume the one-time admission binding before validation**
- **Found during:** Task 2
- **Fix:** Authenticate/decrypt and compare every owner/version/pin/maximum field before claiming the durable resume binding; reject expired duplicate saves.
- **Files modified:** `src/continuity/pre-admission-session-service.ts`, `tests/dev/pre-admission-session.integration.test.ts`
- **Verification:** Pin/ciphertext tamper and insufficient-hold assertions retain `saved` state.
- **Committed in:** `7e2b54e`

**3. [Rule 1 - Bug] A claimed provider operation returned reconciliation without querying the original provider request**
- **Found during:** Task 2
- **Fix:** Reconstruct the exact original provider intent and recover only through `gateway.lookup`; never dispatch a replacement request.
- **Files modified:** `src/phase-04/metered-generation-service.ts`, `tests/phase-04/revision.test.ts`
- **Verification:** Lookup-only recovery test observes one dispatch and one worker run.
- **Committed in:** `7e2b54e`, `a5abe1c`

**Total deviations:** 3 auto-fixed (2 Rule 1, 1 Rule 2). All address replay, integrity, or global-key correctness required by the plan.

## Known Stubs

None.

## Next Phase Readiness

Plans 54 and 55 can inject `PreAdmissionSessionService` into the ContextVM/development server. They must preserve the pending-action public tuple and present only safe status fields; they must not expose envelope/key material or call the legacy continuation resume path.

## Self-Check: PASSED

- Required migration, service, envelope, store, key module, and integration tests exist.
- Task commits `b0bc1d3`, `7e2b54e`, `a5abe1c`, and `3c20c26` are present in git history.
