---
phase: 04-metered-generation-revision-loop
verified: 2026-08-04T23:02:53Z
status: gaps_found
score: 5/8 must-haves verified
behavior_unverified: 2
overrides_applied: 0
gaps:
  - truth: "The twenty-case reference gate compares each declared state/effect oracle with runtime observations and fails on a wrong effect count."
    status: failed
    reason: "The evaluator executes a named test only for its exit code, then copies caseResults and aggregate effect counts from the fixture. A weakened test can still produce a design-ready record with the original claimed effects."
    artifacts:
      - path: "tests/evals/phase-04-reference-set.test.ts"
        issue: "Lines 79-83 assert only child-test exit status; no structured runtime effects are collected."
      - path: "scripts/verify-phase-04-design-slice.ts"
        issue: "Lines 26-39 derive aggregateEffects and passed caseResults directly from the fixture."
    missing:
      - "Make each reference scenario emit structured observed provider/worker/receipt/debit/release/state facts."
      - "Compare every observed fact to that case's fixture oracle before marking the case or aggregate evidence passed."
behavior_unverified_items:
  - truth: "The PostgreSQL-wire transaction path preserves exact settlement, terminal replay, action-budget release, session/artifact lineage, and remaining balance/cap across a real migrated database."
    test: "Apply Phase 3 and Phase 4 migrations to an empty PostgreSQL database, then exercise start → duplicate replay → status → revision and a receipt-found reconciliation with separate service instances."
    expected: "Exactly one debit and artifact advance per terminal action; replay returns identical canonical financial fields; action reservations release; stored lineage/status are owner-scoped."
    why_human: "The current SQL tests use scripted clients or source-string parity checks; no test applies the migration or runs the metered lifecycle against PostgreSQL."
  - truth: "A PostgreSQL-backed owner status/history projection supplies the persisted action, artifact, reconciliation, and line-item facts after restart."
    test: "Read a status page and its signed continuation cursor from a second process/composition against the same migrated database."
    expected: "The stored artifact identity, canonical balance/cap, ordered immutable line items, and cursor continuation remain correct and owner-scoped."
    why_human: "The owner-status test exercises the deterministic in-memory store rather than a live PostgreSQL result set."
---

# Phase 4: Metered Generation & Revision Loop Verification Report

**Phase Goal:** A funded user can create, revise, repair, and inspect a constrained napplet session while every billable action is authorized, exact-usage metered, and serialized.

**Verified:** 2026-08-04T23:02:53Z  
**Status:** gaps_found  
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | A bounded idea starts a stable, owner-scoped session; bounded revisions target the same session and report progress/cap/spend/next action. | ✓ VERIFIED | `MeteredGenerationService` validates input before authorization, serializes revision admission, and returns typed action results; tracer/revision/status/adapter tests pass. |
| 2 | Every action is re-authorized and settled once from receipt-derived actual usage at its authorization-time price/card version. | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Deterministic paths prove integer/rational pricing, provider correlation, duplicate replay, reservation release, and canonical replay results. The production PostgreSQL lifecycle was not run against an applied migration. |
| 3 | Owners inspect immutable, ordered holds/releases/debits/credits/reconciliation history with provider-safe inputs and remaining balance/cap. | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Memory/transaction-emulator line-item and owner-status tests pass; SQL code/migration wire the same tables and serializable path, but no real PostgreSQL execution proves the query/migration contract. |
| 4 | Ambiguous provider work becomes `usage_unknown` and reconciliation only looks up the original operation—never redispatching it. | ✓ VERIFIED | Dispatch exceptions, malformed receipts, pending lookups, concurrent reconciliation, and receipt-found recovery are covered by `tests/model/reconciliation.test.ts`; `ModelReconciliationService` uses `gateway.lookup`, not `dispatch`. |
| 5 | Failed/incomplete work retains the prior verified artifact, exposes safe diagnostics/evidence only, and permits at most one separately authorized repair. | ✓ VERIFIED | Harness returns a closed verified-or-diagnostic union; repair policy is persisted/action-scoped and revision/repair/artifact-outcome tests pass. |
| 6 | The public v1 generation surface is thin ContextVM `start_session`, `revise_session`, and `session_status`; repair, preview, publication, x402, and L402 are absent. | ✓ VERIFIED | Adapter schemas/registers and announcement test assert exactly the three generation tools; source scan found no forbidden external generation surface. |
| 7 | Twenty reference cases validate actual Phase 4 state/effect oracles, and changed effect counts make evidence verification fail. | ✗ FAILED | The fixture has 20 mappings, but the evaluator checks only each named test's exit code and copies effect totals/passed case statuses from fixture data. |
| 8 | Content-addressed design evidence is deterministic and keeps live provider selection/certification explicitly unselected. | ✓ VERIFIED | Evidence evaluator validates canonical content-addressed records and rejects selection/readiness/disclosure mutations; `verify:phase04-design` reports deterministic gateway `unselected` and live model `not_observed`. |

**Score:** 5/8 truths verified (2 present, behavior-unverified; 1 failed).

### Required Artifacts

All 23 declared artifacts across Plans 01–06 exist and pass substantive artifact checks. The following are the goal-critical implementation artifacts; each is imported/called by production composition or its deterministic test boundary.

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/model/{model-gateway,price-card,reconciliation}.ts` | Provider-neutral intent/receipt, pinned integer pricing, original-operation reconciliation | ✓ VERIFIED | Service persists/claims operation before `gateway.dispatch`; reconciliation uses `gateway.lookup`; deterministic gateway has no live selection. |
| `src/phase-04/metered-generation-service.ts` | Serialized start/revise/repair coordinator | ✓ VERIFIED | Wires input/risk → funded action budget → durable operation claim → receipt pricing → harness → finalizer. |
| `migrations/phase-04/001_metered_generation.sql` + `src/persistence/postgres-sql-funding-store.ts` | Seeded, serializable durable settlement authority | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Schema contains seeded profile/card, append-only line items, constraints and finalization tables; code uses `BEGIN ISOLATION LEVEL SERIALIZABLE`. No actual PostgreSQL integration run. |
| `src/phase-04/{napplet-harness,repair-policy,session-status}.ts` | Verified artifact outcome, one-repair ceiling, owner-safe status/cursor | ✓ VERIFIED | Harness invokes server verifier/contract gate; repair policy is restrictive and action-bound; status uses HMAC-bound cursors and owner-scoped store reads. |
| `src/contextvm/{adapter,announcement}.ts` | Locked public ContextVM surface | ✓ VERIFIED | Strict schemas/allowlists call only transport-neutral metered facades; repair remains internal. |
| `tests/fixtures/phase-04-reference-set.json`, evaluator, evidence writer, verifier script | Twenty-case executable evidence gate | ✗ STUBBED EVIDENCE | Files are substantive and run, but their claimed runtime effect oracles are fixture-declared rather than observed. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| metered service | funded admission | `authorizeActionBudget` after input/risk acceptance | ✓ WIRED | Direct invocation precedes preparation/dispatch. |
| metered service | ModelGateway | persisted/claimed `ProviderOperationIntent` → `this.options.gateway.dispatch` | ✓ WIRED | Automated link probe missed the `this.options` spelling; manual source inspection and tracer/reconciliation tests confirm it. |
| metered service | metered funding store | prepare/claim/receipt/finalize transactions | ✓ WIRED | Finalization returns the canonical persisted result. |
| reconciliation coordinator | ModelGateway/store | original intent → `gateway.lookup` → same finalizer | ✓ WIRED | Automated probe missed the `this.options` spelling; reconciliation tests prove no replacement dispatch. |
| metered service | napplet harness | harness result before finalization | ✓ WIRED | Automated probe missed local alias `const harness = ...runner`; artifact outcome tests exercise the branch. |
| harness | artifact contract | verifier facts → `evaluateArtifactContract` | ✓ WIRED | Only verified branch supplies artifact ID for finalization. |
| session status | funding store | owner-scoped status/actions/history queries | ✓ WIRED | Status/cursor tests cover normal, foreign, malformed, and unavailable paths. |
| ContextVM adapter | transport-neutral metered service/status | strict schemas/response allowlist | ✓ WIRED | Adapter tests cover signed sender propagation and exact tool registry. |

### Data-Flow Trace

| Artifact | Data | Source | Status |
| --- | --- | --- | --- |
| Metered generation service | price/profile, operation ID, receipt charge, canonical terminal fields | fixed profile/card → persisted action → gateway receipt → `priceReceipt` → funding finalizer | ✓ FLOWING in deterministic execution; production PostgreSQL behavior unexercised |
| Session status | session/action/artifact/line-item projection | owner-scoped `MeteredFundingStore` queries → HMAC cursor/status schema | ✓ FLOWING in deterministic execution; PostgreSQL result mapping unexercised |
| ContextVM adapter | redacted session response | signed event identity → strict command schema → metered facade → response allowlist | ✓ FLOWING |

## Requirements Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| BILL-03 | ⚠️ NEEDS POSTGRES EXECUTION | Receipt pricing, duplicate protection, cap ceiling, finalizer/replay and reservation release pass deterministic tests; real SQL transaction behavior is not integration-tested. |
| BILL-04 | ⚠️ NEEDS POSTGRES EXECUTION | Complete ordered immutable owner history and cursor behavior pass deterministic tests; live SQL projection remains unexercised. |
| BILL-05 | ✓ SATISFIED | Ambiguity becomes `usage_unknown`; lookup-only recovery retains original operation and has zero redispatch tests. |
| SESS-01 | ✓ SATISFIED | Start rejects malformed/bounded-invalid input before any budget/provider/worker/ledger effects; three public ContextVM tools are strict. |
| SESS-03 | ⚠️ NEEDS POSTGRES EXECUTION | Typed owner-safe status shows required data in deterministic tests; production read/migration mapping has no integration coverage. |
| SESS-04 | ⚠️ NEEDS POSTGRES EXECUTION | Same-lineage revisions, replay/stale/concurrency checks pass in deterministic stores; production restart path is unexercised. |
| GEN-05 | ✓ SATISFIED | One persisted owner/session/origin-bound repair action with new authorization; second automatic repair is denied. |
| GEN-06 | ✓ SATISFIED | Server verification controls artifact advance; failed/incomplete outcomes retain prior identity and expose safe diagnostics. |

## Decision Coverage (D-59–D-78)

| Decisions | Status | Evidence |
| --- | --- | --- |
| D-59, D-60 | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Authorization-time card/ceiling, exact receipt debit, release, canonical terminal replay are implemented and deterministic-tested; the PostgreSQL transaction is unrun. |
| D-61, D-62 | ✓ VERIFIED | Persisted operation identity/sub-reservation and BigInt/rational cardinal pricing are covered by price, tracer, and finalization tests. |
| D-63 | ✓ VERIFIED | Over-ceiling/unpriceable paths enter `billing_invariant_failed`, quarantine profile/card, and do not overcharge in deterministic authority tests. |
| D-64, D-65, D-66 | ✓ VERIFIED | Only coordinator calls the transport-neutral gateway; durable claim/intention precedes dispatch; receipt operation/request correlations are checked before pricing. |
| D-67, D-68 | ✓ VERIFIED | Ambiguity fence, lookup-only recovery, zero definitive rejection, and billed nonzero failures are behaviorally exercised. |
| D-69, D-70 | ✓ VERIFIED | Text-only start/revision schemas, duplicate replay/conflict fencing, owner/session action identity and internal-only repair are tested. |
| D-71 | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Durable terminal artifact/lineage fields and failure retention exist, but restart behavior against actual PostgreSQL has no execution evidence. |
| D-72 | ✓ VERIFIED | Repair policy caps automatic recovery at one action and validates durable origin/failure bindings. |
| D-73, D-74, D-75 | ✓ VERIFIED | Project-owned harness validates promoted toolchain identity, allowed surfaces, artifact contract, build/verify/conformance evidence, and truthful failure outcome. |
| D-76, D-77 | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Adapter remains ContextVM-only and cursor/status are owner-safe in deterministic tests; full persisted SQL status projection remains unrun. |
| D-78 | ✓ VERIFIED | No live provider is selected; deterministic fixture and live `not_observed` separation are asserted. The effect-oracle evidence weakness below does not create a live-provider claim. |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Full workspace regression | `bun test` | 309 pass, 0 fail; 1,390 assertions | ✓ PASS |
| Twenty-case eval gate | `bun run eval:phase04` | 5 pass, 0 fail | ✓ PASS (with evidence-oracle gap below) |
| Design evidence command | `bun run verify:phase04-design` | 40 focused Phase 4 tests + 5 evidence tests pass; design-ready, live model `not_observed` | ✓ PASS (with evidence-oracle gap below) |

## Probe Execution

Step 7c: SKIPPED — no Phase 4 probe scripts are declared or present.

## Anti-Patterns and Test-Quality Audit

| Finding | Severity | Impact |
| --- | --- | --- |
| Reference evaluator uses `Bun.spawnSync` exit status only, then fixture-declared `caseResults` and `aggregateEffects`. | 🛑 BLOCKER | Plan 06's exact runtime-effect/evidence truth is false. Passing tests still demonstrate individual behaviors, but evidence cannot certify their declared aggregate effects. |
| No disabled `.skip`/`.only` tests, circular expected-equals-actual assertions, unreferenced TBD/FIXME/XXX markers, placeholder UI/API returns, or console-only implementations found in Phase 4 surfaces. | ℹ️ Info | No additional stub/debt blocker. |
| SQL store tests use a `ScriptedClient`; schema test checks source strings. | ⚠️ Warning | Real migration, serializable updates, constraint names, result-row mapping, and restart behavior have no execution proof. |

## Deferred Items

| Item | Addressed In | Evidence |
| --- | --- | --- |
| Live provider/proxy selection, credentialed exact-usage certification, timeout lookup certification, and SLO/chaos evidence | Phase 7 | Roadmap Phase 7 validation gate and D-78 explicitly defer this; deterministic provider remains unselected. |
| Insufficient-funds live worker, durable checkpoint retention, explicit resume, and 30-day expiry | Phase 5 | Roadmap Phase 5 success criteria and Phase 4 context explicitly defer continuity. |
| Preview, user signing, publication, deployment, and attestation | Phase 6 | Roadmap Phase 6 owns sealed preview/publication; Phase 4 intentionally exposes none. |

## Gaps Summary

The core deterministic implementation is substantively wired: it has input/order gates, action ceilings, intent-before-I/O, original-operation reconciliation, receipt correlation, exact terminal replay fields, durable artifact lineage fields, one repair, owner-safe status, and a thin ContextVM boundary. The known Phase 7 provider and Phase 5 continuity work is clearly deferred and is not a Phase 4 gap.

However, the claimed Phase 4 release evidence is not an executable state/effect oracle. It can report 20 passed cases and exact aggregate debit/release/provider counts even if a referenced test's assertions no longer establish those effects. This is observable in the evaluator and verifier source, not a summary claim, and blocks the phase's Plan 06 evidence-gate truth. Separately, the production PostgreSQL implementation is wired but needs an actual migrated-database integration run before its transaction/restart assertions can be certified.

---

_Verified: 2026-08-04T23:02:53Z_  
_Verifier: the agent (gsd-verifier)_
