---
phase: 07-admission-slo-resilience-launch-safety
audit: security
status: OPEN_THREATS
asvs_level: 1
block_on: high
threats_total: 54
threats_closed: 53
threats_open: 0
audited: 2026-08-05
---

# Phase 07 Security Audit

## OPEN_THREATS

**Phase:** 07 — Admission SLO, Resilience & Launch Safety  
**Closed:** 53/54 | **Open:** 1/54<br>
**ASVS Level:** 1  
**Blocking threshold:** high

This is a mitigation audit of every declared `<threat_model>` row in Plans 07-00 through 07-10, re-audited after Plans 07-14 through 07-18 and review-fix commits `d9e7c25`, `6e97c23`, `850d68d`, `ba54962`, `e3217fb`, `83bd9e8`, `41bae15`, `769fcc0`, and `2806dd5`. It also rechecks the OTel approval renewal `e6714b6`. It is not a claim that protected live certification has passed. Missing protected build/Cosign/topology observations correctly produce finite nonzero blocked results. The public release-evidence path also fails closed without a root.

### Closed

| Plan | Threat ID | Category | Severity | Disposition | Evidence |
|---|---|---|---|---|---|
| 00 | T-07-W0-01 | Tampering/Elevation | high | mitigate | Closed registry and comparator-only evaluation: `src/certification/phase-07-reference-set.ts:20`; mutation tests: `tests/evals/phase-07-reference-set.test.ts:15`. |
| 00 | T-07-W0-02 | Spoofing/Repudiation | high | mitigate | Complete owned mapping validation: `src/certification/evidence.ts:89`; mapping tests: `tests/evals/phase-07-reference-set.test.ts:24`. |
| 00 | T-07-W0-03 | Information Disclosure | high | mitigate | Safe protected-preflight status boundary: `scripts/certify-phase-07.ts:11`; protected-output tests: `tests/phase-07/promotion-gate.test.ts:24`. |
| 00 | T-07-W0-04 | Elevation of Privilege | high | mitigate | CLIs default to blocked without protected evidence: `scripts/certify-phase-07.ts:11`; `tests/phase-07/promotion-gate.test.ts:24`. |
| 00 | T-07-SC | Tampering | high | mitigate | Wave-0 commits `44fcc20` and `53027e2` contain no package-root change; current roots are exact-pinned in `package.json:34`. |
| 01 | T-07-ADM-01 | Spoofing/Tampering | high | mitigate | Canonical invocation is computed after verified-envelope correlation and before receipt issuance: `src/contextvm/adapter.ts:255`; protected correlation binds canonical hash, principal, event, and RPC ID: `src/contextvm/adapter.ts:318`; receipt correlation is verified before any capacity/funding effect: `src/funding/funded-admission.ts:79`. Ordering and zero-effect mismatch tests: `tests/phase-07/admission-slo.test.ts:206`, `tests/phase-07/admission-slo.test.ts:231`. |
| 01 | T-07-ADM-02 | Tampering/DoS | high | mitigate | Durable coalesced claim and replay fence: `src/funding/funded-admission.ts:65`, `src/funding/funded-admission.ts:133`; concurrency coverage: `tests/phase-07/admission-slo.test.ts:170`. |
| 01 | T-07-ADM-03 | Information Disclosure | medium | mitigate | Strict internal port result schema and one explicit finite projection for notification and RPC: `src/contextvm/adapter.ts:54`, `src/contextvm/adapter.ts:272`; both-channel malicious-field and outcome tests: `tests/phase-07/admission-slo.test.ts:250`, `tests/phase-07/admission-slo.test.ts:270`. |
| 01 | T-07-ADM-04 | Elevation of Privilege | high | mitigate | Observation-only telemetry contract: `src/telemetry/contracts.ts:47`; exporter-failure effect oracle: `tests/phase-07/telemetry-policy.test.ts:65`. |
| 01 | T-07-SC | Tampering | high | mitigate | Plan-01 implementation commits `f6ba0ab` and `489b148` change no dependency root; full focused suite passes. |
| 02 | T-07-OTEL-01 | Spoofing/Tampering | high | mitigate | Exact version/integrity/repository verification: `scripts/verify-phase-07-otel-packages.ts:41`; mutation coverage: `tests/phase-07/otel-package-legitimacy.test.ts:99`. |
| 02 | T-07-OTEL-02 | Elevation of Privilege | high | mitigate | Tarball metadata-only intake and lifecycle-script rejection: `scripts/verify-phase-07-otel-packages.ts:17`, `scripts/verify-phase-07-otel-packages.ts:117`; tests: `tests/phase-07/otel-package-legitimacy.test.ts:109`. |
| 02 | T-07-OTEL-03 | Repudiation | medium | mitigate | Canonical content-addressed, exclusive evidence record: `scripts/verify-phase-07-otel-packages.ts:168`; repeat/mutation tests: `tests/phase-07/otel-package-legitimacy.test.ts:142`. |
| 02 | T-07-SC | Tampering | high | mitigate | Pending-human `SUS` gate is retained before root installation: `scripts/verify-phase-07-otel-packages.ts:76`; renewed approval remains bound to the original audit and exact package set: `scripts/verify-phase-07-otel-packages.ts:168`; tests: `tests/phase-07/otel-package-legitimacy.test.ts:155`. |
| 03 | T-07-CHK-01 | Spoofing/Tampering | high | mitigate | Approval verifier binds the exact approval digest and package set: `scripts/verify-phase-07-otel-packages.ts:168`, `scripts/verify-phase-07-otel-packages.ts:351`. |
| 03 | T-07-CHK-02 | Repudiation | medium | mitigate | Bounded approval schema and recorded limitation: `scripts/verify-phase-07-otel-packages.ts:69`, `scripts/verify-phase-07-otel-packages.ts:76`. |
| 03 | T-07-SC | Elevation of Privilege | high | mitigate | Root-pin installation is refused without approved evidence: `scripts/verify-phase-07-otel-packages.ts:351`; `bun run scripts/verify-phase-07-otel-packages.ts -- --verify-root-pins` passed. |
| 04 | T-07-TEL-01 | Information Disclosure | high | mitigate | Telemetry allowlist and forbidden-canary rejection: `src/telemetry/redaction.ts:39`; sink tests: `tests/phase-07/telemetry-policy.test.ts:37`. |
| 04 | T-07-TEL-02 | Denial of Service | high | mitigate | Finite attributes and computed cardinality bound: `src/telemetry/redaction.ts:56`; cardinality test: `tests/phase-07/telemetry-policy.test.ts:54`. |
| 04 | T-07-TEL-03 | Elevation of Privilege | high | mitigate | Observer-only port with bounded swallowed exporter failure: `src/telemetry/contracts.ts:47`, `src/telemetry/contracts.ts:82`; test: `tests/phase-07/telemetry-policy.test.ts:65`. |
| 04 | T-07-TEL-04 | Tampering/Repudiation | medium | mitigate | Digest-pinned Collector/root inputs and standalone verifier: `scripts/verify-phase-07-otel-packages.ts:204`, `scripts/verify-phase-07-otel-packages.ts:351`. |
| 04 | T-07-SC | Tampering | high | mitigate | Exact OTel roots: `package.json:35`; renewal is hard-pinned to its approval digest and current package/lock digests: `scripts/verify-phase-07-otel-packages.ts:168`, `:204`. Approved and root-pin modes passed. |
| 05 | T-07-WRK-01 | Spoofing/Tampering | high | mitigate | Exact session/lease/image/probe readiness checks: `src/worker-adapters/modal-worker.ts:248`; tests: `tests/phase-07/worker-adapters.test.ts:57`. |
| 05 | T-07-WRK-02 | Information Disclosure/Elevation | high | mitigate | Default-deny network, no inbound port, fixed command, and unconditional cleanup: `src/worker-adapters/modal-worker.ts:95`, `src/worker-adapters/modal-worker.ts:269`; isolation tests: `tests/phase-07/worker-adapters.test.ts:85`. |
| 05 | T-07-WRK-03 | DoS | high | mitigate | Bounded admission / zero-backlog sample gate: `src/admission/benchmark.ts:121`; negative cases: `tests/phase-07/worker-adapters.test.ts:111`. |
| 05 | T-07-WRK-04 | Repudiation/Tampering | high | mitigate | Candidate/input/freshness-bound benchmark evidence: `src/certification/evidence.ts:20`, `src/certification/evidence.ts:45`; tests: `tests/phase-07/certification-runner.test.ts:35`. |
| 05 | T-07-SC | Tampering | high | mitigate | Existing exact Modal pin is retained: `package.json:42`; injected Fly REST port has no added package: `src/worker-adapters/fly-worker.ts:35`. |
| 06 | T-07-REC-01 | Tampering/Elevation | high | mitigate | Fault injection is restricted to typed seams: `src/resilience/fault-harness.ts:188`; effect-counter tests: `tests/phase-07/fault-matrix.test.ts:54`. |
| 06 | T-07-REC-02 | Tampering/Repudiation | high | mitigate | Original-operation lookup and visible unknown/partial state: `src/model/reconciliation.ts:71`, `src/publication/publication-service.ts:94`; matrix tests: `tests/phase-07/fault-matrix.test.ts:80`. |
| 06 | T-07-REC-03 | DoS/Tampering | high | mitigate | Durable claim/version fence and bounded transaction retry: `src/model/reconciliation.ts:71`; parallel cases: `tests/phase-07/fault-matrix.test.ts:105`. |
| 06 | T-07-REC-04 | Information Disclosure | medium | mitigate | Typed finite schedule/evidence projections: `src/resilience/fault-harness.ts:188`; serialization canaries: `tests/phase-07/fault-matrix.test.ts:129`. |
| 06 | T-07-SC | Tampering | high | mitigate | Existing ports only; plan introduces no dependency root. Frozen focused suite passed: `bun test tests/phase-07 tests/evals/phase-07-reference-set.test.ts --timeout 10000`. |
| 07 | T-07-RST-01 | Spoofing/Tampering | high | mitigate | Generation/checksum/authenticated manifest and identity fences: `src/continuity/checkpoint-envelope.ts:70`, `src/continuity/continuation-service.ts:334`; mutation matrix: `tests/phase-07/restore-drill.test.ts:81`. |
| 07 | T-07-RST-02 | Elevation of Privilege | high | mitigate | Durable resume claim/lease and terminal fence: `src/continuity/continuation-service.ts:285`; concurrency test: `tests/phase-07/restore-drill.test.ts:106`. |
| 07 | T-07-RST-03 | Repudiation | high | mitigate | Candidate-bound claim schema rejects wider RTO/RPO claims: `src/resilience/fault-harness.ts:106`; test: `tests/phase-07/restore-drill.test.ts:124`. |
| 07 | T-07-RST-04 | Information Disclosure | high | mitigate | Object adapter excludes secret/path data and decrypts only through injected key port: `src/continuity/object-store-adapter.ts:30`; tests: `tests/phase-07/restore-drill.test.ts:150`. |
| 07 | T-07-SC | Tampering | high | mitigate | Storage/database adapters remain injected ports, with no new package root: `src/continuity/object-store-adapter.ts:30`. |
| 08 | T-07-UI-01 | Spoofing/Tampering | high | mitigate | Strict host presentation projection rejects unmapped iframe fields/messages: `src/host/presentation.ts:277`; tests: `tests/phase-07/host-presentation.test.ts:111`. |
| 08 | T-07-UI-02 | Elevation of Privilege | high | mitigate | One authorized action, duplicate guard, and query-only reconciliation: `src/host/presentation.ts:206`; guard tests: `tests/phase-07/host-presentation.test.ts:80`. |
| 08 | T-07-UI-03 | Information Disclosure | high | mitigate | Identifier/safe-copy allowlist: `src/host/presentation.ts:140`; canary tests: `tests/phase-07/host-presentation.test.ts:90`. |
| 08 | T-07-UI-04 | DoS | medium | mitigate | Deterministic bounded UI state is projected by the host: `src/host/presentation.ts:291`; contract tests: `tests/phase-07/host-presentation.test.ts:119`. |
| 08 | T-07-SC | Tampering | high | mitigate | UI uses no new runtime package; host/candidate identity is part of browser evidence: `src/certification/evidence.ts:45`. |
| 09 | T-07-EVL-01 | Tampering | high | mitigate | Runtime gets bounded input/schedule while expected values remain comparator-only: `src/certification/phase-07-reference-set.ts:201`; test: `tests/evals/phase-07-reference-set.test.ts:102`. |
| 09 | T-07-EVL-02 | Repudiation/Tampering | high | mitigate | Executed-ID complete mapping validator: `src/certification/evidence.ts:89`; mapping mutation tests: `tests/evals/phase-07-reference-set.test.ts:24`. |
| 09 | T-07-EVL-03 | Information Disclosure | high | mitigate | Protected/raw canaries are rejected before canonical evidence: `src/certification/evidence.ts:32`, `src/certification/evidence.ts:190`; redaction tests: `tests/evals/phase-07-reference-set.test.ts:113`. |
| 09 | T-07-EVL-04 | Spoofing | high | mitigate | Deterministic and protected-live evidence classes are separated: `src/certification/evidence.ts:71`, `src/certification/evidence.ts:107`; test: `tests/evals/phase-07-reference-set.test.ts:121`. |
| 09 | T-07-SC | Tampering | high | mitigate | The reproducibility command requires a digest-pinned root module under a protected directory and passes it to verification and record writing: `scripts/verify-phase-07-reproducibility.ts:8`, `:17`. Its concrete root re-hashes an exact non-symlinked archive before accepting its source measurement: `src/certification/trust.ts:52`, `:83`; configured, modified-source, and absent-root cases: `tests/phase-07/reproducibility.test.ts:98`. |
| 10 | T-07-PRO-01 | Spoofing/Tampering | high | mitigate | The protected release command owns operator configuration, loads the containment/digest-pinned root before reading release evidence, and passes it internally: `scripts/verify-phase-07-release.ts:7`, `:30`. Loader containment/symlink/digest checks: `src/certification/trust.ts:100`; a counterfeit candidate root is never loaded and cannot promote: `tests/phase-07/promotion-gate.test.ts:305`. |
| 10 | T-07-PRO-02 | Elevation of Privilege | high | mitigate | Closed waiver set, non-waivable classes, and sole atomic decision: `src/promotion/schema.ts:192`, `src/promotion/run-promotion.ts:92`; tests: `tests/phase-07/promotion-gate.test.ts:64`. |
| 10 | T-07-PRO-03 | Information Disclosure | high | mitigate | Protected runner accepts references and records safe observations: `src/promotion/candidate.ts:287`, `src/promotion/run-promotion.ts:34`; tests: `tests/phase-07/promotion-gate.test.ts:54`. |
| 10 | T-07-PRO-04 | Tampering/Repudiation | high | mitigate | Exact candidate-bound protected-live requirement and one observation per claim: `src/promotion/run-promotion.ts:80`; fake/insufficient claim tests: `tests/phase-07/promotion-gate.test.ts:76`. |
| 10 | T-07-PRO-05 | Tampering | high | mitigate | Reconciliation and publication both use original-operation fences: `src/model/reconciliation.ts:71`, `src/publication/publication-service.ts:94`; drill tests: `tests/phase-07/fault-matrix.test.ts:80`. |
| 10 | T-07-SC | Tampering | high | mitigate | Protected promotion derives the strict `{ version, sourceRevision, sourceSha256 }` measurement from the parsed manifest and verifies it with the pinned root before candidate evidence or evaluator authority: `src/promotion/candidate.ts:300`, `:302`. The sole evaluator independently compares a supplied measurement with that manifest-derived canonical fact before calling the root or consulting cache: `src/promotion/run-promotion.ts:78`, `:84`, `:152`, `:154`. The root re-hashes its non-symlinked protected archive and requires its pinned source revision/digest: `src/certification/trust.ts:71`, `:89`. Reproducibility records independently bind the same digest and exact release binding: `src/certification/reproducibility.ts:83`. Drift, omission, cache, recomputed-counterfeit, rootless-public, and two-archive substitution tests block; the substitution never invokes the root: `tests/phase-07/promotion-gate.test.ts:149`, `:166`, `:382`. |

### Open (blocking — severity ≥ high threshold)

None. Every high- or critical-severity declared threat is closed.

### Open (non-blocking — severity below high threshold)

| Plan | Threat ID | Category | Severity | Mitigation Expected | Evidence / Files Searched |
|---|---|---|---|---|---|
| 00 | T-07-W0-05 | Denial of Service | low | Authorized accepted-risk decision for the bounded Wave-0 test-discovery risk. | **Pending, not accepted.** `07-RISKS.md` explicitly records `pending_owner_acceptance`, scope, review trigger, and non-waiver limits. It correctly creates no risk authority: `.planning/phases/07-admission-slo-resilience-launch-safety/07-RISKS.md:3`. |

*Only blocking-open threats count toward `threats_open` in the SECURITY frontmatter gate.*

### Unregistered Flags

None. `## Threat Flags` was absent from every Phase-07 `*-SUMMARY.md` file, including Plans 07-14 through 07-18.

### Audit Commands

- `bun test tests/phase-07/promotion-gate.test.ts tests/phase-07/reproducibility.test.ts tests/phase-07/supply-chain.test.ts tests/phase-07/certification-runner.test.ts tests/phase-07/otel-package-legitimacy.test.ts --timeout 10000` — passed: 41 tests, 0 failures, 186 assertions.
- `bun test --timeout 10000` — passed: 518 tests, 0 failures, 4,299 assertions.
- `bun run scripts/verify-phase-07-otel-packages.ts -- --require-approved` — passed.
- `bun run scripts/verify-phase-07-otel-packages.ts -- --verify-root-pins` — passed.
- `bun run scripts/verify-phase-07-reproducibility.ts` and `bun run scripts/verify-phase-07-supply-chain.ts` — correctly blocked/nonzero without protected configuration.
- `bun run certify:phase07 -- --profile=release --preflight-only` — correctly blocked/nonzero without protected evidence.
- `bun run release:verify:protected -- --release-evidence evidence/design/phase-07.json` — correctly blocked/nonzero without protected configuration.
- `bun run candidate:verify -- --release-evidence evidence/design/phase-07.json` — correctly blocked/nonzero for invalid release input.

## Required Remediation

1. Obtain and record an explicit owner acceptance for T-07-W0-05, or change its threat disposition through the planning process. It remains non-blocking and does not waive any release, SLO, or security gate.

**threats_open:** 0
