---
phase: 05
slug: funding-interruption-durable-resume
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-05
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for the interruption, checkpoint, resume, and expiry state machine.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test, Bun 1.3.14 |
| **Config file** | none — `package.json` delegates to `bun test` |
| **Quick run command** | `bun test tests/phase-05 tests/persistence/continuation-store.test.ts tests/persistence/phase-05-sql-schema-parity.test.ts tests/persistence/postgres-sql-funding-store.test.ts tests/contextvm/adapter.test.ts --timeout 10000` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | targeted ≤ 15 seconds; full suite ≤ 90 seconds on the reference development host |

## Sampling Rate

- **After every task commit:** Run the task's targeted Phase 5 test plus the existing session-store, PostgreSQL-store, and fake-worker regression lane when those seams change.
- **After every plan wave:** Run `bun test` and the deterministic Phase 5 reference set.
- **Before formal verification:** The full suite and Phase 5 content-addressed design-evidence verifier must be green.
- **Max feedback latency:** Keep ordinary targeted commands below 15 seconds; fault-injection/reference matrices belong in the wave gate.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------------|-----------|-------------------|-------------|--------|
| 05-W0-01 | 05-01 | 1 | CONT-01 | Unaffordable action persists one pending intent and pauses before budget, provider, worker, or debit effects. | unit + transaction | `bun test tests/phase-05/pause-for-funding.test.ts --timeout 10000` | ✅ | ✅ green |
| 05-W0-02 | 05-01 | 1 | CONT-02 | Owner-safe `needs_top_up` status discloses exact funding/cap/deadline facts while redacting protected content. | contract + leakage | `bun test tests/phase-05/continuation-status.test.ts --timeout 10000` | ✅ | ✅ green |
| 05-W0-03 | 05-04 + closure | 2 | CONT-03 | Only a durable, verified Lightning or Cashu credit before the deadline re-authorizes and continues the stored live lease exactly once; replay and late credit have no wake effect. | race + rail integration + SQL deadline | `bun test tests/phase-05/grace-wake.test.ts tests/phase-05/verified-credit-rail-wake.test.ts tests/persistence/postgres-sql-funding-store.test.ts --timeout 10000` | ✅ | ✅ green |
| 05-W0-04 | 05-04 | 2 | CONT-04 | Deadline checkpoint ordering survives crash points and revokes the worker before any later effect. | fault injection | `bun test tests/phase-05/deadline-checkpoint.test.ts --timeout 10000` | ✅ | ✅ green |
| 05-W0-05 | 05-03 | 2 | CONT-05 | Authenticated immutable checkpoint binds required lineage and rejects tamper/forbidden archive fields. | unit + security | `bun test tests/phase-05/checkpoint-envelope.test.ts --timeout 10000` | ✅ | ✅ green |
| 05-W0-06 | 05-05 | 3 | CONT-06 | Post-grace credit cannot restart work; signed owner resume replays and rejects foreign/stale/conflicting input before effects. | ContextVM + integration | `bun test tests/phase-05/resume-session.test.ts tests/contextvm/adapter.test.ts --timeout 10000` | ✅ | ✅ green |
| 05-W0-07 | 05-06 | 3 | CONT-07 | One pre-expiry claim wins, prior operations never redispatch, and terminal expiry cannot be revived. | time/race + integration | `bun test tests/phase-05/retention-expiry.test.ts tests/persistence/continuation-store.test.ts --timeout 10000` | ✅ | ✅ green |
| 05-W0-08 | 05-07 | 4 | CONT-01–CONT-07 | Deterministic reference evidence proves all continuation authorities without selecting Modal, GCS, or KMS. | reference evidence | `bun run eval:phase05 && bun run verify:phase05-design` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Wave 0 Requirements

- [x] `tests/phase-05/pause-for-funding.test.ts` and `continuation-status.test.ts` — CONT-01/02.
- [x] `tests/phase-05/grace-wake.test.ts`, `verified-credit-rail-wake.test.ts`, and `tests/persistence/postgres-sql-funding-store.test.ts` — CONT-03 same-live-worker authorization, real Lightning/Cashu settlement wake, owner/deadline SQL discovery, and bounded database waits.
- [x] `tests/phase-05/deadline-checkpoint.test.ts` and `checkpoint-envelope.test.ts` — CONT-04/05 persistence, encryption, tamper, and crash ordering.
- [x] `tests/phase-05/resume-session.test.ts` and ContextVM adapter coverage — CONT-06 explicit signed resume.
- [x] `tests/phase-05/retention-expiry.test.ts` — CONT-07 claim/expiry/deletion behavior.
- [x] `tests/persistence/continuation-store.test.ts` plus PostgreSQL parity coverage — atomic pause/checkpoint/claim/tombstone authority.
- [x] `tests/evals/phase-05-reference-set.test.ts` and redacted fixtures — deterministic complete acceptance gate.
- [x] `scripts/verify-phase-05-design-slice.ts` and `src/verification/phase-05-design-evidence.ts` — immutable provider-separated evidence.
- [x] `package.json` scripts `eval:phase05` and `verify:phase05-design` — stable CI entry points without live providers.

## Required Adversarial and Reference Cases

- Affordability: zero/partial balance, cap-only shortfall, both shortfalls, duplicate pause, conflicting idempotency key, and repeated interruption.
- Grace: credit immediately before/at/after deadline, duplicate/reordered Lightning and Cashu settlement wake, reconnect, stale lease, and unresolved cap shortfall.
- Checkpoint: invalid proposal, lineage/version/workspace/digest mismatch, AAD/ciphertext tamper, immutable-put replay/conflict, object success plus SQL rollback, and SQL commit plus termination loss.
- Resume: foreign owner, wrong checkpoint/session version, altered pending fingerprint, incompatible toolchain, exact replay, simultaneous claims, allocation failure, and no redispatch of prior operations.
- Expiry: claim at deadline minus 1 ms, at deadline, after deadline, duplicate reaper, deletion retry, safe expired status, and no resurrection after credit.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live Modal checkpoint/restore and GCS/KMS immutable storage | CONT-04, CONT-05, CONT-07 | Provider selection, credentials, latency, and operational certification are explicitly Phase 7 scope. | In Phase 7, run the promoted worker/storage adapters through checkpoint, crash/reclaim, restore, exact-generation delete, and multi-region failure fixtures before selection. |

## Validation Sign-Off

- [x] All tasks have automated verification or Wave 0 dependencies.
- [x] Sampling continuity has no three consecutive tasks without automated verification.
- [x] Every CONT-01–CONT-07 behavior and required race is covered.
- [x] No watch-mode flags are used.
- [x] Targeted feedback latency remains below 15 seconds.
- [x] Evidence keeps Modal/GCS/KMS unselected and does not claim launch readiness.
- [x] `nyquist_compliant: true` is set only after the implementation audit.

**Approval:** validated by Nyquist audit on 2026-08-05

## Validation Audit 2026-08-05

| Metric | Count |
|--------|-------|
| Gaps found | 8 stale validation-map entries |
| Resolved | 8 |
| Escalated | 0 |

### Executed Evidence

- `bun test tests/phase-05/pause-for-funding.test.ts tests/phase-05/continuation-status.test.ts tests/phase-05/grace-wake.test.ts tests/phase-05/deadline-checkpoint.test.ts tests/phase-05/checkpoint-envelope.test.ts tests/phase-05/resume-session.test.ts tests/phase-05/retention-expiry.test.ts tests/persistence/continuation-store.test.ts tests/persistence/phase-05-sql-schema-parity.test.ts tests/contextvm/adapter.test.ts --timeout 10000` — 45 pass, 0 fail.
- `bun run eval:phase05` — 3 pass, 0 fail.
- `bun run verify:phase05-design` — 50 pass, 0 fail; it independently re-ran the deterministic authority/reference suites.

The deterministic evidence remains deliberately provider-separated. Live Modal, GCS/object storage, KMS, production PostgreSQL, latency, failover, and multi-region certification are Phase 7 manual-only work and are not evidence of launch readiness here.

## CONT-03 Closure Re-audit 2026-08-05

| Metric | Count |
|--------|-------|
| New coverage gaps found | 2 |
| Resolved | 2 |
| Escalated | 0 |

### Executed Evidence

- `bun test tests/phase-05/pause-for-funding.test.ts tests/phase-05/continuation-status.test.ts tests/phase-05/grace-wake.test.ts tests/phase-05/verified-credit-rail-wake.test.ts tests/phase-05/deadline-checkpoint.test.ts tests/phase-05/checkpoint-envelope.test.ts tests/phase-05/resume-session.test.ts tests/phase-05/retention-expiry.test.ts tests/persistence/continuation-store.test.ts tests/persistence/phase-05-sql-schema-parity.test.ts tests/persistence/postgres-sql-funding-store.test.ts tests/contextvm/adapter.test.ts --timeout 10000` — 56 pass, 0 fail.
- `bun run eval:phase05` — 3 pass, 0 fail.
- `bun run verify:phase05-design` — 50 pass, 0 fail.

The CONT-03 map now includes rail-to-wake integration coverage and PostgreSQL deadline/timeout coverage. These deterministic adapters do not select or certify live providers; the existing Phase 7 deferrals remain in force.
