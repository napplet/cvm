---
phase: 05
slug: funding-interruption-durable-resume
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-05
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for the interruption, checkpoint, resume, and expiry state machine.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test, Bun 1.3.14 |
| **Config file** | none — `package.json` delegates to `bun test` |
| **Quick run command** | `bun test tests/phase-05 tests/persistence/continuation-store.test.ts tests/contextvm/adapter.test.ts --timeout 10000` |
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
| 05-W0-01 | TBD | 0 | CONT-01 | Unaffordable action persists one pending intent and pauses before budget, provider, worker, or debit effects. | unit + transaction | `bun test tests/phase-05/pause-for-funding.test.ts` | ❌ W0 | ⬜ pending |
| 05-W0-02 | TBD | 0 | CONT-02 | Owner-safe `needs_top_up` status discloses exact funding/cap/deadline facts while redacting protected content. | contract + leakage | `bun test tests/phase-05/continuation-status.test.ts` | ❌ W0 | ⬜ pending |
| 05-W0-03 | TBD | 0 | CONT-03 | Verified credit before the deadline resumes only one unchanged lease after fresh authorization. | race + integration | `bun test tests/phase-05/grace-wake.test.ts` | ❌ W0 | ⬜ pending |
| 05-W0-04 | TBD | 0 | CONT-04 | Deadline checkpoint ordering survives crash points and revokes the worker before any later effect. | fault injection | `bun test tests/phase-05/deadline-checkpoint.test.ts` | ❌ W0 | ⬜ pending |
| 05-W0-05 | TBD | 0 | CONT-05 | Authenticated immutable checkpoint binds required lineage and rejects tamper/forbidden archive fields. | unit + security | `bun test tests/phase-05/checkpoint-envelope.test.ts` | ❌ W0 | ⬜ pending |
| 05-W0-06 | TBD | 0 | CONT-06 | Post-grace credit cannot restart work; signed owner resume replays and rejects foreign/stale/conflicting input before effects. | ContextVM + integration | `bun test tests/phase-05/resume-session.test.ts tests/contextvm/adapter.test.ts` | ❌ W0 | ⬜ pending |
| 05-W0-07 | TBD | 0 | CONT-07 | One pre-expiry claim wins, prior operations never redispatch, and terminal expiry cannot be revived. | time/race + integration | `bun test tests/phase-05/retention-expiry.test.ts` | ❌ W0 | ⬜ pending |
| 05-W0-08 | TBD | 0 | CONT-01–CONT-07 | Deterministic reference evidence proves all continuation authorities without selecting Modal, GCS, or KMS. | reference evidence | `bun run eval:phase05 && bun run verify:phase05-design` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Wave 0 Requirements

- [ ] `tests/phase-05/pause-for-funding.test.ts` and `continuation-status.test.ts` — CONT-01/02.
- [ ] `tests/phase-05/grace-wake.test.ts` — CONT-03 same-live-worker authorization and races.
- [ ] `tests/phase-05/deadline-checkpoint.test.ts` and `checkpoint-envelope.test.ts` — CONT-04/05 persistence, encryption, tamper, and crash ordering.
- [ ] `tests/phase-05/resume-session.test.ts` and ContextVM adapter coverage — CONT-06 explicit signed resume.
- [ ] `tests/phase-05/retention-expiry.test.ts` — CONT-07 claim/expiry/deletion behavior.
- [ ] `tests/persistence/continuation-store.test.ts` plus PostgreSQL parity coverage — atomic pause/checkpoint/claim/tombstone authority.
- [ ] `tests/evals/phase-05-reference-set.test.ts` and redacted fixtures — deterministic complete acceptance gate.
- [ ] `scripts/verify-phase-05-design-slice.ts` and `src/verification/phase-05-design-evidence.ts` — immutable provider-separated evidence.
- [ ] `package.json` scripts `eval:phase05` and `verify:phase05-design` — stable CI entry points without live providers.

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

- [ ] All tasks have automated verification or Wave 0 dependencies.
- [ ] Sampling continuity has no three consecutive tasks without automated verification.
- [ ] Every CONT-01–CONT-07 behavior and required race is covered.
- [ ] No watch-mode flags are used.
- [ ] Targeted feedback latency remains below 15 seconds.
- [ ] Evidence keeps Modal/GCS/KMS unselected and does not claim launch readiness.
- [ ] `nyquist_compliant: true` is set only after the implementation audit.

**Approval:** pending
