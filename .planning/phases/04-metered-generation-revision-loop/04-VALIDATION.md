---
phase: 04
slug: metered-generation-revision-loop
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-04
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test, Bun 1.3.14 |
| **Config file** | none — `package.json` delegates to `bun test` |
| **Quick run command** | `bun test tests/phase-04 tests/billing tests/model --timeout 10000` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | quick ≤ 15 seconds; full suite ≤ 90 seconds on the reference development host |

---

## Sampling Rate

- **After every task commit:** Run the task's targeted Bun test plus `bun test tests/phase-03/tracer.test.ts` when the Phase 3 funding seam changes.
- **After every plan wave:** Run `bun test` and the deterministic Phase 4 reference-set command.
- **Before `$gsd-verify-work`:** The full suite and Phase 4 design-evidence verifier must be green.
- **Max feedback latency:** 15 seconds for the targeted quick lane; split slow fault-injection/reference tests into the wave lane if this ceiling is exceeded.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01/02/03 | 04-01–03 | 1–3 | BILL-03 | T-04-PRICE | Authorization-time price card produces one receipt-derived debit and unused release; replay cannot debit again. | unit + integration | `bun test tests/billing/price-card.test.ts tests/billing/operation-finalization.test.ts` | ✅ | ✅ green |
| 04-02/05 | 04-02, 04-05 | 2, 5 | BILL-04 | T-04-EVIDENCE | Immutable correlated line items and safe status expose every monetary/reconciliation transition without protected data. | integration | `bun test tests/billing/line-items.test.ts tests/phase-04/session-status.test.ts` | ✅ | ✅ green |
| 04-03/05 | 04-03, 04-05 | 3, 5 | BILL-05 | T-04-RETRY | Timeout, loss, or malformed receipt enters `usage_unknown`; reconciliation uses the original identity and never redispatches. | fault injection | `bun test tests/model/reconciliation.test.ts` | ✅ | ✅ green |
| 04-01/05 | 04-01, 04-05 | 1, 5 | SESS-01 | T-04-ORDER | Bounded start runs Phase 2 gates before budget, model, or worker effects and returns a stable owner-scoped session. | tracer | `bun test tests/phase-04/tracer.test.ts` | ✅ | ✅ green |
| 04-01/05 | 04-01, 04-05 | 1, 5 | SESS-03 | T-04-STATUS | Status is owner-only, truthful, bounded, and redacted while showing cap, confirmed spend, progress, and next action. | contract | `bun test tests/phase-04/session-status.test.ts` | ✅ | ✅ green |
| 04-04/05 | 04-04, 04-05 | 4, 5 | SESS-04 | T-04-RACE | Revision preserves checkpoint lineage, independently authorizes, replays exact duplicates, and rejects stale conflicts without effects. | integration | `bun test tests/phase-04/revision.test.ts` | ✅ | ✅ green |
| 04-04 | 04-04 | 4 | GEN-05 | T-04-REPAIR | One validation failure permits at most one separately authorized repair; another automatic repair is denied. | integration | `bun test tests/phase-04/repair.test.ts` | ✅ | ✅ green |
| 04-04 | 04-04 | 4 | GEN-06 | T-04-HONESTY | Failed/incomplete candidates retain the prior verified artifact and expose safe diagnostics/evidence only. | integration | `bun test tests/phase-04/artifact-outcome.test.ts` | ✅ | ✅ green |
| 04-06/07 | 04-06, 04-07 | 6, 7 | BILL-03/04/05, SESS-01/03/04, GEN-05/06 | T-04-SEPARATION | Deterministic fixtures prove the Phase 4 contract without implying live-provider selection or production readiness. | reference evidence | `bun run eval:phase04 && bun run verify:phase04-design` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `tests/billing/price-card.test.ts` and `tests/billing/operation-finalization.test.ts` — BILL-03 bigint/rational pricing and exact settlement.
- [x] `tests/billing/line-items.test.ts` — BILL-04 immutable financial/evidence projection.
- [x] `tests/model/reconciliation.test.ts` — BILL-05 timeout/lookup/no-retry behavior.
- [x] `tests/phase-04/tracer.test.ts` and `tests/phase-04/session-status.test.ts` — SESS-01 and SESS-03 public lifecycle contract.
- [x] `tests/phase-04/revision.test.ts`, `repair.test.ts`, and `artifact-outcome.test.ts` — SESS-04, GEN-05, and GEN-06.
- [x] `tests/evals/phase-04-reference-set.test.ts` plus redacted fixtures — provider-separated deterministic acceptance gate.
- [x] `scripts/verify-phase-04-design-slice.ts` and `src/verification/phase-04-design-evidence.ts` — immutable Phase 4 evidence emission.
- [x] `package.json` scripts `eval:phase04` and `verify:phase04-design` — stable CI entry points without a live provider.

---

## Required Adversarial and Reference Cases

- Price fixtures cover every priced dimension, zero/nonzero usage, cached/reasoning units, ceil boundaries, overflow, unsupported dimensions, profile/card mismatch, and actual usage above reservation.
- Idempotency fixtures cover duplicate commands/receipts, conflicting fingerprints, stale versions, simultaneous revisions, crash after provider success, and serializable retry.
- Ambiguity fixtures cover proven pre-dispatch zero use, timeout after acceptance, lost response, malformed receipt, lookup pending/found/not-found, and a zero fresh-invocation count while blocked.
- Artifact fixtures cover billed model/worker failure, build/verify/conformance failure, successful and failed single repair, and preservation of the prior verified artifact.
- Status fixtures cover foreign-owner denial, field-leak canaries, bounded history/cardinality, exact replay, and public/protected evidence separation.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Focused napplet usefulness and diagnostic actionability | GEN-05, GEN-06 | Subjective quality cannot supersede deterministic money, authority, or conformance gates. | Two qualified reviewers score the versioned redacted reference outputs using the AI-SPEC rubric; adjudicate disagreements. An optional judge remains advisory until Spearman correlation ≥ 0.70 and pass/fail agreement ≥ 80%. |
| Live provider exact-usage/reconciliation eligibility | BILL-03, BILL-05 | No provider is selected and no live fixture currently proves post-timeout receipt lookup. | Deferred to Phase 7: run the promoted adapter against authoritative provider receipts, accepted-timeout recovery, and exact price-card fixtures before selection. Phase 4 evidence must state `unselected`. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verification or implemented test dependencies.
- [x] Sampling continuity: no three consecutive tasks without automated verification.
- [x] All planned validation references exist and run green.
- [x] No watch-mode flags.
- [x] Full suite completes in 15 seconds; targeted lanes remain bounded.
- [x] Provider-separated evidence never promotes a live provider or claims production readiness.
- [x] `nyquist_compliant: true` is set in frontmatter after the implementation audit.

**Approval:** validated — 317 tests passed; all eight Phase 04 requirements have automated coverage. Live-provider certification remains an explicit Phase 07 deferral.

## Validation Audit 2026-08-05

| Metric | Count |
|--------|-------|
| Requirements audited | 8 |
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |
