---
phase: 02
slug: trusted-core-isolated-agent-execution
status: validated
nyquist_compliant: true
wave_0_complete: true
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
| 02-01-01 | 01 | 1 | SESS-05, SAFE-01, SAFE-02, SAFE-03, SAFE-04 | T-02-01–03 | Tracer/policy fixture proves one admitted, mediated, atomically recorded action; exact replay/denials have zero repeated/forbidden effects and every numeric limit has one immutable identity | end-to-end tracer | `bun test tests/phase-02/tracer.test.ts` | ✅ | ✅ green |
| 02-02-01 | 02 | 2 | SAFE-01 | T-02-04, T-02-06 | Canonical Unicode/byte/code-point/grapheme/token/structure boundaries reject before allocation and retain redacted evidence | unit/table | `bun test tests/admission/admission-policy.test.ts` | ✅ | ✅ green |
| 02-02-02 | 02 | 2 | SAFE-02 | T-02-05–06 | Classifier faults deny and every signal result can only preserve/reduce the fixed base grant | unit/table | `bun test tests/admission/risk-policy.test.ts` | ✅ | ✅ green |
| 02-03-01 | 03 | 2 | SESS-05 | T-02-07–10 | Memory double satisfies the port contract; file-backed SQLite atomically persists session/version, fingerprint/result, and evidence identity through rollback, concurrency, and close/reopen | persistence integration | `bun test tests/persistence/session-store.test.ts tests/persistence/sqlite-session-store.test.ts` | ✅ | ✅ green |
| 02-03-02 | 03 | 2 | SESS-05 | T-02-07–10 | SessionService exposes exact replay/conflict/stale/interruption semantics over the durable store without automatic mutation retry | domain + persistence | `bun test tests/domain/session-service.test.ts tests/persistence/session-store.test.ts tests/persistence/sqlite-session-store.test.ts` | ✅ | ✅ green |
| 02-04-01 | 04 | 2 | SAFE-03 | T-02-11–12 | Unknown, conflicting, stale, expired, cross-session, authority-bearing, or escaping tool calls are denied before dispatcher effects | unit/contract | `bun test tests/capabilities/scoped-tool-gateway.test.ts tests/worker-port/contracts.test.ts` | ✅ | ✅ green |
| 02-04-02 | 04 | 2 | SAFE-04 | T-02-12–14 | Deterministic fake proves workspace/credential/network confinement, terminal-event fencing, gateway-only authority, 16-turn cap, and portable checkpoint binding | unit/contract | `bun test tests/worker-port/fake-worker.test.ts` | ✅ | ✅ green |
| 02-05-01 | 05 | 3 | SAFE-04 | T-02-15–18, T-02-05-SC | Modal adapter maps only the strict project config/policy into default-deny SDK calls and terminates on success/failure/abort/overflow | adapter contract | `bun test tests/integration/modal-probe.test.ts --test-name-pattern='adapter contract'` | ✅ | ✅ green |
| 02-05-02 | 05 | 3 | SAFE-04 | T-02-15–18 | Provider probe records passed/failed/blocked isolation, egress, gateway, browser/build, checkpoint, and termination evidence without false selection | opt-in integration | `env -u MODAL_TOKEN_ID -u MODAL_TOKEN_SECRET -u NAPPLET_CVM_MODAL_PROBE_CONFIG bun run test:modal-probe && bun test tests/integration/modal-probe.test.ts` | ✅ | ✅ green (offline blocked/unselected) |
| 02-06-01 | 06 | 4 | SESS-05, SAFE-01, SAFE-02, SAFE-03, SAFE-04 | T-02-19 | Final SQLite-backed composition preserves boundary order, Phase 1 output gating, durable replay, and zero later effects after any denial | end-to-end composition | `bun test tests/phase-02/tracer.test.ts` | ✅ | ✅ green |
| 02-06-02 | 06 | 4 | SESS-05, SAFE-01, SAFE-02, SAFE-03, SAFE-04 | T-02-21–22 | Exactly 16 deterministic fixtures enforce result/state/effect/evidence oracles with zero tolerance and no LLM security judgment | deterministic eval | `bun run eval:phase-02` | ✅ | ✅ green |
| 02-06-03 | 06 | 4 | SESS-05, SAFE-01, SAFE-02, SAFE-03, SAFE-04 | T-02-20–22 | Immutable design evidence binds SQLite/policy/check identities and preserves provider blocked/failed/passed status separately from offline readiness | integration/evidence | `bun run test:phase-02-design-slice` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] **Plan 01 — tracer/policy:** `tests/phase-02/tracer.test.ts` owns the end-to-end tracer, exact policy-fixture identity/immutability, replay, stale/conflict, and representative zero-effect denials.
- [x] **Plan 02 — admission/risk:** `tests/admission/admission-policy.test.ts` and `tests/admission/risk-policy.test.ts` own SAFE-01 numeric/Unicode/structure boundaries and SAFE-02 restrictive-only/fault semantics.
- [x] **Plan 03 — memory + durable SQLite/session service:** `tests/persistence/session-store.test.ts`, `tests/persistence/sqlite-session-store.test.ts`, and `tests/domain/session-service.test.ts` own the port double, atomic file-backed persistence, close/reopen, rollback, replay, conflict, stale, interruption, and controlled concurrency.
- [x] **Plan 04 — capability/fake/checkpoint:** `tests/capabilities/scoped-tool-gateway.test.ts`, `tests/worker-port/contracts.test.ts`, and `tests/worker-port/fake-worker.test.ts` own grants, complete mediation, strict WorkerPort schemas, deterministic isolation, action limits, and checkpoint binding.
- [x] **Plan 05 — Modal adapter/provider evidence:** `tests/integration/modal-probe.test.ts` plus `test:modal-probe` own safe SDK mapping and canonical passed/failed/blocked provider observation; the no-config command emits blocked/unselected evidence autonomously without selecting or certifying Modal.
- [x] **Plan 06 — final composition/reference/design evidence:** the updated `tests/phase-02/tracer.test.ts`, `tests/evals/phase-02-reference-set.test.ts` through `eval:phase-02`, and `tests/verification/phase-02-design-slice.test.ts` through `test:phase-02-design-slice` own final SQLite-backed composition, the 16-case reference set, and immutable provider-separated evidence.

---

## Manual-Only Verifications

None for the design-stage core. A live provider probe requires external credentials/configuration, but its result is machine-recorded; missing configuration yields `blocked`, not a manual pass or a false provider selection.

---

## Validation Sign-Off

- [x] All tasks have automated verification or explicit Wave 0 dependencies.
- [x] Sampling continuity: no three consecutive tasks without automated verification.
- [x] Wave 0 covers all missing references.
- [x] No watch-mode flags.
- [x] Offline feedback latency < 30 seconds.
- [x] `nyquist_compliant: true` set after post-execution audit.

**Approval:** Nyquist-compliant — post-execution audit completed 2026-08-04.

## Validation Audit 2026-08-04

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

All 12 planned task behaviors map to green, executable Bun coverage. The full suite passed with 189 tests and 800 assertions; `bun run eval:phase-02` passed all 33 assertions across the exactly-16 deterministic cases; `bun run test:phase-02-design-slice` produced `design-ready` evidence while preserving Modal as `blocked` / `unselected` and Phase 7 production certification, hostile-depth, SLO/load, chaos, supply-chain, and launch-hardening deferrals.
