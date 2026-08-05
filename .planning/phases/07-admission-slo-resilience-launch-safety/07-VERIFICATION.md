---
phase: 07-admission-slo-resilience-launch-safety
verified: 2026-08-05T20:51:31Z
status: gaps_found
score: 84/93 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 70/78
  gaps_closed:
    - "Funded admission now derives one canonical invocation before lifecycle/receipt effects, authenticates correlation before capacity or funding effects, and projects all outcomes through one owner-safe finite wire shape."
    - "The protected runner and the sole evaluator now require explicit, byte-pinned reproducibility and supply-chain record references; generic adapter claims cannot replace them."
    - "The public candidate verifier exits zero exactly when the sole evaluator returns promoted, with real on-disk subprocess coverage."
  gaps_remaining:
    - "Reproducibility rejects normal SHA-256 source identities because it compares them with a Git revision by prefix rather than a defined exact binding."
    - "No fresh protected Modal/Fly readiness cohorts establish the five-second p95 claim."
    - "No candidate-bound Collector, topology, recovery, payment/model, host/signer/browser, or publication live observations have passed."
  regressions: []
gaps:
  - truth: "Reproducibility requires exactly two protected records with distinct isolation/run identities, exact candidate/source/lock/toolchain/dataset bindings, and identical expected artifact output."
    status: failed
    reason: "The verifier requires sourceSha256.startsWith(releaseBinding.sourceRevision). The repository uses a 40-hex Git revision and sourceSha256 is a distinct 64-hex digest, so a normal exact source digest is rejected. The passing fixture masks this by padding the revision to create an artificial digest prefix."
    artifacts:
      - path: "src/certification/reproducibility.ts"
        issue: "Line 18 compares incompatible source identities by prefix."
      - path: "tests/phase-07/reproducibility.test.ts"
        issue: "Line 20 fabricates sourceSha256 with sourceRevision.padEnd(64, 'a'), so it cannot detect the production identity mismatch."
    missing:
      - "Define one exact source-binding representation (for example a separately pinned source tree SHA-256 or an explicit revision-to-source-digest proof) and compare it deterministically."
      - "Add a non-patterned source-revision/source-digest positive case and a mismatch mutation case."
  - truth: "An accepted user request reaches an isolated ready worker within five seconds at p95, or immediately receives a retryable capacity response with no durable queue."
    status: failed
    reason: "Local admission/refusal semantics pass, but canonical evidence records worker_slo as not_observed for Modal and blocked for Fly. No selected-provider cohort meets the production sample, confidence, and zero-backlog gate."
    artifacts:
      - path: "evidence/design/22c6cd2b8e821f9ee155c00c0547395abb22acc7c7775a864e10fb2a01c79c66.json"
        issue: "Protected worker readiness observations are non-pass only."
    missing:
      - "Fresh candidate-bound Modal and Fly benchmark records with the required 1,000 accepted / 200 forced cohorts, one-sided 95% p95 <= 5 seconds, and zero durable backlog."
  - truth: "Operators can measure lifecycle outcomes and production failures preserve committed money, sessions, artifacts, evidence, and publication effects."
    status: failed
    reason: "Telemetry, fault, restore, and original-operation behavior are deterministic-only. The current evidence explicitly records Collector, regional, SQL/object-store, payment/model, host/signer, upload, and relay dependencies as blocked or not_observed."
    artifacts:
      - path: "evidence/design/22c6cd2b8e821f9ee155c00c0547395abb22acc7c7775a864e10fb2a01c79c66.json"
        issue: "The immutable live-claim inventory has 0 passed protected observations and promotionVerdict blocked."
    missing:
      - "Fresh protected observations for the declared release topology, Collector lifecycle export, original-operation recovery, checkpoint/object retention, payment/model reconciliation, and publication flows."
  - truth: "Protected live certification covers the required provider, topology, payment, host/browser, signer, CLI, upload, and relay claims before production promotion."
    status: failed
    reason: "The protected runner safely dispatches configured adapters and blocks missing prerequisites, but this workspace has no release profile, trusted live adapter module, scoped credentials, or passed protected observations."
    artifacts:
      - path: "scripts/certify-phase-07.ts"
        issue: "Credential-free preflight emitted eight blocked records; this correct fail-closed result is not live certification."
    missing:
      - "Provision the declared protected topology and adapters, run all suites, and retain one fresh exact-binding passed observation for each release claim."
---

# Phase 7: Admission SLO, Resilience & Launch Safety Verification Report

**Phase Goal:** The integrated service can honestly promise immediate-or-rejected work and preserve money, sessions, artifacts, and publication effects through production failures.
**Verified:** 2026-08-05T20:51:31Z
**Status:** gaps_found  
**Re-verification:** Yes — after Plans 07-14 through 07-16

## Goal Achievement

The canonical admission boundary, owner-safe wire projection, protected-record entrypoints, supply-chain verifier, and sole evaluator are substantive and wired. The Phase 7 goal is nevertheless unachieved for two independently observable reasons: reproducibility source binding rejects normal source evidence locally, and no protected production observation establishes the roadmap SLO or continuity claims.

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Accepted work reaches a ready isolated worker within five seconds at p95, otherwise it is immediately refused without a durable queue. | ✗ FAILED | Deterministic admission tests pass, but canonical evidence reports Modal `worker_slo` `not_observed` and Fly `blocked`; neither production-like cohort exists. |
| 2 | Operators can measure required lifecycle outcomes without protected-content leakage. | ✗ FAILED | Telemetry policy and package smoke gates pass locally, but no candidate-bound Collector/live lifecycle observation has passed. |
| 3 | Production failures preserve committed progress and prevent duplicate money or public effects. | ✗ FAILED | Fault/restore/original-operation tests pass deterministically; regional, database, object-store, payment/model, and publication drills have no protected passes. |
| 4 | Promotion is blocked until all pinned inputs and required evidence, including five-second-p95 load evidence, are available. | ✓ VERIFIED | `evaluateReleaseCertification` rejects missing, stale, replaced, wrong-candidate, wrong-binding, generic, and non-pass evidence; current deterministic pointer exits nonzero. |
| 5 | Delegated OTel approval is distinct from the pending audit, truthful about its authority, exact-package/digest-bound, and shared by approval-dependent paths. | ✓ VERIFIED | Approval record is `approved_operator` / `delegated_operator`, binds audit `d7fed…22b3` and six-package digest `7daf…40f2`; all seven mutation/CLI tests pass. |
| 6 | The protected runner invokes configured adapters safely and absent prerequisites remain immutable blockers. | ✓ VERIFIED | Digest-pinned root-contained loader, finite result schema, preflight no-invocation, one-call dispatch, error redaction, and failed/blocked/not_observed spot-checks pass. |
| 7 | Exact release input is validated and fed to the sole promotion evaluator. | ✓ VERIFIED | `verifyReleaseCertificationInput` strictly parses explicit pointers, reloads records, and calls `evaluateReleaseCertification` exactly once. |
| 8 | Public candidate verification exits zero only for a promoted release decision. | ✓ VERIFIED | A real subprocess creates an exact relative-path bundle, receives `status: promoted` with exit 0, then receives nonzero after candidate substitution. |
| 9 | Canonical ContextVM funded admission precedes receipt/lifecycle effects and all wire output is finite and owner-safe. | ✓ VERIFIED | The adapter calls `canonicalInvocation` before receipt issue/admission; forged correlation is rejected before capacity/funding effects; both response paths share the finite projection. |
| 10 | The bounded Wave-0 test-discovery risk remains pending explicit owner acceptance and cannot fabricate release authority. | ✓ VERIFIED | `07-RISKS.md` is `pending_owner_acceptance`, requires an owner review, and expressly disclaims any waiver of live certification, SLO, security, ledger, or release gates. |
| 11 | Two protected builds can prove exact candidate/source/lock/toolchain/dataset binding and identical artifact output. | ✗ FAILED | Distinct identities/output/freshness are checked, but valid Git SHA-1 revision plus independently computed SHA-256 source digest fails the source-prefix test. |
| 12 | Duplicate, stale, swapped, malformed, deterministic-only, wrong-input, or divergent build records cannot promote. | ✓ VERIFIED | Strict schemas, identity/output/freshness checks, and focused mutation cases reject each listed bypass class. |
| 13 | Supply-chain verification uses a digest-pinned Cosign binary and closed argv, then binds signer, issuer, predicate, subject, SBOM, provenance, lock, and toolchain. | ✓ VERIFIED | `verifySupplyChainCertification` hashes the executable before one internally constructed command; focused tests reject tool/argv/result/identity/document mutations. |
| 14 | Redacted content-addressed reproducibility and supply-chain records expose strict later-boundary validators. | ✓ VERIFIED | Both record schemas recompute semantic digests and content-addressed paths; runner and evaluator validate candidate, binding, artifact, and freshness rather than trusting digest-shaped input. |
| 15 | The protected entrypoint and sole evaluator require both explicit verification records; generic passed claims cannot substitute. | ✓ VERIFIED | Profile references are byte-pinned and no-glob; runner validates before supply-chain adapter invocation; evaluator reloads, revalidates, and compares both digests with the supply observation. |
| 16 | Credential-free preflight is no-effect blocked and does not claim live build/Cosign execution. | ✓ VERIFIED | Fresh preflight emitted eight blocked records and exit 1 without configured credentials/adapters; no protected pass was generated. |

**Score:** 84/93 truths verified. The prior 78 truth set is carried forward; Plans 07-14, 07-15, and 07-16 add 4, 6, and 5 truths respectively. One new local reproducibility failure and eight protected-live evidence failures remain.

## Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/contextvm/adapter.ts` | Canonical invocation/correlation before funded admission and finite wire projection. | ✓ VERIFIED | Canonical invocation → lifecycle digest → signed receipt → admission ordering is covered; response and notification derive from the same whitelisted object. |
| `src/funding/admission-receipt.ts` + `src/funding/funded-admission.ts` | Receipt authenticity/correlation enforced before effects. | ✓ VERIFIED | Receipt verification receives the lifecycle correlation before capacity/account mutations. |
| `07-RISKS.md` | Bounded pending risk record. | ✓ VERIFIED | Owner decision remains explicitly pending and cannot grant authority. |
| `src/certification/reproducibility.ts` | Strict two-isolation reproducibility verification. | ✗ FAILED | All non-source controls are substantive, but `sourceSha256.startsWith(sourceRevision)` makes normal source bindings impossible with SHA-1 Git revisions. |
| `src/certification/supply-chain.ts` | Pinned Cosign, CycloneDX, and in-toto verification. | ✓ VERIFIED | Closed command construction, executable hash, strict document parsing, and redacted semantic record are wired and mutation-tested. |
| `src/certification/adapters.ts` + `src/certification/runner.ts` | Explicit byte-pinned record loading before supply-chain claims. | ✓ VERIFIED | Containment, regular-file/no-symlink/raw-byte digest check → record validators → adapter → observation digest binding. |
| `scripts/certify-phase-07.ts` | Explicit protected profile/reference entrypoint. | ✓ VERIFIED | It maps only profile-specified paths/digests to references; absent configuration is blocked and preflight invokes no adapter. |
| `src/promotion/run-promotion.ts` + `src/promotion/candidate.ts` | Sole evaluator with record revalidation and public exit mapping. | ✓ VERIFIED | Explicit release pointers reload records; evaluator compares semantic digests against the supply-chain observation and only `promoted` maps to exit 0. |

## Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `ContextVmAdapter` | `FundedAdmissionService` | canonical invocation → lifecycle correlation → receipt → `admit` | ✓ WIRED | Focused test proves ordered single canonical call and rejects forged correlation before effects. |
| `scripts/verify-phase-07-supply-chain.ts` | `src/certification/supply-chain.ts` | `verifySupplyChainCertification` | ✓ WIRED | Script calls the strict verifier; source and focused tests cover the result contract. |
| `scripts/certify-phase-07.ts` | `src/certification/runner.ts` | explicit `reproducibilityEvidence` / `supplyChainEvidence` references | ✓ WIRED | No directory discovery is present; loader checks raw-byte digests before validation. |
| `src/promotion/candidate.ts` | `src/promotion/run-promotion.ts` | explicit record pointers → `evaluateReleaseCertification` | ✓ WIRED | Candidate parser requires both pointers and evaluator independently revalidates their contents. |

## Data-Flow Trace

| Flow | Source | Consumer | Status |
| --- | --- | --- | --- |
| Funded admission identity | SDK-verified canonical invocation/event/principal/RPC request | Lifecycle digest → signed receipt → admission → whitelisted RPC/notification result | ✓ FLOWING |
| Source reproducibility | Protected build observations | `verifyReproducibilityRecord` | ✗ BLOCKED LOCALLY — source SHA-256 is incorrectly required to begin with a Git revision. |
| Supply-chain attestation | Exact Cosign bytes + strict DSSE/SBOM/provenance input | Redacted supply-chain record → runner → observation digest → sole evaluator | ✓ FLOWING, fail-closed |
| Protected certification | Explicit profile-bound record files/digests | Contained loader → validator → supply-chain adapter → finite observation | ✓ FLOWING when configured; local preflight correctly blocks before invocation |
| Candidate promotion | Exact release bundle + explicit observation/record pointers | Candidate loader → sole evaluator → CLI terminal code | ✓ FLOWING; on-disk promoted fixture exits 0 and substituted input exits nonzero |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Canonical admission/wire boundary | `bun test tests/phase-07/admission-slo.test.ts --test-name-pattern='canonical|forged|wire|receipt|replay' --timeout 10000` | 9 pass, 0 fail | ✓ PASS |
| Reproducibility, supply chain, runner, and evaluator mutations | `bun test tests/phase-07/reproducibility.test.ts tests/phase-07/supply-chain.test.ts tests/phase-07/certification-runner.test.ts tests/phase-07/promotion-gate.test.ts --timeout 10000` | 22 pass, 0 fail | ✓ PASS |
| Non-fixture source identity | Inline `verifyReproducibilityRecord` using repository 40-hex Git revision plus independent valid 64-hex source digest | Rejected twice with `build source does not bind the release revision` | ✗ FAIL |
| Full workspace regression | `bun test --timeout 10000` | 506 pass, 0 fail, 4,237 assertions | ✓ PASS |
| Deterministic Phase 7 evidence | `bun run eval:phase07`; `bun run verify:phase07-evidence -- --verify-existing` | 64 deterministic cases passed; promotion remains blocked | ✓ PASS |
| Credential-free protected preflight | `PHASE07_CERTIFICATION_EVIDENCE_DIRECTORY=/tmp/napplet-cvm-phase07-verify-20260805 bun run certify:phase07 -- --profile=release --preflight-only` | Eight blocked records; exit 1 | ✓ PASS — correct fail-closed result |
| Current release evidence | `bun run candidate:verify -- --release-evidence evidence/design/phase-07.json` | `RELEASE_INPUT_INVALID`; exit 1 | ✓ PASS — deterministic pointer alone cannot promote |

## Requirements Coverage

| Requirement | Status | Actual evidence |
| --- | --- | --- |
| SESS-02 | ✗ BLOCKED | Correct deterministic immediate/refusal semantics, but no passed protected Modal/Fly receipt-to-ready p95 cohort. |
| OPS-01 | ✗ BLOCKED | Strict finite/redacted telemetry and approved package gate are verified; no candidate-bound Collector lifecycle observation is passed. |
| OPS-02 | ✗ BLOCKED | Deterministic original-operation fault matrix passes; no protected regional/database/worker/payment/publication failure drill passed. |
| OPS-03 | ✗ BLOCKED | Exact-object restore logic passes; no infrastructure-instance-loss/retention topology observation passed. |
| OPS-04 | ✗ BLOCKED | Promotion is fail-closed and record binding is wired, but reproducibility cannot validate normal exact source evidence and no live claim inventory exists. |

## Prohibitions and Anti-Patterns

| Contract / file | Status | Evidence |
| --- | --- | --- |
| Pending audit must not become approval authority | ✓ VERIFIED | Separate approval schema accepts only `approved_operator`; pending/rejected/mutated states fail before approval-dependent CLI modes. |
| Funded-admission ports must not define canonical identity or leak provider details | ✓ VERIFIED | Adapter computes canonical identity itself and projects all result channels from the same strict object. |
| W0 risk must not silently waive authority | ✓ VERIFIED | `07-RISKS.md` explicitly disclaims every launch/release waiver. |
| Fixtures/fake adapters must not become protected-live certification | ✓ VERIFIED | Registry controls evidence class; fixture tests remain deterministic and preflight emits non-pass records. |
| Adapter paths, symlinks, non-files, traversal, and digest drift must fail pre-import | ✓ VERIFIED | Loader and focused rejection tests cover these boundaries. |
| Raw build/Cosign/SBOM/provenance output must not persist in observations | ✓ VERIFIED | Only finite digest-bound fields are persisted; secret-bearing adapter output is reduced to finite failure. |
| Phase-owned implementation debt markers | ✓ VERIFIED | No unreferenced `TBD`, `FIXME`, or `XXX` found in scanned Phase 7 source and test files. |
| Source binding must prove the source actually built | ✗ FAILED | The prefix comparison is neither an exact identity binding nor compatible with SHA-1 Git revisions and independent SHA-256 content identities. |

## Escalation Gate

### Local repair required before protected certification

**Test:** Supply two distinct protected-build records using the real 40-hex source revision and its independently computed 64-hex source digest.

**Expected:** The verifier accepts the records only when the source identity has an explicitly defined exact relationship to the release revision, and rejects a changed source digest.

**Why:** Current code rejects the valid form before any live build can become a reproducibility record. This is a local implementation blocker, not an external-environment limitation.

### Required external certification after local repair

1. Provision the release profile, canonical trusted adapter root/module/digest, and scoped credential reference. Run each protected suite against Modal and Fly, ContextVM/CEP-8/Lightning/Cashu/model, Cloud Run/SQL/GCS, Collector, compatible host/signers, CLI/upload, and owner/attestation relays.
2. Retain fresh, candidate-bound, exact-release-binding passed records for every closed release claim. Modal/Fly selection additionally needs the roadmap's cohort, confidence, and zero-backlog evidence.
3. Run the sealed artifact in the compatible host at desktop, tablet, and mobile widths; exercise signer, focus/dialog/live-region, publication reconciliation, and blocked-launch states. Existing projection tests do not establish this browser/runtime result.

## Gaps Summary

Plans 07-14 and 07-16 closed real local authority gaps: canonical admission is now bound before effects, wire output is owner-safe, and both protected-certification and promotion entrypoints demand explicit revalidated records. Plan 07-15's supply-chain controls are also substantive. However, its reproducibility source check uses a prefix relation between two incompatible identities and its passing fixture fabricates that relation. Therefore **one local implementation gap remains**. Separately, current protected records are correctly blocked/not-observed; they cannot establish the production SLO, topology, continuity, payment, host/browser, or publication claims.

## Milestone Roll-up

- Phase 7 is the final v1.0 phase; no later roadmap phase owns these gaps, so nothing is deferred.
- v1.0 has 54 requirements: 49 complete through Phases 1–6 and 5 blocked in Phase 7 (`SESS-02`, `OPS-01`–`OPS-04`).
- Phase 1's live launch-hardening closure and Phase 6's compatible-host/external integration deferrals remain blocked until protected evidence exists.
- The next checkpoint is to correct reproducibility source binding, re-run this verification, then enter the protected certification environment and retain exact fresh passed observations.

---

_Verified: 2026-08-05T20:51:31Z_
_Verifier: the agent (gsd-verifier)_
