---
phase: 04-metered-generation-revision-loop
verified: 2026-08-05T00:11:55Z
status: passed
score: 8/8 must-haves verified for design profile
behavior_unverified: 2
overrides_applied: 2
re_verification:
  previous_status: gaps_found
  previous_score: 5/8
  gaps_closed:
    - "The twenty-case reference gate compares each declared state/effect oracle with runtime observations and fails on a wrong effect count."
  gaps_remaining: []
  regressions: []
behavior_unverified_items:
  - truth: "Every action is re-authorized and settled once from receipt-derived actual usage at its authorization-time price/card version."
    test: "Apply the Phase 3 and Phase 4 migrations to an empty PostgreSQL database, then run start -> duplicate replay -> status -> revision and receipt-found reconciliation through separately composed services."
    expected: "Exactly one debit and artifact advance per terminal action; the replay returns the persisted canonical financial fields; reservations release; price/card identity stays pinned."
    why_deferred: "The deterministic runtime probes and SQL protocol tests pass; live migrated-PostgreSQL execution is production certification outside the design gate."
  - truth: "Owners inspect immutable, ordered holds/releases/debits/credits/reconciliation history with provider-safe inputs and remaining balance/cap."
    test: "Use a second process/composition against the same migrated PostgreSQL database to fetch owner status and continue a signed billing cursor."
    expected: "Persisted action/artifact/reconciliation facts, exact balance/cap projections, ordered immutable line items, and cursor continuation remain owner-scoped."
    why_deferred: "Owner-status behavior and PostgreSQL row/result mapping are tested; live restart projection is production certification outside the design gate."
non_blocking_production_follow_up:
  - test: "Apply the Phase 3 and Phase 4 migrations to an empty PostgreSQL database, then run start -> duplicate replay -> status -> revision and receipt-found reconciliation through separately composed services."
    expected: "Exactly one debit and artifact advance per terminal action; the replay returns the persisted canonical financial fields; reservations release; price/card identity stays pinned."
    why_deferred: "The deterministic runtime probes and SQL protocol tests pass; live migrated-PostgreSQL execution is production certification outside the design gate."
  - test: "Use a second process/composition against the same migrated PostgreSQL database to fetch owner status and continue a signed billing cursor."
    expected: "Persisted action/artifact/reconciliation facts, exact balance/cap projections, ordered immutable line items, and cursor continuation remain owner-scoped."
    why_deferred: "Owner-status behavior and PostgreSQL row/result mapping are tested; live restart projection is production certification outside the design gate."
---

# Phase 4: Metered Generation & Revision Loop Verification Report

**Phase Goal:** A funded user can create, revise, repair, and inspect a constrained napplet session while every billable action is authorized, exact-usage metered, and serialized.

**Verified:** 2026-08-05T00:11:55Z
**Status:** passed (design profile)
**Re-verification:** Yes — after Plan 04-07 evidence-integrity gap closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | A bounded idea starts an owner-scoped session; bounded revisions target that lineage and report progress/cap/spend/next action. | ✓ VERIFIED | Runtime cases P04-AUTH-03, P04-ACCT-03, P04-SER-02, and P04-SER-03 exercise actual `MeteredGenerationService` paths; tracer, revision, status, and adapter assertions pass. |
| 2 | Each generation/revision/repair is re-authorized and settles exactly once from receipt-derived usage at its authorization-time price/card version. | ✓ VERIFIED (DESIGN) | Deterministic financial/tracer/reconciliation cases prove price arithmetic, intent-before-dispatch, duplicate replay, receipt settlement, releases, and canonical results; SQL schema/protocol parity is automated. Live PostgreSQL execution is a non-blocking production follow-up. |
| 3 | Owners inspect immutable ordered holds/releases/debits/credits/reconciliation history with provider-safe inputs and remaining balance/cap. | ✓ VERIFIED (DESIGN) | Runtime P04-ACCT-02/P04-STATUS-01 plus owner-status and line-item tests prove the authority; migration/schema parity and SQL-protocol tests cover persistence mapping. Live restart projection is a non-blocking production follow-up. |
| 4 | Ambiguous provider work becomes `usage_unknown`; reconciliation looks up the original operation and never redispatches it. | ✓ VERIFIED | P04-ACCT-04 and P04-AMB-01..03 execute the deterministic gateway/reconciliation authorities. `tests/model/reconciliation.test.ts` passes pending, malformed, definitive-zero, concurrent, and receipt-found paths. |
| 5 | Failed/incomplete work retains the prior verified artifact, exposes safe diagnostics/evidence only, and allows at most one separately authorized repair. | ✓ VERIFIED | P04-ART-01..03 and P04-ADV-01 exercise `ProjectNappletHarness` and repair policy; artifact-outcome/repair tests pass. |
| 6 | The v1 public generation surface is only ContextVM `start_session`, `revise_session`, and `session_status`; repair, preview, publication, x402, and L402 are absent. | ✓ VERIFIED | P04-AUTH-04 executes the adapter allowlist. Adapter tests pass and the evidence validator rejects preview/publish/readiness/provider-selection claims. |
| 7 | The twenty-case gate compares each state/effect oracle with actual runtime observations; altered effects fail closed. | ✓ VERIFIED | `executePhase04ReferenceGate` executes observers before comparison, checks every strict field, requires child assertions, and derives aggregates from matched observations. All 20 cases pass; exhaustive field mutations and the recomputed wrong-oracle test block evidence before any record/pointer write. |
| 8 | Content-addressed design evidence is deterministic and keeps the live provider unselected/unobserved. | ✓ VERIFIED | Standalone re-validation of `evidence/design/phase-04.json` and its record succeeded: digest `2e9c23219e9ebb0dd02b345ecdbe6b382aed1d1c77acc42707fd23a53b815d88`, 20 passed comparisons, observed aggregate `{dispatches:9, lookups:3, workers:7, receipts:7, debits:9, credits:2, releases:10}`, live model `not_observed/unselected`. |

**Score:** 8/8 truths verified for the Phase 4 design profile. Two live-PostgreSQL exercises remain production follow-up and do not block this design milestone.

### Gap-Closure Evidence Integrity

The prior BLOCKER is closed. The gap-closure implementation is substantive and wired:

| Check | Result | Evidence |
| --- | --- | --- |
| Fact-only observation boundary | ✓ VERIFIED | `observePhase04Case` accepts only case ID, bounded input, initial state, and schedule; the expected object/oracle is consumed only by `comparePhase04Case`. |
| Twenty actual observations | ✓ VERIFIED | Financial and session/artifact registries cover the 20 canonical IDs, each producing all 14 strict observation fields from service/store/gateway/worker/harness/adapter facts. |
| Wrong-oracle fail closed | ✓ VERIFIED | The test mutates every runtime field, recomputes the fixture oracle, and confirms a failed comparison with no aggregate. The dedicated pointer-write test confirms no file exists after the rejected run. |
| Evidence re-derivation | ✓ VERIFIED | `validatePhase04DesignEvidence` reconstructs comparisons/results/aggregates and requires canonical full-record equality; tampered result/aggregate validation tests pass. |
| Canonical pointer/record | ✓ VERIFIED | The current pointer names the content-addressed record above; independent import-and-validate confirmed matching digest, verdict, 20 cases, and all observed aggregate effects. |
| Closure scope | ✓ VERIFIED | The Plan 04-07 commit range modifies only evidence/runtime-probe/test/support artifacts plus planning/pointer records; no Phase 04 service, model, SQL store, ContextVM adapter, or policy implementation changed. |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `tests/evals/phase-04-runtime-observation.ts` | Strict observation/comparison/aggregate contract | ✓ VERIFIED | Exists, substantive, imported by runner/tests; strict schema and comparison cover all 14 fields. |
| `tests/evals/phase-04-runtime-financial.ts` | Financial/runtime authority scenarios | ✓ VERIFIED | Exists, substantive, dispatched by the observation layer; invokes price card, metered store, gateway, reconciliation, and generation service. |
| `tests/evals/phase-04-runtime-session-artifact.ts` | Harness/repair/status/adapter scenarios | ✓ VERIFIED | Exists, substantive, dispatched by the observation layer; invokes concrete probe authority. |
| `src/verification/phase-04-design-evidence.ts` | Derived, immutable design record | ✓ VERIFIED | Evaluates comparisons and aggregates itself; standalone validator re-derives the canonical record. |
| `scripts/verify-phase-04-design-slice.ts` | Fail-closed record/pointer command | ✓ VERIFIED | Calls runtime gate before `writePhase04DesignEvidence`, then re-reads/validates the written record before pointer update. |
| `migrations/phase-04/001_metered_generation.sql` + `src/persistence/postgres-sql-funding-store.ts` | Durable serializable settlement/projection authority | ✓ VERIFIED (DESIGN) | Schema/store are substantive and wired; protocol, retry, mapping, and source-schema parity tests pass. Live migrated-database execution is retained as production follow-up. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| Runtime gate | Financial observers | case-ID dispatch with bounded facts only | ✓ WIRED | Automated key-link verification passed; manual source inspection confirms expected/oracle never enters an observer. |
| Runtime gate | Session/artifact observers | case-ID dispatch with strict observation return | ✓ WIRED | Automated key-link verification passed; unknown IDs fail rather than fabricate an observation. |
| Design runner | Design-evidence evaluator | matched comparisons -> evaluate -> write -> reread/validate -> pointer | ✓ WIRED | Automated key-link verification passed; mismatch throws before evidence directory/pointer creation. |
| Metered coordinator | funded admission/gateway/store/harness | authorize -> persisted intent -> dispatch -> receipt/harness -> finalizer | ✓ WIRED | Regression tracer/revision/reconciliation/artifact tests pass; no regression introduced by 04-07. |
| Reconciliation | original gateway operation/store finalizer | `lookup` of persisted operation, never replacement dispatch | ✓ WIRED | Reconciliation tests and P04 ambiguity observations pass. |
| Status | owner-scoped store reads/cursor | session/action/line-item projection | ✓ WIRED | Status tests cover owner, foreign, malformed cursor, bounds, and ordered pages. |
| ContextVM adapter | transport-neutral start/revise/status | strict public tool schemas | ✓ WIRED | Adapter test confirms exact three-tool registry and signed-sender propagation. |

### Data-Flow Trace

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| Runtime observation gate | `observed` | Actual deterministic service/store/gateway/worker/harness/adapter executions | Yes; expected values are comparator-only | ✓ FLOWING |
| Design evidence | case status + aggregate effects | Exact expected/observed comparison; sums only `observed` fields from passed comparisons | Yes | ✓ FLOWING |
| Metered terminal/status path | receipt charge, artifact/version, line items, cap/balance | Metered store and owner-scoped status projection | Yes; deterministic authority and SQL mapping/schema parity are automated | ✓ FLOWING (DESIGN) |

### Requirements Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| BILL-03 | ✓ SATISFIED (DESIGN) | P04-AUTH-01/02, P04-ACCT-01/03/04, P04-SER-01 and billing/tracer/SQL parity tests prove exact settlement, pinning, replay, and release. |
| BILL-04 | ✓ SATISFIED (DESIGN) | P04-ACCT-01/02 and P04-STATUS-01 prove ordered immutable history and projections; SQL mapping/schema parity tests pass. |
| BILL-05 | ✓ SATISFIED | P04-ACCT-04 and P04-AMB-01..03 execute timeout/malformed/lookup/reconciliation behavior with no redispatch. |
| SESS-01 | ✓ SATISFIED | P04-AUTH-03/04 and P04-ACCT-03 prove bounded text admission before effects and the exact ContextVM surface. |
| SESS-03 | ✓ SATISFIED (DESIGN) | P04-ACCT-02, P04-ADV-02, and P04-STATUS-01 prove owner-safe status/history; SQL mapping/schema parity tests pass. |
| SESS-04 | ✓ SATISFIED (DESIGN) | P04-SER-02/03 and revision tests prove separately metered same-lineage revision, replay, and concurrency fences. |
| GEN-05 | ✓ SATISFIED | P04-ART-03 and P04-ADV-01 prove bounded, origin-bound, coordinator-only repair with a one-repair ceiling. |
| GEN-06 | ✓ SATISFIED | P04-ACCT-03, P04-ART-01/02, and P04-STATUS-01 prove verified advance or retained prior artifact with safe evidence/diagnostics. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Workspace regression | `bun test` | 317 pass, 0 fail, 1,464 assertions | ✓ PASS |
| Runtime reference gate | `bun run eval:phase04` | 13 pass, 0 fail; 20 observed cases and wrong-oracle tests pass | ✓ PASS |
| Design record generation | `bun run verify:phase04-design` | 40 focused Phase 4 tests + gate pass; reports design-ready digest above | ✓ PASS |
| Standalone pointer/record validation | `bun -e` import of `validatePhase04DesignEvidence` | Pointer, digest, 20 cases, and all seven aggregate effect totals match | ✓ PASS |

### Probe Execution

Step 7c: SKIPPED — no Phase 4 `scripts/*/tests/probe-*.sh` probe is declared or present. The deterministic reference gate is executed above rather than treated as a SUMMARY claim.

### Anti-Patterns and Prohibitions

| Finding | Severity | Result |
| --- | --- | --- |
| Fixture expected/oracle leakage into observers | ✓ VERIFIED ABSENT | Static source guard and manual data-flow inspection: expected/oracle are accepted only by comparator code; observers accept only case facts. |
| Fixture-projected case status or aggregate | ✓ VERIFIED ABSENT | Gate derives status from strict comparisons and aggregate solely from observed values; mutation tests reject recomputed fixture oracle. |
| Evidence accepting tampered derived fields | ✓ VERIFIED ABSENT | Standalone validator re-evaluates loaded record and requires canonical equality; tampered aggregate/case-result tests fail. |
| Plan 04-07 production-authority changes | ✓ VERIFIED ABSENT | Commit-range scope check found no changes in `src/phase-04`, `src/model`, `src/persistence`, `src/contextvm`, or `src/policy`. |
| Live provider selection/credential, preview/publication claim | ✓ VERIFIED ABSENT | Source/evidence guards and tests require deterministic `unselected`, live `not_observed/unselected`, zero credential inputs, and reject readiness claims. |
| Unreferenced `TBD`/`FIXME`/`XXX`, placeholder/console-only implementation in Phase 04 closure surfaces | ✓ VERIFIED ABSENT | Targeted scan found none. |
| Real PostgreSQL integration coverage | ⚠️ Warning | Mocked `ScriptedClient` protocol and source-schema parity tests do not prove applied-migration runtime behavior. |

### Deferred Items

| Item | Addressed In | Evidence |
| --- | --- | --- |
| Live provider/proxy selection, credentialed exact-usage certification, timeout lookup certification, and SLO/chaos evidence | Phase 7 | Roadmap Phase 7 validation gate; Phase 4 record explicitly keeps the live model `not_observed/unselected`. |
| Insufficient-funds live worker, durable checkpoints, explicit resume, and 30-day expiry | Phase 5 | Roadmap Phase 5 success criteria. |
| Preview, signing, publication, deployment, and attestation | Phase 6 | Roadmap Phase 6 success criteria; Phase 4 evidence rejects preview/publish claims. |

### Non-blocking Production Follow-up

### 1. PostgreSQL metered lifecycle

**Test:** Apply the Phase 3 and Phase 4 migrations to an empty PostgreSQL database, then run start -> duplicate replay -> status -> revision and receipt-found reconciliation through separately composed services.

**Expected:** Exactly one debit and artifact advance per terminal action; replay returns canonical persisted financial fields; action reservations release; price/card identity stays pinned.

**Why deferred:** The supplied tests use deterministic stores or scripted SQL clients. Live database certification is useful before production deployment but is outside the Phase 4 design-profile gate.

### 2. PostgreSQL owner-status/restart projection

**Test:** From a fresh process/composition against the same migrated database, read status and continue a signed billing-history cursor.

**Expected:** Stored artifact/reconciliation/action lineage, ordered immutable lines, balance/cap projections, and cursor continuation remain correct and owner-scoped.

**Why deferred:** Deterministic owner-status behavior and SQL mappings are tested; live restart behavior belongs in deployment/integration certification.

## Design-profile Overrides

The orchestrator accepted both live-PostgreSQL exercises as non-blocking follow-up. This follows the project direction that design work does not require production-perfect trust validation, while preserving the checks explicitly in this report for later certification. No failed implementation or evidence-integrity claim was overridden.

## Milestone Roll-up Context

Phase 4 has 7/7 plans executed and 8/8 requirements verified for the design profile. Plan 04-07 closed the only prior blocker: release evidence now uses executable runtime observations rather than fixture-projected effects. The two live-PostgreSQL exercises remain visible non-blocking production follow-up. Phase 5, 6, and 7 deferrals remain intentionally outside this phase.

## Gaps Summary

No implementation or evidence-integrity gaps remain. The phase passes its design-profile gate; live migrated-PostgreSQL lifecycle and restart exercises remain documented for production certification.

---

_Verified: 2026-08-05T00:11:55Z_
_Verifier: the agent (gsd-verifier)_
