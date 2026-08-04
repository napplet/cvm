---
phase: 03
slug: contextvm-funding-funded-admission
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-04
---

# Phase 03 — Validation Strategy

> Planning-time Nyquist contract. Every implementation task owns a runnable automated gate; live interoperability remains provider-separated and cannot certify the offline design.

## Test Infrastructure

| Property | Value |
|---|---|
| Framework | Bun test 1.3.14 |
| Config | `package.json`, existing TypeScript/Bun conventions |
| Focused quick run | `bun test tests/phase-03/tracer.test.ts` |
| Funding suite | `bun test tests/persistence/postgres-funding-store.test.ts tests/funding tests/contextvm` |
| Deterministic eval | `bun run eval:phase-03` |
| Full design slice | `bun run test:phase-03-design-slice` |
| Live surfaces | Optional, separately recorded ContextVM/Lightning/Cashu/PostgreSQL/capacity observations; absent config is `blocked/unselected` |

## Sampling Rate

- After every RED commit: run the exact focused test and confirm it fails for the intended missing behavior, not syntax/import setup.
- After every GREEN commit: rerun the focused test plus `bun test` before plan summary.
- After each wave: run `bun test`; after Wave 3 also run all ContextVM/Lightning/Cashu focused suites together.
- Before phase verification: run package evidence, canonical API coverage, `bun run eval:phase-03`, `bun run test:phase-03-design-slice`, and `bun test`.
- No watch mode and no live credential is required for offline feedback.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirements | Threats | Secure behavior | Test type | Automated command | Planned test/evidence file | Status |
|---|---:|---:|---|---|---|---|---|---|---|
| 03-01-01 | 01 | 1 | CTX-02/03, PAY-04/05, BILL-01/02/06 | T-03-01–04 | Verified principal -> one account -> verified credit -> cap hold -> admission -> redacted status -> exact replay; representative denials have zero effects | end-to-end tracer | `bun test tests/phase-03/tracer.test.ts` | `tests/phase-03/tracer.test.ts` | ⬜ pending |
| 03-02-01 | 02 | 2 | supporting all adapter/store requirements | T-03-02-SC | Exact official packages pass registry/source/license/lifecycle/integrity checks before exact install; ambiguity blocks | deterministic supply-chain gate | `bun run scripts/verify-phase-03-packages.ts && bun pm ls @contextvm/sdk @cashu/cashu-ts kysely pg` | `scripts/verify-phase-03-packages.ts`, `evidence/phase-03/package-intake.json` | ⬜ pending |
| 03-02-02 | 02 | 2 | CTX-02/03/04, PAY-04/05, BILL-01/02/06 | T-03-05–08 | Serializable append-only authority proves replay, uniqueness, conservation, rollback, reconnect, retry, and concurrent holds without repeated external effects | persistence integration | `bun test tests/persistence/postgres-funding-store.test.ts` | `tests/persistence/postgres-funding-store.test.ts` | ⬜ pending |
| 03-03-01 | 03 | 3 | CTX-01, PAY-01 | T-03-09–12 | Signed announcement contains required surfaces/truthful availability and only v1 top-up PMIs; no x402/L402 or false availability | fixture/contract | `bun test tests/contextvm/adapter.test.ts --test-name-pattern='announcement'` | `tests/fixtures/contextvm-phase-03.json`, `tests/contextvm/adapter.test.ts` | ⬜ pending |
| 03-03-02 | 03 | 3 | CTX-02/03/04, PAY-01/04, BILL-01 | T-03-09–12, T-03-03-SC | SDK-verified sender only, durable cross-instance replay, transparent/explicit identity, PMI/mode denial, correlation, redaction, import firewall | adapter integration | `bun test tests/contextvm/adapter.test.ts` | `tests/contextvm/adapter.test.ts` | ⬜ pending |
| 03-04-01 | 04 | 3 | PAY-01/04/05 | T-03-14–16 | Top-up/invoice intent precedes one provider call; protected material is ciphertext-only; ambiguity reconciles by original reference | adapter/state-machine | `bun test tests/funding/lightning-top-up.test.ts --test-name-pattern='initiation|protected material'` | `tests/funding/lightning-top-up.test.ts` | ⬜ pending |
| 03-04-02 | 04 | 3 | PAY-02/04/05 | T-03-13–16 | Fully matched authoritative settled receipt credits once; all non-final/mismatched/duplicate/unknown receipts have exact safe deltas | settlement integration | `bun test tests/funding/lightning-top-up.test.ts` | `tests/funding/lightning-top-up.test.ts` | ⬜ pending |
| 03-05-01 | 05 | 3 | PAY-01/03/04/06 | T-03-17–20, T-03-05-SC | Immutable multi-mint policy/history, exact PMI, mint/unit/keyset/DLEQ/condition checks, encrypted proofs, online swap, adapter confinement | fixture/adapter | `bun test tests/funding/cashu-top-up.test.ts --test-name-pattern='policy|validation|swap'` | `tests/fixtures/cashu-phase-03.json`, `tests/funding/cashu-top-up.test.ts` | ⬜ pending |
| 03-05-02 | 05 | 3 | PAY-03/04/05/07 | T-03-17–20 | Unique proof commitment credits once; timeout-after-swap is query-only reconciliation; treasury outcomes never recredit | settlement integration | `bun test tests/funding/cashu-top-up.test.ts` | `tests/funding/cashu-top-up.test.ts` | ⬜ pending |
| 03-06-01 | 06 | 4 | BILL-01/02/06 | T-03-21–23, T-03-25 | Immediate capacity + cap hold agree or durable refusal/compensation leaves no queue/hold; action budgets remain bounded non-debit reservations | domain/persistence concurrency | `bun test tests/funding/funded-admission.test.ts tests/phase-03/tracer.test.ts` | `tests/funding/funded-admission.test.ts`, `tests/phase-03/tracer.test.ts` | ⬜ pending |
| 03-06-02 | 06 | 4 | CTX-04, BILL-01/02/06 | T-03-23–25 | Owner-scoped complete redacted status and explicit production-vs-test composition; missing providers stay blocked/unselected | composition integration | `bun test tests/funding/funded-admission.test.ts tests/phase-03/tracer.test.ts` | `tests/funding/funded-admission.test.ts`, `tests/phase-03/tracer.test.ts` | ⬜ pending |
| 03-07-01 | 07 | 5 | all 14 | T-03-26–29 plus all above | Versioned complete reference inventory asserts result, state, effect, and evidence deltas with no LLM authority judgment | deterministic eval | `bun run eval:phase-03` | `tests/fixtures/phase-03-reference-set.json`, `tests/evals/phase-03-reference-set.test.ts` | ⬜ pending |
| 03-07-02 | 07 | 5 | all 14 | T-03-26–29 | Immutable evidence requires every check/mapping, rejects raw secrets/tamper/overclaim, and separates all live provider observations | evidence integration | `bun test tests/verification/phase-03-design-slice.test.ts` | `src/verification/phase-03-design-evidence.ts`, `tests/verification/phase-03-design-slice.test.ts` | ⬜ pending |
| 03-07-03 | 07 | 5 | all 14 | T-03-26–29 | One command runs full suite/eval/package/API/import/evidence gates and emits independently validated design record | end-to-end design gate | `bun run test:phase-03-design-slice` | `scripts/verify-phase-03-design-slice.ts`, `evidence/design/phase-03.json` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠ flaky/blocking environment*

## Requirement Coverage Matrix

| Requirement | Primary automated proof | Backstop/failure cases |
|---|---|---|
| CTX-01 | 03-03-01 announcement fixture | 03-07-01 full reference eval |
| CTX-02 | 03-03-02 verified-sender/account fixture | 03-01 tracer; forged/malformed sender cases |
| CTX-03 | 03-02-02 durable store + 03-03-02 adapter replay | same/new event, reopen, two-instance, conflict cases |
| CTX-04 | 03-06-02 combined account/session/top-up projection | cross-account, malformed, forbidden-field cases |
| PAY-01 | 03-03-01/02 PMI and top-up-tool fixtures | no-intersection/effective-mode/exact-amount denials |
| PAY-02 | 03-04-02 authoritative receipt matrix | wrong amount/unit/invoice/expiry/reference and duplicate callbacks |
| PAY-03 | 03-05-01/02 policy + online swap | mint/unit/keyset/DLEQ/proof/ambiguity rejection matrix |
| PAY-04 | 03-01 lifecycle tracer, 03-04/05 rail state tests | legal/illegal transitions and redacted status |
| PAY-05 | 03-02-02 uniqueness/concurrency plus both rail suites | relay/callback/client/proof duplicate and crash tests |
| PAY-06 | 03-05-01 multi-mint policy rotation | immutable historical-policy fixture |
| PAY-07 | 03-05-02 treasury reconciliation | duplicate/unknown/failure no-second-credit cases |
| BILL-01 | 03-01/03-06 explicit cap schemas and admission | unit/zero/negative/overflow/malformed denials |
| BILL-02 | 03-06-01 hold/action-budget concurrency | no model/worker hook without active authority |
| BILL-06 | 03-01/03-06 non-fee hold/release behavior | capacity refusal/compensation and no overage assertions |

## Wave 0 Test Ownership

- [ ] Plan 01 creates the canonical Phase 3 tracer and deterministic memory test authority before expansion.
- [ ] Plan 02 creates package-intake evidence and PostgreSQL-wire transaction/constraint fakes before rail adapters use the store.
- [ ] Plan 03 creates pinned ContextVM/CEP-8 fixtures and fake transport before any live relay is considered.
- [ ] Plan 04 creates fake authoritative Lightning receiver outcomes and protected-material canaries.
- [ ] Plan 05 creates pinned Cashu policy/proof fixtures and fake online swap/proof-state outcomes.
- [ ] Plan 06 creates fake immediate-capacity/session-status ports and concurrency/compensation cases.
- [ ] Plan 07 creates the complete reference inventory, evidence contract, and full design-slice command.

## Manual and Provider-Separated Verification

No manual pass can satisfy a Phase 3 requirement. Live ContextVM relay/signer, Lightning receiver, trusted Cashu mint, Cockroach/PostgreSQL, and capacity-provider checks are machine-recorded when configured. Missing configuration yields `blocked/unselected`; a live pass is at most `eligible-not-selected` until Phase 7 certification. Modal remains unselected.

## Phase Completion Gates

- [ ] `bun test` passes the full current and prior suite.
- [ ] `bun run eval:phase-03` passes every fixture oracle.
- [ ] `bun run test:phase-03-design-slice` validates and emits immutable evidence.
- [ ] `bun run scripts/verify-phase-03-packages.ts` revalidates exact package/lock identities.
- [ ] Canonical `COVERAGE.md` passes `api-coverage.verify-pre`; detailed `03-API-COVERAGE.md` remains consistent.
- [ ] Import firewall confirms SDK/provider/database types remain confined to their adapters.
- [ ] Ledger conservation/projection recomputation and no-stranded-hold/no-queue checks pass.
- [ ] Evidence retains Phase 4/5/6/7 and x402/L402 deferrals and makes no live/SLO/provider/provenance overclaim.

## Validation Sign-Off

- [x] All 14 planned tasks have an automated verification command.
- [x] Every Phase 3 requirement maps to primary and backstop automated proof.
- [x] No three consecutive tasks lack automated feedback.
- [x] No watch-mode command appears.
- [x] Live providers are separated from offline requirement proof.
- [ ] `wave_0_complete` becomes true only after the planned tests/evidence files exist.
- [ ] `nyquist_compliant` becomes true only after post-execution audit confirms green runnable coverage.

**Planning verdict:** Complete test design; implementation pending.
