---
phase: 05-funding-interruption-durable-resume
reviewed: 2026-08-05T02:16:54Z
depth: standard
files_reviewed: 39
files_reviewed_list:
  - evidence/design/phase-05.json
  - evidence/design/4043df1d9f60ee0e84893d2c66a7bcfe235ffb5fd8a66656080471ee267009ae.json
  - migrations/phase-05/001_continuation.sql
  - package.json
  - scripts/verify-phase-05-design-slice.ts
  - src/contextvm/adapter.ts
  - src/contextvm/announcement.ts
  - src/continuity/checkpoint-envelope.ts
  - src/continuity/continuation-service.ts
  - src/continuity/contracts.ts
  - src/continuity/deadline-reconciler.ts
  - src/continuity/object-store.ts
  - src/persistence/funding-store.ts
  - src/persistence/postgres-funding-database.ts
  - src/persistence/postgres-funding-store.ts
  - src/persistence/postgres-sql-funding-store.ts
  - src/phase-02/contracts.ts
  - src/phase-03/funded-core.ts
  - src/phase-04/metered-generation-service.ts
  - src/phase-04/session-status.ts
  - src/verification/phase-05-design-evidence.ts
  - src/worker-adapters/modal-worker.ts
  - src/worker-port/fake-worker.ts
  - tests/contextvm/adapter.test.ts
  - tests/evals/phase-05-reference-set.test.ts
  - tests/fixtures/contextvm-phase-03.json
  - tests/fixtures/phase-05-reference-set.json
  - tests/persistence/continuation-store.test.ts
  - tests/persistence/phase-05-sql-schema-parity.test.ts
  - tests/persistence/postgres-sql-funding-store.test.ts
  - tests/phase-05/checkpoint-envelope.test.ts
  - tests/phase-05/continuation-status.test.ts
  - tests/phase-05/deadline-checkpoint.test.ts
  - tests/phase-05/grace-wake.test.ts
  - tests/phase-05/pause-for-funding.test.ts
  - tests/phase-05/resume-session.test.ts
  - tests/phase-05/retention-expiry.test.ts
  - tests/verification/phase-05-design-slice.test.ts
  - tests/worker-port/fake-worker.test.ts
findings:
  critical: 5
  warning: 1
  info: 0
  total: 6
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-08-05T02:16:54Z
**Depth:** standard
**Files Reviewed:** 39
**Status:** issues_found

## Summary

The Phase 05 tests and `bun run verify:phase05-design` pass, but the tested paths use manually split in-memory records and shallow SQL-string assertions. The actual unaffordable-action path does not create the live continuation state required by grace, checkpoint, or resume; the PostgreSQL implementation loses required intent data; and the evidence gate does not derive case observations from the authority it certifies.

The requested evidence anomaly is **not a current deterministic-pointer bug**. `ccf7a330…` is invalid because it lacks `caseComparisons`; it was timestamped before the valid `4043df…` record. The current verifier rejects it, and rerunning the gate validated `4043df…` and left the tracked pointer unchanged.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: The real unaffordable-action path never creates a durable live pause

**File:** `src/continuity/continuation-service.ts:65-88`, `src/persistence/postgres-sql-funding-store.ts:186-191`, `src/phase-04/metered-generation-service.ts:163-167`

**Issue:** `MeteredGenerationService` calls `ContinuationService.pauseForFunding`, which persists the legacy `ContinuationRecord` form only. The PostgreSQL implementation explicitly returns that form without inserting any row, while the memory implementation puts it in a separate `continuations` map. Neither creates the `ContinuationPause` required by `wakePausedAction`, deadline scanning, checkpointing, or claiming a resume. Thus production duplicate calls do not replay a persisted pause/deadline, and a genuine `needs_top_up` result cannot enter the ten-minute or durable-resume lifecycle. The tests mask this by manually creating a second, richer pause record after calling the service.

**Fix:** Replace the split overloads with one atomic pause transition. At the affordability boundary, persist the complete pending intent, fixed grace deadline, pause generation, and server-issued live lease (or an explicit no-live-worker state) in the same record/transaction that stores the replay result. Make all wake/checkpoint/status/resume reads use that record, and add an integration test beginning with `MeteredGenerationService.startSession` against the SQL store.

### CR-02: PostgreSQL drops the full pending intent required to wake, checkpoint, and resume

**File:** `migrations/phase-05/001_continuation.sql:5-23`, `src/persistence/postgres-sql-funding-store.ts:78-90`, `src/continuity/continuation-service.ts:110-132`, `src/continuity/continuation-service.ts:241-246`

**Issue:** `continuation_pauses` has no storage for `actionKind`, `actionMaximum`, policy/profile/price-card/toolchain pins, payload hash, reference, or artifact version. Both SQL read methods construct only five fields and cast the incomplete object to `ContinuationRecord`. Consequently wake reaches `BigInt(continuation.intent.actionMaximum)` with `undefined`, and resume compatibility always compares missing fields to real pins and is denied. Deadline checkpoint sealing also receives missing compatibility/action fields. This makes the PostgreSQL continuation path nonfunctional even when a rich pause row is manually inserted.

**Fix:** Persist a strict, canonical `PendingActionIntent` (for example an `intent_json` column validated on write/read) or add all required immutable columns. Hydrate it with `PendingActionIntentSchema.parse` rather than `as unknown as`, and add real PostgreSQL integration coverage for wake, deadline checkpoint, and resume.

### CR-03: The SQL deletion audit cannot record its own retry/final states

**File:** `migrations/phase-05/001_continuation.sql:80-99`, `src/persistence/postgres-sql-funding-store.ts:260`, `src/continuity/deadline-reconciler.ts:103-112`

**Issue:** The TypeScript lifecycle writes `scheduled`, then `deleted` or `unknown`. The migration permits only `scheduled`, `deleted`, and `failed`—not `unknown`. It also installs an append-only trigger that rejects every update, while `recordDeletionOutcome` uses `ON CONFLICT ... DO UPDATE` to transition an existing `scheduled` row. On production PostgreSQL, the first failure either violates the check constraint (`unknown`) or every final update fails due to the trigger. The retention reconciler then cannot persist its terminal/retry audit and may reject rather than return a reconciliation result.

**Fix:** Model append-only deletion observations as separate rows (include an attempt/sequence key) and derive the latest coarse state, or remove the append-only trigger and constrain a deliberate state transition graph. Align the DB enum with the TypeScript contract, including `unknown` if it remains a valid recoverable state. Test the actual migration on PostgreSQL, not text presence.

### CR-04: Deadline checkpointing does not fence worker effects before external checkpoint I/O

**File:** `src/continuity/deadline-reconciler.ts:122-147`, `src/phase-02/contracts.ts:198-203`

**Issue:** At grace expiry, the reconciler changes a database state to `checkpointing` and immediately asks the worker to export. The worker contract has no pause/fence/abort operation and no requirement that its commands revalidate the coordinator lease. A live worker can therefore continue model/tool/build/network work while the archive is captured and until termination occurs after the SQL commit. This violates the required deadline fence and permits effects after the durable safe boundary.

**Fix:** Add a coordinator-owned fence operation that the worker acknowledges before export, or route every worker action through a lease validator backed by the same durable transaction. Do not begin export until that fence succeeds; make a failed fence retryable without allowing worker effects. Add a race test with a worker attempting an effect concurrently with the deadline claim.

### CR-05: The design-evidence gate compares fixture labels, not authority observations

**File:** `src/verification/phase-05-design-evidence.ts:31-49`, `src/verification/phase-05-design-evidence.ts:57-65`, `scripts/verify-phase-05-design-slice.ts:15-16`

**Issue:** Every reported observation is selected by schedule-string matching in `observePhase05Facts`; it does not invoke the continuation authority or inspect its resulting durable/effect state. The child-suite command runs an entire test file and ignores each case's `execution.testName`, bounded input, and initial state. Therefore a case can keep passing after the implementation no longer satisfies its fixture scenario, provided the generic child test file still passes. The evidence record is content-addressed but not evidence of the per-case behavior it claims, so it can produce a false `design-ready` verdict.

**Fix:** Give each fixture case a real probe that constructs only its bounded input/initial state, invokes the named public authority, and returns independently captured durable/effect/status facts. Run the exact named test or probe per case, fail on an unknown/missing test name, and retain the fixture expected values solely as the comparator.

## Warnings

### WR-01: The exposed Modal continuation adapter is permanently nonfunctional

**File:** `src/worker-adapters/modal-worker.ts:380-393`

**Issue:** `ModalWorkerAdapter` advertises `ContinuationWorkerPort` but unconditionally returns `WORKER_CONTINUATION_DENIED` for checkpoint export, restore, and termination. Any deployment that composes this adapter with the Phase 05 coordinator will always fail to checkpoint or resume; the deterministic fake is the only worker that implements the protocol.

**Fix:** Either do not expose this adapter as `ContinuationWorkerPort` until lifecycle support exists, or implement the same lease-bound export/restore/terminate protocol using the sandbox's persisted workspace/session state. Add adapter-level continuation tests that exercise a real lifecycle port double.

---

_Reviewed: 2026-08-05T02:16:54Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
