---
phase: 02
slug: trusted-core-isolated-agent-execution
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-04
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test 1.3.14 |
| **Config file** | `package.json`, `tsconfig.json` |
| **Quick run command** | `bun test` |
| **Full suite command** | `bun test && bun run test:phase-02-design-slice` |
| **Estimated runtime** | ~20 seconds offline; live provider probe separate |

---

## Sampling Rate

- **After every task commit:** Run `bun test` plus the affected focused test file.
- **After every plan wave:** Run `bun test`.
- **Before `$gsd-verify-work`:** Run `bun test && bun run test:phase-02-design-slice`.
- **Provider observation:** Run `bun run test:modal-probe` when credentials and an approved image are configured; otherwise persist an explicit `blocked` provider result and do not select Modal.
- **Max offline feedback latency:** 30 seconds.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | SAFE-01, SAFE-02 | T-02-01 | Invalid input cannot allocate/invoke; classifier cannot expand policy | unit/table | `bun test tests/admission/admission-policy.test.ts tests/admission/risk-policy.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | SESS-05 | T-02-02 | Replay is exact and stale/concurrent actions cannot double-advance | unit/integration | `bun test tests/domain/session-service.test.ts tests/persistence/session-store.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | SAFE-03 | T-02-03 | Unknown, stale, expired, cross-session, or escaping tool calls have zero side effects | unit/contract | `bun test tests/capabilities/scoped-tool-gateway.test.ts tests/worker-port/contracts.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 2 | SAFE-04 | T-02-04 | WorkerPort fake proves semantic confinement and portable checkpoint contract | unit/contract | `bun test tests/worker-port/fake-worker.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 3 | SAFE-04 | T-02-05 | Provider probe records isolation, egress, gateway, browser/build, and checkpoint observations without false selection | opt-in integration | `bun run test:modal-probe` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 3 | SESS-05, SAFE-01, SAFE-02, SAFE-03, SAFE-04 | T-02-01–05 | Design-slice evidence distinguishes deterministic pass, provider pass, provider block, and Phase 7 deferral | integration | `bun run test:phase-02-design-slice` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/admission/admission-policy.test.ts` and `tests/admission/risk-policy.test.ts` — SAFE-01/SAFE-02 validation and classifier-independence matrix.
- [ ] `tests/domain/session-service.test.ts` and `tests/persistence/session-store.test.ts` — SESS-05 replay/conflict/concurrency matrix.
- [ ] `tests/capabilities/scoped-tool-gateway.test.ts` and `tests/worker-port/contracts.test.ts` — SAFE-03 typed authority and denial matrix.
- [ ] `tests/worker-port/fake-worker.test.ts` and `tests/integration/modal-probe.test.ts` — SAFE-04 deterministic port plus opt-in provider evidence.
- [ ] `tests/verification/phase-02-design-slice.test.ts` and `test:phase-02-design-slice` — immutable phase evidence with truthful provider status.

---

## Manual-Only Verifications

None for the design-stage core. A live provider probe requires external credentials/configuration, but its result is machine-recorded; missing configuration yields `blocked`, not a manual pass or a false provider selection.

---

## Validation Sign-Off

- [ ] All tasks have automated verification or explicit Wave 0 dependencies.
- [ ] Sampling continuity: no three consecutive tasks without automated verification.
- [ ] Wave 0 covers all missing references.
- [ ] No watch-mode flags.
- [ ] Offline feedback latency < 30 seconds.
- [ ] `nyquist_compliant: true` set after post-execution audit.

**Approval:** pending execution
