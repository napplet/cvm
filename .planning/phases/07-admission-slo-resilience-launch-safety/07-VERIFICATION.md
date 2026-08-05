---
phase: 07-admission-slo-resilience-launch-safety
verified: 2026-08-05T18:49:27Z
status: gaps_found
score: 53/64 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "An accepted request reaches an isolated ready worker within five seconds at p95, or receives an immediate retryable capacity response."
    status: failed
    reason: "The admission implementation and deterministic refusal checks exist, but there is no passed protected Modal or Fly cohort. The canonical design record has worker_slo as not_observed and no provider is selected."
    artifacts:
      - path: "scripts/certify-phase-07.ts"
        issue: "The runner only writes blocked/not_observed inventory records; it never invokes a Modal/Fly benchmark or records a passed claim."
    missing:
      - "Run and persist comparable production-like Modal and Fly cohorts meeting the 1,000 accepted / 200 forced cohort / one-sided 95% p95 / zero-backlog gate."
  - truth: "Operators can measure real lifecycle outcomes and the service preserves committed money, sessions, artifacts, and publication effects through production failures."
    status: failed
    reason: "Telemetry, fault, restore, and original-operation logic are deterministically tested, but the required Collector, regional, SQL, object-store, payment/model, and publication drills have no passed protected observations."
    artifacts:
      - path: "evidence/design/22c6cd2b8e821f9ee155c00c0547395abb22acc7c7775a864e10fb2a01c79c66.json"
        issue: "It explicitly contains 3 blocked and 11 not_observed live claims, so it cannot establish an operations or continuity claim."
    missing:
      - "Candidate-bound, fresh protected observations for the declared topology and original-operation recovery drills."
  - truth: "Production promotion is possible only after all required immutable live evidence is passed and current."
    status: failed
    reason: "The internal fail-closed evaluator exists, but the public candidate verifier always returns PROTECTED_LIVE_CERTIFICATION_REQUIRED for release evidence and does not accept a release manifest or protected observation bundle."
    artifacts:
      - path: "src/promotion/candidate.ts"
        issue: "The --release-evidence path validates deterministic design evidence then unconditionally returns blocked; it does not wire evaluateReleaseCertification or a promoted decision."
    missing:
      - "A release CLI path that validates the exact release manifest and protected observation bundle, then invokes the sole atomic promotion decision after every required claim passes."
  - truth: "Recently published SUS OpenTelemetry packages are not installed until an explicit human approval is enforced."
    status: failed
    reason: "The immutable audit pointer remains approvalStatus: pending_human, but --require-approved exits 0 and exact root dependencies are already installed."
    artifacts:
      - path: "scripts/verify-phase-07-otel-packages.ts"
        issue: "approvedAudit verifies the pending_human audit digest and package rows, not an approval/rejection record bound to a human decision."
    missing:
      - "A signed or otherwise auditable digest-bound approval record that the smoke/install path requires, with rejection and drift failure coverage."
deferred:
  - truth: "Phase 1 real native scaffold/Chromium closure and exhaustive launch certification."
    addressed_in: "Phase 7"
    evidence: "01-VERIFICATION.md deferred real native closure plus provenance, reproducibility, hostile/mutation, golden, waiver, SBOM, and promotion gates to Phase 7; those live gates remain blocked here."
  - truth: "Phase 6 compatible-host, signer, CLI asset, relay, storage/database, selected-provider, and host UI certification."
    addressed_in: "Phase 7"
    evidence: "06-VERIFICATION.md deferred these live integrations and 10 host UI findings to Phase 7; no passed browser or integration observation exists."
---

# Phase 7: Admission SLO, Resilience & Launch Safety Verification Report

**Phase Goal:** The integrated service can honestly promise immediate-or-rejected work and preserve money, sessions, artifacts, and publication effects through production failures.

**Verified:** 2026-08-05T18:49:27Z  
**Status:** gaps_found  
**Re-verification:** No — initial verification

## Goal Achievement

The deterministic safety and fail-closed machinery is substantive and wired. The live release capability is not achieved. This is not a false negative against blocked evidence: blocked evidence and nonzero promotion are correct behavior. They are also explicit evidence that the Phase 7 production claims have not been established.

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Accepted work reaches a ready isolated worker within five seconds at p95, otherwise a retryable refusal is returned without a durable queue. | ✗ FAILED | Receipt-to-exact-ready and refusal/replay logic pass deterministically, but no protected provider cohort passed. The design record reports `worker_slo` for Modal as `not_observed` and Fly as `blocked`. |
| 2 | Operators can measure the required lifecycle outcomes without leaking protected content. | ✗ FAILED | Strict versioned OTel/redaction code and tests exist, but no passed candidate-bound Collector/live lifecycle observation is present. |
| 3 | Production failures preserve committed progress and prevent duplicate money or public effects. | ✗ FAILED | Fault/restore/original-operation schedules pass locally; real regional, database, object, payment/model, and publication drills remain blocked/not observed. |
| 4 | Promotion is blocked until pinned inputs, supply-chain proof, adversarial tests, reconciliation, and five-second-p95 load evidence are available. | ✓ VERIFIED | `evaluateReleaseCertification` requires fresh passed claims; design evidence has `promotionVerdict: blocked`; `candidate:verify -- --release-evidence evidence/design/phase-07.json` exited 1. |

**Score:** 53/64 must-haves verified. The count includes the four roadmap criteria plus all 60 plan-frontmatter truths. The 11 failed truths are the three unachieved roadmap outcomes, two Plan 07-03 approval truths, one Plan 07-04 approval-dependent truth, one Plan 07-05 live-benchmark truth, one Plan 07-08 real-browser truth, and three Plan 07-10 live/promotion truths.

### Deterministic and Protected Evidence

| Evidence tier | Result | Verification |
| --- | --- | --- |
| Deterministic reference set | ✓ 64/64 passed | `bun run eval:phase07` emitted `status: passed`, `cases: 64`, and `promotionVerdict: blocked`. The canonical record verifies via `bun run verify:phase07-evidence -- --verify-existing`. |
| Decision/spec-less coverage | ✓ 16/16 D-114–D-129; ✓ 64/64 E-01–E-64 | The fixture has exactly one case for each E-01–E-64 and maps every decision; the canonical record has all 5 requirements, 16 decisions, 5 threats, 53 API rows, 8 UI rows, and 10 AI dimensions. |
| Canonical design live inventory | 0 passed; 3 blocked, 11 not_observed | `evidence/design/22c6…79c66.json` is explicitly deterministic and reports `promotionVerdict: blocked`. |
| Canonical protected records | 0/32 passed; 32 blocked | `evidence/certification/fd49…fd32/live/*.json` contains only `status: blocked`, not a live pass. |
| Fresh verifier preflight | ✓ fail closed | Run in a temporary evidence directory: all 8 suites produced `blocked` records and `certify:phase07 -- --profile=release --preflight-only` exited 1. |

### Required Artifacts and Key Links

| Artifact / link | Status | Details |
| --- | --- | --- |
| ContextVM adapter → `FundedAdmissionService.admit` | ✓ WIRED | `src/contextvm/adapter.ts:262` passes signed receipt and trusted lifecycle context; `FundedAdmissionService` verifies receipt before provider/hold authority. |
| Admission benchmark / durable intent / refusal projection | ✓ VERIFIED (deterministic) | Exact-ready lease, capacity intent, duplicate coalescing, bounded refusal, and no-hold/no-queue tests pass. This is not a live p95 proof. |
| Telemetry contracts → redaction → OTel exporter → funded-core composition | ✓ WIRED | Strict schemas, protected correlations, finite attributes, and observer containment are imported and exercised by telemetry-policy tests. |
| Fault harness → model/publication/continuation/object store | ✓ WIRED (deterministic) | All D-122 schedule classes, exact object reads/fences, and original-operation-only reconciliation are tested. |
| Host contracts → strict presentation projection → browser-evidence schema | ✓ WIRED (projection only) | The 28-state and accessibility/copy contract is substantive and tested; no real compatible-host browser record exists. |
| Certification evidence writer → release evaluator | ✓ WIRED internally | Immutable observations reject non-pass, stale, wrong-candidate, and mutation inputs. |
| `candidate:verify` → release evaluator / promoted decision | ✗ NOT WIRED | Its release-evidence mode can only return `PROTECTED_LIVE_CERTIFICATION_REQUIRED`; it does not receive a release manifest/bundle or call the promotion evaluator. |
| Protected certification runner → live adapters | ✗ NOT WIRED | `scripts/certify-phase-07.ts` only parses a profile and writes empty-claim non-pass records; it imports/constructs no Modal, Fly, ContextVM, payment, model, topology, host, signer, CLI, upload, relay, or Collector adapter. |

The generic artifact checker reported several false “missing export” results because PLAN frontmatter writes `exports: [a, b]` as one scalar. Manual source inspection confirms the declared APIs are exported and substantive. The two generic key-link misses were also pattern defects: the fixture is read by `scripts/eval-phase-07.ts`, and the adapter calls `admit` with lifecycle context at line 262. Neither alters the failures above.

### Requirements Coverage

| Requirement | Status | Actual evidence |
| --- | --- | --- |
| SESS-02 | ✗ BLOCKED | Local immediate/refusal semantics pass, but the required selected-worker receipt-to-ready p95 evidence does not exist. |
| OPS-01 | ✗ BLOCKED | Redaction/cardinality policy passes; no real operational lifecycle/Collector evidence proves all outcomes in the candidate deployment. |
| OPS-02 | ✗ BLOCKED | Deterministic exact-effect matrix passes; no real regional/relay/database/worker/publication recovery drill has passed. |
| OPS-03 | ✗ BLOCKED | Exact-object restore logic passes locally; no tested infrastructure-instance-loss/retention topology result exists. |
| OPS-04 | ✗ BLOCKED | The gate blocks correctly, but live certification is absent, the package approval gate is bypassable, and the public candidate verifier cannot promote a valid release bundle. |

### Prohibitions, Edges, and UI Contract

| Contract | Status | Evidence |
| --- | --- | --- |
| No durable queue, automatic retry, shortened receipt clock, or capacity hold on refusal | ✓ VERIFIED (deterministic) | Admission/refusal/replay tests and trusted receipt-first implementation pass. |
| No deterministic, fixture, blocked, or not-observed evidence may become a live pass | ✓ VERIFIED | Design evidence is permanently promotion-blocked; protected preflight and candidate verification exit nonzero. |
| Reconciliation never makes a replacement money/worker/signer/deployment/event effect | ✓ VERIFIED (deterministic) | D-122 fault and publication/reconciliation tests pass exact original-operation oracles. |
| Telemetry does not leak protected text, keys, payment material, paths, or unbounded labels | ✓ VERIFIED (deterministic) | Canary, unknown-attribute, cardinality, and exporter-failure tests pass. |
| No CVM napplet-protocol fork or signer authority expansion | ✓ VERIFIED (deterministic boundary) | Static/presentation/source-contract tests keep authority at the existing package/host boundaries. |
| Explicit human approval before SUS package installation | ✗ FAILED | The only audit state is `pending_human`; `--require-approved` nevertheless exits 0. |
| All UI considerations and 28 state projections | ✓ VERIFIED (projection) | State-matrix/copy/accessibility schema tests pass. |
| Real desktop/tablet/mobile compatible-host presentation, signer, focus/dialog/live-region behavior | ✗ FAILED | The UI contract itself says a pure projection is insufficient; no candidate-bound browser evidence passed. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Full workspace regression | `bun test --timeout 10000` | 483 pass, 0 fail, 4,130 assertions | ✓ PASS |
| Phase 7 deterministic evaluation | `bun run eval:phase07` | 64 passed; promotion blocked | ✓ PASS |
| Existing canonical evidence | `bun run verify:phase07-evidence -- --verify-existing` | offline passed; promotion blocked | ✓ PASS |
| Candidate release verification | `bun run candidate:verify -- --release-evidence evidence/design/phase-07.json` | `PROTECTED_LIVE_CERTIFICATION_REQUIRED`; exit 1 | ✓ PASS — correct fail-closed result |
| Protected preflight | `PHASE07_CERTIFICATION_EVIDENCE_DIRECTORY=<tmp> bun run certify:phase07 -- --profile=release --preflight-only` | 8 blocked suite records; exit 1 | ✓ PASS — correct fail-closed result |
| OTel approval enforcement | `bun run scripts/verify-phase-07-otel-packages.ts -- --require-approved` | returned passed while pointer says `pending_human` | ✗ FAIL |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `scripts/certify-phase-07.ts` | 79–95 | Inventory-only runner with `claims: []`, unconditional blocked exit, and no live adapter invocation | 🛑 BLOCKER | It truthfully records absence but cannot execute the Phase 7 live integration/certification work. |
| `src/promotion/candidate.ts` | 265–275 | Release-evidence CLI always returns blocked after reading deterministic evidence | 🛑 BLOCKER | A complete protected bundle cannot reach the sole promotion decision through the public release command. |
| `scripts/verify-phase-07-otel-packages.ts` | 123–129, 275 | “approved” checks a `pending_human` record | 🛑 BLOCKER | Recently published SUS packages can be installed without the required auditable human approval. |

No Phase 7 implementation debt marker (`TBD`, `FIXME`, or `XXX`) was found in the phase-owned source/test files. Existing untracked files predated this verification and were not changed.

### Human Verification Required After Blocker Closure

1. **Protected release certification**

   **Test:** Provision the declared release profile, credentials, images, topology, and selected candidate; run every protected suite.

   **Expected:** Fresh candidate-bound `passed` records cover Modal and Fly cohorts, ContextVM/CEP-8/Lightning/Cashu/model, Cloud Run/SQL/GCS/object restore, Collector, napplet conformance, compatible host/signers, CLI/upload, and owner/attestation relay operations.

   **Why human:** These are external systems and topology effects that local code checks cannot observe.

2. **Compatible-host browser evidence**

   **Test:** Run the exact sealed artifact in the compatible host at desktop, tablet, and mobile widths; exercise signing, dialog/focus/live-region, publication reconciliation, and blocked launch state.

   **Expected:** The strict 28-state presentation contract holds visually and accessibly; immutable browser evidence is bound to the candidate.

   **Why human:** No browser host/runtime or signer is available in this workspace.

### Gaps Summary

Four blocking concerns remain: required human package approval is not enforced; the protected runner cannot perform its claimed integration work; no protected live observation has passed; and the candidate CLI cannot feed complete release evidence into the sole promotion decision. The canonical blocked records are valuable evidence of this state and must remain blocked. They cannot be deferred: this is the final milestone phase and the roadmap has no later phase that owns these outcomes.

### Milestone Roll-up

- Phases 1–6 are complete/verified; Phase 7 is the current final phase and is not verified.
- v1.0 has **54 total requirements**: **49 completed** through Phases 1–6 and **5 blocked** in Phase 7 (`SESS-02`, `OPS-01`–`OPS-04`).
- Phase 1 deferrals remain unresolved in their live form: real sealed scaffold/Chromium closure and exhaustive provenance, reproducibility, hostile/mutation, golden, waiver, SBOM, and promotion evidence.
- Phase 6 deferrals remain unresolved: compatible host, external signer, promoted CLI asset, relay/publication, database/object/provider certification, plus its 10 advisory live-host UI/accessibility/responsive findings.

---

_Verified: 2026-08-05T18:49:27Z_  
_Verifier: the agent (gsd-verifier)_
