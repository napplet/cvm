---
phase: 05-funding-interruption-durable-resume
reviewed: 2026-08-05T03:37:56Z
depth: standard
files_reviewed: 41
files_reviewed_list:
  - evidence/design/phase-05.json
  - evidence/design/ed2db45d9d7ab949d4d8388cefe56bea35b88f02a52dd914cf4f6e247a56bcdf.json
  - migrations/phase-04/001_metered_generation.sql
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
  critical: 0
  warning: 2
  info: 0
  total: 2
status: clean
---

# Phase 05: Code Review Report

**Reviewed:** 2026-08-05T03:37:56Z
**Depth:** standard
**Files Reviewed:** 41
**Status:** clean

## Summary

Final closure audit of `338fb55` found no remaining runtime blocker in the prior wake-accounting or resumed-action fencing paths. The third exact `unknown` observation now atomically changes the dispatch to a terminal state, releases its still-authorized wake budget once, and records release audit/outbox material. Late exact completion transitions only to `late_evidence_requires_operator`; it neither redispatches nor posts a debit.

The resume command persists private lease, action, operation, and budget identities, prepares and claims the bound metered action before restore, and requires its exact durable finalization before retiring the restored pause. ContextVM responses no longer disclose the private allocation/budget/lease fields. Wrong lease/operation, missing finalization, and conflicting completed finalizations fail closed. The focused suite passes 51 tests, and `git diff --check 338fb55^..338fb55` is clean.

The following two warnings are explicitly non-blocking design/provider deferrals; no runtime critical finding remains in this closure scope.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Phase 05 design evidence still derives observations from static labels

**Classification:** WARNING — verification-evidence debt; non-blocking runtime design issue.

**File:** `/Users/sandwich/Develop/napplet-cvm/src/verification/phase-05-design-evidence.ts:35-43`, `/Users/sandwich/Develop/napplet-cvm/tests/evals/phase-05-reference-set.test.ts:24-65`

**Issue:** The evidence comparison is supplied by a static case-ID map and schedule-label mapper. Named tests run, but their durable/effect/status outputs do not feed the recorded observation.

**Fix:** Have each case invoke a bounded authority probe and persist its captured durable state, effect count, and safe status projection for comparison.

### WR-02: Modal continuation remains an explicit Phase 7 provider deferral

**Classification:** WARNING — documented provider/design deferral; non-blocking for this design-profile closure audit.

**File:** `/Users/sandwich/Develop/napplet-cvm/src/worker-adapters/modal-worker.ts:384-401`, `/Users/sandwich/Develop/napplet-cvm/src/verification/phase-05-design-evidence.ts:64-67`

**Issue:** Modal continuation methods safely return `WORKER_CONTINUATION_DENIED`; the provider is intentionally unselected in this phase.

**Fix:** Keep this adapter out of production continuation composition until Phase 7 implements and certifies the lease-bound worker, storage, key-management, and recovery lifecycle.

---

_Reviewed: 2026-08-05T03:37:56Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
