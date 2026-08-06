# Phase 7 Multi-Source Coverage Audit

**Audit mode:** Gap closure after 07-VERIFICATION.md and live-path debug findings  
**Plan set:** Existing 07-00–07-39 plus append-only correction 07-40–07-44; checkpoint 07-20; run-only 07-26
**Result:** COMPLETE — no unplanned in-scope source item

## GOAL coverage

| Source item | Required outcome | Covering plans | Status |
|---|---|---|---|
| GOAL-07 | The integrated service honestly provides immediate-or-rejected work and preserves money, sessions, artifacts, and publication effects through production failures. | 07-40–07-44, authorization 07-20, run-only 07-26 | COVERED |
| GOAL-07-A | Production composition must exist before the authorization checkpoint is actionable. | 07-40–07-44; 07-20 depends on 07-44 | COVERED |
| GOAL-07-B | The live run performs no implementation work and only executes the already-complete controller. | 07-44, 07-20, 07-26 | COVERED |

## REQ coverage

| Requirement | Observable edge | Covering plans | Status |
|---|---|---|---|
| SESS-02 | Concurrent accepted requests reach exact isolated-ready within five seconds p95 under the required confidence/cohort schedule, otherwise immediate retryable refusal; zero backlog. | 07-41, 07-43, 07-44, 07-26 | COVERED |
| OPS-01 | Concurrent lifecycle telemetry spans admission, generation, payment, checkpoint/resume, validation, and publication without secrets. | 07-41–07-44, 07-26 | COVERED |
| OPS-02 | Regional/provider failures, timeouts, and duplicate delivery preserve single writer and prevent duplicate money/events through original-operation reconciliation. | 07-40–07-44, 07-26 | COVERED |
| OPS-03 | Checkpoints, artifacts, evidence, receipts, attestations, and every D-125 durability subject restore exactly after local/instance loss. | 07-41, 07-43–07-44, 07-26 | COVERED |
| OPS-04 | Promotion requires pinned supply chain, SBOM/provenance, hostile tests, payment/publication reconciliation, and five-second p95 evidence through the sole evaluator. | 07-40–07-44, 07-26 | COVERED |

## RESEARCH coverage

| Research item | Constraint/feature | Covering plans | Status |
|---|---|---|---|
| R-01 | Receipt-to-exact-ready clock and immediate refusal with no durable generation queue. | 07-41, 07-43–07-44 | COVERED |
| R-02 | Modal primary candidate and Fly non-AWS fallback receive identical production-like benchmarks; selection is measured. | 07-41, 07-43 | COVERED |
| R-03 | Cloud Run is a warm multi-region control plane, not an untrusted build worker. | 07-41, 07-43 | COVERED |
| R-04 | Cloud SQL PostgreSQL is the sole database authority; serializable/HA claims match observed topology. | 07-41, 07-43 | COVERED |
| R-05 | GCS versioning/checksums/generations back durable content-addressed subjects and exact restoration. | 07-41, 07-43 | COVERED |
| R-06 | Versioned OpenTelemetry vocabulary, concurrent queries, quantitative evidence, and secret exclusion. | Existing 07-01/07-10; 07-41, 07-43 | COVERED |
| R-07 | Canonical content-addressed evidence retains explicit non-pass outcomes. | Existing 07-00–07-18; 07-43–07-44 | COVERED |
| R-08 | Mandatory regional/relay/database/worker/publication/payment/model fault matrix and duplicate-effect probes. | Existing 07-02/07-03/07-23/07-24; 07-41–07-43 | COVERED |
| R-09 | Resume/retry observes the original operation; uncertain outcome never creates a replacement. | 07-41–07-43 | COVERED |
| R-10 | Seven named durability subjects restore byte/identity-equivalently after fresh-instance loss. | Existing 07-04/07-23; 07-41, 07-43 | COVERED |
| R-11 | Exactly eight real protected suites feed the sole evaluator, one immutable bundle, and one promotion pointer. | Existing authority plus 07-40, 07-43–07-44 | COVERED |
| R-12 | Pinned napplet/toolchain sources, real Chromium conformance, SBOM/provenance, and hostile build/host checks remain authoritative. | Existing 07-05–07-18; 07-42–07-43 | COVERED |
| R-13 | ContextVM remains the external transport while the generation core remains transport-neutral. | Existing Phase 3 and 07-24; official client 07-42 | COVERED |
| R-14 | CEP-8 Lightning/Cashu and model usage use exact receipts, existing ledger/reconciliation, and real provider operations. | 07-42–07-43 | COVERED |
| R-15 | Compatible host, external signer, promoted CLI, exact upload, owner relay, and attestation relay use existing package/domain contracts. | 07-42–07-43 | COVERED |
| R-16 | Provider credentials remain external; config/evidence contain references/hashes and every live effect is exact-receipt gated. | 07-40–07-44, 07-20 | COVERED |
| R-17 | Cost is bounded, source-attributed, fresh, currency-explicit, scope/duration/retention/cleanup-bound, and includes project bootstrap. | 07-41, 07-44, 07-20 | COVERED |
| R-18 | No new package install is required; existing pinned SDK/domain ports and built-in protocol clients are reused. | 07-40–07-44 | COVERED |

### Post-debug execution-bridge research coverage

| ID | `07-EXECUTION-BRIDGE-RESEARCH.md` feature/constraint | Plan coverage | Status |
|---|---|---|---|
| EB-01 | One hash-pinned `createReleaseExecutionSession` factory consumes controller-owned config and returns immutable registry/preparation. | 07-40 | COVERED |
| EB-02 | Shared real Google ADC clients cover Cloud Run, GCS, Collector, Cloud SQL, and Vertex; Modal SDK and Fly REST are concrete. | 07-41–07-42 | COVERED |
| EB-03 | Concrete ContextVM, Lightning, Cashu, model, host, signer, CLI, upload, owner-relay, and attestation-relay clients enforce key custody. | 07-42 | COVERED |
| EB-04 | All sixteen families have explicit client ownership, tests, absence behavior, protected consumers, and factory reachability. | COVERAGE.md; 07-41–07-43 | COVERED |
| EB-05 | Exactly eight independent real suites plus complete materialization, worker-selection, verification, finalization, and cleanup inputs. | 07-43 | COVERED |
| EB-06 | Forced resume covers original identities/effect counts at every provider, suite, promotion, and cleanup boundary. | 07-43 | COVERED |
| EB-07 | Fresh sixteen-line price facts and actual observed costs replace the fixed 36,000,000-micro-USD source. | 07-41, 07-44 | COVERED |
| EB-08 | Product command proves complete no-effect readiness, generates config/request, launches only NIP-46/NWC/Cashu consent, and precedes approval. | 07-44 → 07-20 → 07-26 | COVERED |

## CONTEXT decision coverage

| Decision | Locked requirement | Covering plans | Status |
|---|---|---|---|
| D-114 | Receipt-to-exact-ready clock. | Existing 07-00/07-23; 07-30/07-32/07-38 | COVERED |
| D-115 | Immediate lease/refusal and no queue/hold. | Existing 07-00/07-14; 07-30/07-32/07-38 | COVERED |
| D-116 | Identical Modal/Fly cohorts and evidence-only selection. | 07-32, 07-38 | COVERED |
| D-117 | Owner-safe refusal/replay. | Existing 07-00/07-14; 07-33/07-38 | COVERED |
| D-118 | Versioned lifecycle telemetry vocabulary. | Existing 07-01; 07-30/07-38 | COVERED |
| D-119 | Sensitive telemetry fields forbidden. | Existing 07-01; 07-30/07-33–07-35/07-37 | COVERED |
| D-120 | Required p50/p95/p99, sample/rejection splits, windows, and confidence. | Existing 07-01/07-10; 07-30/07-32/07-38 | COVERED |
| D-121 | Canonical content-addressed immutable records with explicit non-pass. | Existing 07-02/07-10; 07-31/07-38/07-39 | COVERED |
| D-122 | Mandatory fault matrix. | Existing 07-02/07-03; 07-31–07-38 | COVERED |
| D-123 | Topology claims limited to tested evidence. | Existing 07-03; 07-30–07-32/07-38 | COVERED |
| D-124 | Resume original operation only. | 07-29–07-39 | COVERED |
| D-125 | Seven exact durability subjects. | Existing 07-04; 07-31/07-38 | COVERED |
| D-126 | One fail-closed promotion decision with exact inputs. | Existing 07-12/07-16/07-18; 07-38/07-39 | COVERED |
| D-127 | Launch-hardening deferrals plus NIP-5D and pinned package authority. | Existing 07-05–07-18; 07-35/07-36/07-39 | COVERED |
| D-128 | All selected live integrations and UI host checks. | 07-29–07-39 | COVERED |
| D-129 | Only named owner waivers; listed safety/key/SLO/live gates non-waivable. | Existing 07-10/07-12; 07-35/07-37–07-39 | COVERED |
| D-130 | Cloud SQL sole authority and no current alternate vendor/CLI path; history preserved. | 07-27, 07-29, 07-31, 07-38 | COVERED |
| D-131 | Provider-neutral release port/controller primary; Cloud SQL detail; Modal/Fly measured variants. | 07-27, 07-29–07-32, 07-37–07-38 | COVERED |
| D-132 | Exact USD request binds estimate freshness, bounds, scopes, bootstrap/effects, state, expiry, and receipt. | 07-28–07-29, 07-37–07-39, 07-20 | COVERED |
| D-133 | User only official consent and exact approval; controller derives config/evidence/cost and persists no credentials. | 07-40–07-44, 07-20 | COVERED |
| D-134 | Completed 07-37–07-39 are candidly limited to contracts/controller/session seam; concrete factory/clients remain required. | 07-40–07-44; roadmap/state correction | COVERED |
| D-135 | One controller-generated pinned deployment config/factory and structured exact official receipt. | 07-40, 07-44, 07-20 | COVERED |
| D-136 | Shared Google ADC/project, Cloud SQL only, Modal/Fly comparison, official ContextVM, Vertex Gemini, promoted napplet host/Chromium. | 07-41–07-43 | COVERED |
| D-137 | Service ContextVM/attestation keys; external user NIP-46 key; only NWC/Cashu human consent. | 07-42, 07-20 | COVERED |
| D-138 | Sixteen concrete clients, exact-eight real ports, complete materialization/selection/finalization, forced resume. | 07-41–07-43, 07-26 | COVERED |
| D-139 | Fresh sixteen-line cost authority, operational bounds, and actual-cost reconciliation replace fixed amount. | 07-41, 07-44, 07-20, 07-26 | COVERED |
| D-140 | Controller generates config/launches consent; no manual secrets/files; no effect before receipt. | 07-40, 07-44, 07-20 | COVERED |

## Exclusions (not gaps)

- All ideas under `07-CONTEXT.md` **Deferred Ideas** remain outside Phase 7 plans.
- Completed `*-SUMMARY.md` files and immutable historical evidence are intentionally excluded from authority corrections per D-130.
- x402/L402 transport adapters remain later-phase work; the provider-neutral core is preserved.
- Package installation is excluded because the required SDKs/domain ports are already pinned in the repository; therefore no package legitimacy checkpoint is introduced.
- The live external run is excluded from implementation Plans 07-40–07-44 and remains solely in 07-26 after 07-20 authorization.

## Reachability and dependency audit

| Required artifact/behavior | Reachable path | Result |
|---|---|---|
| Exact authorization | candidate/discovery → 07-28 request → 07-20 receipt → same controller run | REACHABLE |
| New GCP project | authorized effect plan → 07-29 bootstrap → 07-30/07-31 resources | REACHABLE |
| Deployment session | 07-40 pinned factory/config/receipt → 07-41/07-42 concrete clients | REACHABLE |
| Worker selection | 07-41 concrete Modal/Fly → 07-43 identical real cohorts → materializer | REACHABLE |
| All external families | existing adapters → 07-41/07-42 concrete clients → deployment factory | REACHABLE |
| Exact-eight protected evidence | 07-43 real port factory → existing protected registry/controller | REACHABLE |
| Sole promotion/cleanup | 07-43 complete finalization inputs → existing 07-39 evaluator/bundle/promotion/cleanup | REACHABLE |
| Authorization and run | 07-44 no-effect product proof → 07-20 structured approval → 07-26 live run | REACHABLE |

No source item is MISSING. No phase split is required: the provider families are separated into context-bounded plans and converge through explicit dependency waves.
