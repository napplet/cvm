---
phase: 7
slug: admission-slo-resilience-launch-safety
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-05
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for immediate-or-rejected admission, resilience, live certification, and fail-closed promotion.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test 1.3.14 |
| **Config file** | `package.json`; no separate test config |
| **Quick run command** | `bun test tests/phase-07 tests/evals/phase-07-reference-set.test.ts --timeout 10000` |
| **Full suite command** | `bun test --timeout 10000` |
| **Deterministic evidence command** | `bun run eval:phase07 && bun run verify:phase07-evidence` |
| **Protected live command** | `bun run certify:phase07 -- --profile=release` |
| **Estimated runtime** | quick <30 seconds; full suite <60 seconds; live certification topology-dependent |

---

## Sampling Rate

- **After every task commit:** Run the focused Phase 7 test named by the task, then `bun test --timeout 10000` for changes crossing admission, persistence, worker, promotion, or publication boundaries.
- **After every plan wave:** Run `bun run eval:phase07 && bun run verify:phase07-evidence`.
- **Before `$gsd-verify-work`:** Full suite and deterministic evidence verification must be green.
- **Release candidate:** Retain 100% of certification traces/reports; the selected SLO cohort needs at least 1,000 accepted observations and at least 200 forced pool-hit plus 200 forced pool-miss/cold-contention observations.
- **Max fast feedback latency:** 30 seconds.
- A required live result of `blocked`, `not_observed`, `failed`, `skipped`, or stale blocks promotion; fixture evidence cannot substitute for it.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-W0-01 | TBD | 0 | SESS-02 | T-07-ADM | Receipt-to-exact-ready p95 is at most 5s or stable refusal has no session, hold, or queue | unit + protected load | `bun test tests/phase-07/admission-slo.test.ts`; `bun run certify:phase07 -- --suite=admission` | ❌ W0 | ⬜ pending |
| 07-W0-02 | TBD | 0 | OPS-01 | T-07-TEL | Versioned allowlisted telemetry exports no prompt, source, key, payment, provider, or free-text secrets | unit/property + Collector | `bun test tests/phase-07/telemetry-policy.test.ts`; `bun run eval:phase07 -- --suite=telemetry` | ❌ W0 | ⬜ pending |
| 07-W0-03 | TBD | 0 | OPS-02 | T-07-REC | Every fault recovers only the original operation with exact credit/debit/worker/publication counts | deterministic + protected chaos | `bun test tests/evals/phase-07-reference-set.test.ts`; `bun run certify:phase07 -- --suite=chaos` | ❌ W0 | ⬜ pending |
| 07-W0-04 | TBD | 0 | OPS-03 | T-07-RST | Restore decrypts and verifies exact object identity, checksum, owner/version/lease fence, retention, and reattachment | deterministic + protected restore | `bun test tests/phase-07/restore-drill.test.ts`; `bun run certify:phase07 -- --suite=restore` | ❌ W0 | ⬜ pending |
| 07-W0-05 | TBD | 0 | OPS-04 | T-07-PRO | Candidate gate blocks every missing, stale, mutated, skipped, or unobserved required input | unit + protected release | `bun test tests/phase-07/promotion-gate.test.ts`; `bun run candidate:verify` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Tiered Evidence Contract

| Tier | Runs | Required proof | Canonical evidence |
|------|------|----------------|--------------------|
| Fast | Unit/property/fake-provider schedules | Full admission clock, no-queue refusal replay, telemetry redaction/cardinality, original-operation effect counts, missing/stale evidence rejection | `evidence/design/phase-07.json` plus test output |
| Medium | 64-case deterministic corpus, toolchain/conformance, local Collector, reproducibility/mutations | Fault/adversarial matrices, OTel schema, pinned image/lock/SBOM/provenance/golden/waiver behavior | `evidence/certification/<candidate>/deterministic/*.json` |
| Live | Real Modal and Fly benchmarks plus selected Cloud Run/GCS/SQL/ContextVM/payment/model/host/signer/CLI/relay drills | Candidate-bound p50/p95/p99, zero backlog, restore/expiry, real compatible-host flow, exact provider/effect reconciliation | `evidence/certification/<candidate>/live/*.json` |

## Required Matrices

| Matrix | Minimum coverage | Oracle |
|--------|------------------|--------|
| Admission load | Modal + Fly; pool hit/miss, cold, step load, contention, reclaim, ambiguity | Signed receipt timestamp to exact-session readiness timestamp; one lease per acceptance; refusals create zero hold/session/backlog. |
| Fault/recovery | Every D-122 class at every durable action/checkpoint/publication boundary | Original command/intent/lease only; all financial, worker, artifact, and publication counters equal the expected value exactly. |
| Restore/retention | Interruption, corruption, wrong generation/checksum/owner/version/lease, expiry/delete, instance loss | Read/decrypt/verify/reattach succeeds only for the exact retained object and fails every mutation/expired case. |
| Telemetry privacy | Secret canaries, unknown attributes, raw identifiers, and cardinality bombs | No forbidden value reaches an exporter; only finite redacted violation facts remain. |
| Security/host | Prompt/tool injection, traversal/symlink/cross-session, egress, dependency/postinstall, direct authority, iframe spoof, responsive/accessibility states | Zero forbidden effect; exact sealed artifact, signer boundary, presentation contract, and publication identity remain intact. |
| Supply chain | Mutated lock/image/package/source/migration/config/policy/SBOM/provenance/golden/waiver | Candidate gate blocks every missing, stale, invalid, mutated, or non-waivable input. |

---

## Wave 0 Requirements

- [ ] `src/telemetry/contracts.ts`, `src/telemetry/redaction.ts`, `src/telemetry/otel.ts` — versioned lifecycle vocabulary, redaction, and test exporter.
- [ ] `src/certification/contracts.ts`, `src/certification/evidence.ts` — strict content-addressed observation/freshness contracts.
- [ ] `src/resilience/fault-harness.ts`, `src/admission/benchmark.ts` — provider-neutral fault schedules, monotonic timing, and confidence reports.
- [ ] `src/worker-adapters/fly-worker.ts` — candidate-only Fly adapter after its API/credential checkpoint.
- [ ] `tests/phase-07/*.test.ts`, `tests/evals/phase-07-reference-set.test.ts`, `tests/fixtures/phase-07-reference-set.json` — executable requirement and matrix cases.
- [ ] `scripts/eval-phase-07.ts`, `scripts/verify-phase-07-evidence.ts`, `scripts/certify-phase-07.ts` — deterministic verification and protected live blocked-evidence runner.
- [ ] Verify every proposed OpenTelemetry package/version against official package metadata, Bun compatibility, and a throwaway Collector fixture before installation; the research seam marks packages beyond `@opentelemetry/api` as `SUS`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Protected credential/topology availability | SESS-02, OPS-02, OPS-03, OPS-04 | Credentials and production topology cannot be synthesized locally | Run `bun run certify:phase07 -- --profile=release`; confirm unavailable integrations write immutable `blocked`/`not_observed` records and `bun run candidate:verify` exits nonzero. |
| Subjective focused-napplet quality calibration | OPS-04 | The optional LLM judge must be calibrated against practitioner judgment | Two qualified reviewers label at least 20 artifacts; require Spearman rho ≥0.70 and false-pass ≤5%, otherwise disable the judge. |
| Narrow waiver/rollback drill | OPS-04 | Authorization and operational response require accountable release owners | Exercise a named, time-bounded non-safety waiver with owner, reason, expiry, rollback, audit linkage, and automatic expiry; prove core safety/SLO/live-certification checks reject waivers. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verification or Wave 0 dependencies.
- [ ] Sampling continuity: no three consecutive tasks without automated verification.
- [ ] Wave 0 covers every missing reference above.
- [ ] No watch-mode flags.
- [ ] Fast feedback latency is under 30 seconds.
- [ ] Required live observations are executed and fresh; blocked evidence is not promoted.
- [ ] `nyquist_compliant: true` is set only after `$gsd-validate-phase` confirms coverage.

**Approval:** pending
