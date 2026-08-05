---
phase: 07-admission-slo-resilience-launch-safety
verified: 2026-08-05T22:37:40Z
status: gaps_found
score: 95/103 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 95/103
  gaps_closed:
    - "The protected release command now owns a containment-checked, SHA-256-pinned operator trust-root module before reading release-bundle bytes."
    - "Candidate-supplied authority is ignored by the protected command; a freshly rehashed counterfeit bundle is rejected before evaluator/cache authority."
    - "Renewed OTel approval and smoke evidence now bind the current package and lockfile input digests; approved and root-pin gates pass."
    - "Promotion now derives a manifest-bound source measurement, authenticates it before evaluator/cache reuse, and blocks protected archive-byte drift."
    - "A source measurement for another valid archive under the same root is rejected against the canonical manifest before the root is queried."
  gaps_remaining:
    - "No fresh protected Modal/Fly readiness cohorts establish the five-second p95 claim."
    - "No candidate-bound Collector, topology, recovery, payment/model, host/signer/browser, or publication live observations have passed."
  regressions: []
gaps:
  - truth: "An accepted user request reaches an isolated ready worker within five seconds at p95, or immediately receives a retryable capacity response with no durable queue."
    status: failed
    reason: "Local admission/refusal semantics pass, but canonical evidence records worker_slo as not_observed for Modal and blocked for Fly. No selected-provider cohort meets the production sample, confidence, and zero-backlog gate."
    artifacts:
      - path: "evidence/design/22c6cd2b8e821f9ee155c00c0547395abb22acc7c7775a864e10fb2a01c79c66.json"
        issue: "Protected worker-readiness observations are non-pass only."
    missing:
      - "Fresh candidate-bound Modal and Fly benchmark records with the required 1,000 accepted / 200 forced cohorts, one-sided 95% p95 <= 5 seconds, and zero durable backlog."
  - truth: "Operators can measure lifecycle outcomes and production failures preserve committed money, sessions, artifacts, evidence, and publication effects."
    status: failed
    reason: "Telemetry, fault, restore, and original-operation behavior are deterministic-only. The current evidence records Collector, regional, SQL/object-store, payment/model, host/signer, upload, and relay dependencies as blocked or not_observed."
    artifacts:
      - path: "evidence/design/22c6cd2b8e821f9ee155c00c0547395abb22acc7c7775a864e10fb2a01c79c66.json"
        issue: "The immutable live-claim inventory has zero passed protected observations and promotionVerdict blocked."
    missing:
      - "Fresh protected observations for the declared release topology, Collector lifecycle export, original-operation recovery, checkpoint/object retention, payment/model reconciliation, and publication flows."
  - truth: "Protected live certification covers the required provider, topology, payment, host/browser, signer, CLI, upload, and relay claims before production promotion."
    status: failed
    reason: "The protected runner and trust-root paths are now locally wired and fail closed, but this workspace has no release profile, protected live adapter module, scoped credentials, or passed protected observations."
    artifacts:
      - path: "scripts/certify-phase-07.ts"
        issue: "Credential-free preflight emits eight blocked records; this correct fail-closed result is not live certification."
    missing:
      - "Provision the declared protected topology and adapters, run all suites, and retain one fresh exact-binding passed observation for each release claim."
---

# Phase 7: Admission SLO, Resilience & Launch Safety Verification Report

**Phase Goal:** The integrated service can honestly promise immediate-or-rejected work and preserve money, sessions, artifacts, and publication effects through production failures.
**Verified:** 2026-08-05T22:37:40Z
**Status:** gaps_found  
**Re-verification:** Yes — after cross-archive source-substitution fix `2806dd5`

## Goal Achievement

The local release-authority path is complete: the protected command owns a containment-checked, SHA-256-pinned root; candidate-supplied authority is ignored; a manifest-derived source measurement is authenticated before bundle evaluation and again before cache reuse; archive-byte drift blocks promotion; and another valid archive under the same root cannot be substituted because the measurement is compared with the canonical manifest before root lookup. The renewed OTel approval/root-pin chain remains green. The phase goal still cannot be claimed because the required protected-live production observations do not exist.

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Accepted work reaches a ready isolated worker within five seconds at p95, otherwise it is immediately refused without a durable queue. | ✗ FAILED | Deterministic admission tests pass, but Modal is `not_observed` and Fly `blocked`; no production-like cohort exists. |
| 2 | Operators can measure required lifecycle outcomes without protected-content leakage. | ✗ FAILED | Local telemetry policy passes, but no candidate-bound Collector/live lifecycle observation exists. |
| 3 | Production failures preserve committed progress and prevent duplicate money or public effects. | ✗ FAILED | Deterministic fault/restore behavior passes; regional/database/object-store/payment/publication drills have no protected passes. |
| 4 | Promotion is blocked until all pinned inputs and required evidence are available. | ✓ VERIFIED | The evaluator requires records and a trust root; canonical/public candidate inputs exit nonzero. |
| 5 | Delegated OTel approval is distinct from the pending audit, truthful about authority, and exact-package/digest-bound. | ✓ VERIFIED | Separate approval, exact digest binding, and mutation/CLI tests remain intact. |
| 6 | The protected runner invokes configured adapters safely and absent prerequisites remain immutable blockers. | ✓ VERIFIED | Digest-pinned loader, finite result schema, preflight no-invocation, and redaction pass. |
| 7 | Exact release input is validated and fed to the sole promotion evaluator. | ✓ VERIFIED | `verifyReleaseCertificationInput` validates explicit pointers and forwards its trust root to the evaluator. |
| 8 | Public candidate verification exits zero only for a promoted release decision. | ✓ VERIFIED | The public CLI has no trust root and correctly blocks rehashed/public content rather than manufacturing a pass. |
| 9 | Canonical ContextVM funded admission precedes receipt/lifecycle effects and all wire output is finite and owner-safe. | ✓ VERIFIED | Canonical invocation and forged-correlation tests remain green. |
| 10 | The bounded Wave-0 test-discovery risk cannot fabricate release authority. | ✓ VERIFIED | `07-RISKS.md` explicitly disclaims launch/release waivers. |
| 11 | Two protected builds prove exact candidate/source/lock/toolchain/dataset binding and identical artifact output. | ✓ VERIFIED | The configured CLI regression loads a SHA-256-pinned root, verifies archive bytes, emits a verified redacted record, and detects an archive-byte change. |
| 12 | Duplicate, stale, swapped, malformed, deterministic-only, wrong-input, divergent, source-substituted, or future-dated build records cannot promote. | ✓ VERIFIED | Exact-source checks and future timestamp rejection are covered by focused mutations. |
| 13 | Supply-chain verification uses a digest-pinned Cosign binary and closed argv, then binds signer, issuer, predicate, subject, SBOM, provenance, lock, and toolchain. | ✓ VERIFIED | Pinned executable/closed-command and identity/document mutation tests pass. |
| 14 | Redacted content-addressed reproducibility and supply-chain records expose strict later-boundary validators. | ✓ VERIFIED | Validators recompute semantic hashes, bind release policy/artifact/candidate, and reject future records. |
| 15 | The protected entrypoint and sole evaluator require both explicit verification records; generic passed claims cannot substitute. | ✓ VERIFIED | Explicit byte-pinned references, record validation, and evaluator binding remain enforced. |
| 16 | Credential-free preflight is no-effect blocked and does not claim live build/Cosign execution. | ✓ VERIFIED | Eight blocked records and exit 1, with no adapter invocation. |
| 17 | Trusted manifest/bindings carry independent exact source SHA-256 alongside Git revision. | ✓ VERIFIED | Closed schemas and binding propagation require both values. |
| 18 | Prefix, padding, caller-declared source identity, or untrusted source measurement cannot satisfy reproducibility. | ✓ VERIFIED | The root matches canonical reference plus digest and hashes the archive bytes at verification time. |
| 19 | Trusted manifest owns exact Cosign and CycloneDX generator policy. | ✓ VERIFIED | Strict policy fields are embedded in release bindings and later revalidated. |
| 20 | Supply-chain verification/revalidation compares facts to independent manifest policy. | ✓ VERIFIED | Self-selected/rehashed signer, issuer, SBOM, tool, and policy facts are rejected. |
| 21 | Future certification records and incomplete Git object IDs cannot satisfy a release. | ✓ VERIFIED | Reproducibility/supply records reject future timestamps; only exact 40/64-hex revisions parse. |
| 22 | The normal production promotion pipeline forwards a configured trust root to the sole evaluator, and a cached decision cannot bypass authentication. | ✓ VERIFIED | `runPromotionCandidateInner` passes `options.trustRoot`; evaluator authenticates all inputs before its material-input cache lookup; focused regression proves a changed manifest is blocked even after a promoted cache entry. |
| 23 | The protected release-promotion command loads and owns one containment-checked, SHA-256-pinned protected-certifier root from operator configuration. | ✓ VERIFIED | It validates absolute configuration, loads the module before bundle reads, and mutation tests reject missing, escaped, symlinked, non-file, drifted, missing-export, and incomplete roots. |
| 24 | Neither candidate input nor a public caller can inject or replace the root used by the protected command. | ✓ VERIFIED | The command ignores the candidate-root environment variable; a permissive module with a write side effect is not loaded while valid root promotion succeeds. |
| 25 | The loaded root authenticates the exact manifest, observations, records, and protected source measurement before the sole evaluator can promote or use cache. | ✓ VERIFIED | Candidate and normal promotion derive the measurement from manifest revision/SHA; evaluator compares it to the manifest before root lookup, fingerprints it, and both archive drift and cross-archive substitution block. |
| 26 | The public candidate verifier remains rootless and fail-closed; protected authority is exposed only by the explicit operator command. | ✓ VERIFIED | Rootless `candidate:verify` and unconfigured `release:verify:protected` both exit nonzero with finite blocked results. |

**Score:** 95/103 truths verified. All local implementation must-haves are verified; the eight remaining gaps are protected-live evidence only.

## Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/certification/trust.ts` | Trust-root contract, pinned protected-root loader, and source-archive byte verification. | ✓ VERIFIED | Loader rejects invalid paths/digests; the evaluator first binds the manifest-derived revision/SHA, then the root re-hashes its matching protected archive. |
| `src/certification/reproducibility.ts` | Source-byte measurement and exact source record verification. | ✓ VERIFIED | Requires authenticated measurements, exact source digest, complete revision references, and non-future timestamps. |
| `scripts/verify-phase-07-reproducibility.ts` | Protected reproducibility entrypoint. | ✓ VERIFIED | Requires three root configuration values, loads the SHA-256-pinned module, and passes its root to both verify and write operations. |
| `src/certification/supply-chain.ts` | Pinned Cosign/SBOM/in-toto verification with future-record rejection. | ✓ VERIFIED | Strict policy and `verifiedAtMs > nowMs` gate are substantive and covered. |
| `src/promotion/candidate.ts` | Public and protected release-bundle gate. | ✓ VERIFIED | Protected path derives and authenticates source measurement before bundle evidence, while the public CLI remains rootless. |
| `src/promotion/run-promotion.ts` | Production promotion pipeline. | ✓ VERIFIED | Forwards `options.trustRoot`; evaluator authenticates input before cache reuse. |
| `scripts/verify-phase-07-release.ts` | Operator-owned protected release composition. | ✓ VERIFIED | Pins and loads the root before candidate reads; downstream protected bundle verification now re-hashes the manifest-bound source archive. |
| `scripts/verify-phase-07-otel-packages.ts` + renewed evidence | OTel delegated approval and exact root-pin gate. | ✓ VERIFIED | Current approval `09594…e6cc7c` and smoke bind the current package/lock digests; approval and root-pin commands pass. |

## Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `verifyReleaseCertificationInput` | `evaluateReleaseCertification` | explicit records + `trustRoot` | ✓ WIRED | Candidate verifier pre-checks and forwards the same root. |
| `runPromotionCandidateInner` | `evaluateReleaseCertification` | `options.trustRoot` | ✓ WIRED | Call passes candidate ID, authority clock, records, and the configured root. |
| `evaluateReleaseCertification` | terminal decision cache | bind source measurement to manifest, then authenticate it with root before key lookup | ✓ WIRED | Canonical manifest comparison and root authentication precede `releaseDecisions.get`; key includes the measurement. |
| protected release command/evaluator | `verifySourceMeasurement` | manifest-bound operator root source-archive authentication | ✓ WIRED | Candidate and normal promotion pass the manifest-derived measurement; archive drift and another root-pinned archive's measurement both block before evaluator/cache authority. |
| `scripts/verify-phase-07-release.ts` | `loadPinnedReleaseCertificationTrustRoot` | explicit operator configuration loads the pinned root before bundle reads | ✓ WIRED | Root/module/digest configuration is required and validated first. |
| `scripts/verify-phase-07-release.ts` | `verifyReleaseCertificationBundle` | internally loaded root only | ✓ WIRED | Candidate data supplies no authority; counterfeit predicate module was not loaded. |
| `scripts/verify-phase-07-reproducibility.ts` | `loadPinnedReleaseCertificationTrustRoot` | absolute protected root/module + SHA-256 pin | ✓ WIRED | Missing configuration produces `protected_configuration_unavailable`; configured test produces verified output. |
| `verifyReproducibilityRecord` | `ReleaseCertificationTrustRoot` | `verifySourceMeasurement` | ✓ WIRED | Both build measurements must authenticate before a record is assembled. |
| release binding | future-record validators | trusted `nowMs` comparison | ✓ WIRED | Both reproducibility and supply-chain records reject timestamps later than the authority clock. |

## Data-Flow Trace

| Flow | Source | Consumer | Status |
| --- | --- | --- | --- |
| Public release evidence | Candidate bundle | Candidate parser → trust-root gate → evaluator | ✓ FLOWING, fail-closed |
| Protected source measurement at record creation | Build records + digest-pinned module + immutable archive | Reproducibility CLI → root byte hash → redacted record | ✓ FLOWING |
| Protected source measurement at promotion | Manifest-derived revision/SHA + operator root archive | Protected release command → manifest binding → root re-hash → evaluator/cache | ✓ FLOWING — archive drift, counterfeit recomputation, and cross-archive substitution block. |
| Protected promotion | `RunPromotionOptions.trustRoot` | `runPromotionCandidateInner` → evaluator authentication → material-input cache → decision | ✓ FLOWING |
| Certification record freshness | Persisted completion/verification timestamps | validators → runner/evaluator | ✓ FLOWING — future dates rejected |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Trust-root, archive-drift/counterfeit/cross-archive composition, reproducibility, supply-chain, runner, OTel, and normal promotion tracer checks | `bun test tests/phase-07/promotion-gate.test.ts tests/phase-07/reproducibility.test.ts tests/phase-07/supply-chain.test.ts tests/phase-07/certification-runner.test.ts tests/phase-07/otel-package-legitimacy.test.ts tests/tracer.test.ts --timeout 10000` | 48 pass, 0 fail | ✓ PASS — source measurement is manifest-bound and authenticated before cache/evaluator |
| Renewed OTel approval and exact root pins | `bun run scripts/verify-phase-07-otel-packages.ts -- --require-approved`; `bun run scripts/verify-phase-07-otel-packages.ts -- --verify-root-pins` | Both passed with approval `09594…e6cc7c`, audit `d7fed…f22b3` | ✓ PASS |
| Full workspace regression | `bun test --timeout 10000` | 518 pass, 0 fail, 4,299 assertions | ✓ PASS |
| Deterministic Phase 7 evidence | `bun run eval:phase07`; `bun run verify:phase07-evidence -- --verify-existing` | 64 deterministic cases passed; promotion remains blocked | ✓ PASS |
| Credential-free protected preflight | `PHASE07_CERTIFICATION_EVIDENCE_DIRECTORY=$(mktemp -d) bun run certify:phase07 -- --profile=release --preflight-only` | Eight blocked records; exit 1 | ✓ PASS — correct fail-closed result |
| Public canonical candidate input | `bun run candidate:verify -- --release-evidence evidence/design/phase-07.json` | `RELEASE_INPUT_INVALID`; exit 1 | ✓ PASS — no unauthenticated promotion |
| Unconfigured protected release command | `bun run release:verify:protected -- --release-evidence evidence/design/phase-07.json` | `protected_configuration_unavailable`; exit 1 | ✓ PASS — no accidental fallback authority |

## Requirements Coverage

| Requirement | Status | Actual evidence |
| --- | --- | --- |
| SESS-02 | ✗ BLOCKED | Correct deterministic immediate/refusal semantics, but no protected Modal/Fly receipt-to-ready p95 cohort. |
| OPS-01 | ✗ BLOCKED | Strict finite/redacted telemetry exists; no candidate-bound Collector observation passed. |
| OPS-02 | ✗ BLOCKED | Deterministic original-operation fault matrix passes; no protected failure drill passed. |
| OPS-03 | ✗ BLOCKED | Exact-object restore logic passes; no protected infrastructure-loss/retention observation passed. |
| OPS-04 | ✗ BLOCKED | Local certification, operator-root, source-byte, and OTel controls are wired; the required protected-live inventory remains non-pass. |

## Prohibitions and Anti-Patterns

| Contract / file | Status | Evidence |
| --- | --- | --- |
| Candidate-owned content must not self-authenticate a release | ✓ VERIFIED | Manifest, records, and observations require independent trust-root approval. |
| Cache must not bypass release-certifier authority | ✓ VERIFIED | Authentication runs on every call before cache lookup; mutation test blocks a changed manifest after a promoted cache entry. |
| Protected promotion must authenticate the manifest's source bytes, not another valid root-pinned archive | ✓ VERIFIED | Manifest comparison occurs before root lookup; archive drift, counterfeit recomputation, and cross-archive substitution all block. |
| Future records must not extend freshness | ✓ VERIFIED | Both record validators reject authority-clock future timestamps. |
| Source revision must be a complete Git object ID | ✓ VERIFIED | Only 40- or 64-hex IDs parse. |
| OTel approval/root pins must not drift from current package/lock inputs | ✓ VERIFIED | Renewed immutable approval and smoke evidence pass the approval and root-pin verifier. |
| Phase-owned implementation debt markers | ✓ VERIFIED | No unreferenced `TBD`, `FIXME`, or `XXX` found in review-fix files. |

## Escalation Gate

### Required external certification

1. Provision the release profile, trusted adapter root/module/digest, scoped credentials, and operator/certifier trust-root implementation. Run every protected suite against Modal and Fly, ContextVM/CEP-8/Lightning/Cashu/model, Cloud Run/SQL/GCS, Collector, compatible host/signers, CLI/upload, and owner/attestation relays.
2. Retain fresh, candidate-bound, exact-release-binding passed records for every closed release claim. Modal/Fly selection additionally needs the roadmap's cohort, confidence, and zero-backlog evidence.
3. Run the sealed artifact in the compatible host at desktop, tablet, and mobile widths; exercise signer, focus/dialog/live-region, publication reconciliation, and blocked-launch states.

## Gaps Summary

Commits `769fcc0` and `2806dd5` close the final local promotion gaps. The source measurement is manifest-derived, compared to the canonical manifest before root lookup, authenticated through the loaded root before bundle processing and cache lookup, and fingerprinted with the decision. Archive-byte drift, counterfeit recomputation, and substitution of a second valid root-pinned archive all block. The operator-root/counterfeit protections and renewed OTel approval/root-pin chain remain green. No local implementation gap remains. Protected-live SLO, topology, recovery, payment/model, host, signer, Collector, and publication evidence are still absent. The observed blocked preflight is correct safety behavior, not evidence of production readiness.

## Milestone Roll-up

- Phase 7 is the final v1.0 phase; no later roadmap phase owns these gaps, so nothing is deferred.
- v1.0 has 54 requirements: 49 complete through Phases 1–6 and 5 blocked in Phase 7 (`SESS-02`, `OPS-01`–`OPS-04`).
- The next checkpoint is protected-live certification.

---

_Verified: 2026-08-05T22:37:40Z_
_Verifier: the agent (gsd-verifier)_
