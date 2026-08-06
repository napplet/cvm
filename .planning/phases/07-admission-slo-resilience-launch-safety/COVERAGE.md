# API Coverage — Phase 7 external capability authority

> All external capabilities required by D-128 and D-134–D-140 are `INTEGRATE`. Plans 07-28–07-39 created provider-neutral contracts/adapters/controller/session seams; the append-only correction assigns the missing concrete clients to 07-41/07-42, the real protected port constructors/runners to 07-43, and the no-effect product proof to 07-44. Plans 07-40–07-44 verify with injected fakes/loopback emulators/fixture credentials only; 07-44 alone may perform authenticated read-only capability/account-scope/current-price discovery. Consent is 07-20-only and all real effects/benchmarks are 07-26-only after the exact receipt. The controller derives configuration, topology, cost, and evidence; no row grants a user authority to author those facts.

| capability | decision | reason | production adapter / port owner plan | protected-suite consumer | credential discovery | absence state |
|---|---|---|---|---|---|---|
| cloud_run | INTEGRATE | D-128 control-plane deployment and ingress-loss drills. | native adapter 07-30; concrete ADC client/test 07-41 | chaos, durability / 07-43 | service Google ADC/project | `blocked` |
| gcs | INTEGRATE | D-128 retained checkpoint, artifact, and evidence objects. | native adapter 07-31; concrete ADC client/test 07-41 | durability / 07-43 | service Google ADC/project | `blocked` |
| collector | INTEGRATE | D-128 candidate-bound redacted lifecycle export. | native adapter 07-30; concrete ADC client/test 07-41 | telemetry / 07-43 | service Google ADC/project | `blocked` |
| cloud_sql_postgres | INTEGRATE | Sole D-130 database authority for ledger, lease, and publication fences. | native adapter 07-31; concrete ADC client/test 07-41 | chaos, durability / 07-43 | service Google ADC/project | `blocked` |
| modal | INTEGRATE | D-131 measured worker candidate under the shared contract. | native adapter 07-32; concrete SDK client/test 07-41 | admission, chaos / 07-43 | deployment service reference | `blocked` |
| fly | INTEGRATE | D-131 non-AWS worker variant measured under the same contract. | native adapter 07-32; concrete REST client/test 07-41 | admission, chaos / 07-43 | deployment service reference | `blocked` |
| contextvm | INTEGRATE | Sole public signed invoke, replay, and response transport. | native adapter 07-33; official SDK client/test 07-42 | ContextVM-payment-model / 07-43 | service-owned ContextVM key reference | `blocked` |
| cep8_lightning | INTEGRATE | D-128 Lightning prepaid top-up rail. | native adapter 07-33; NWC client/test 07-42 | ContextVM-payment-model / 07-43 | controller-launched user NWC consent | `blocked` |
| cashu | INTEGRATE | D-128 Cashu prepaid top-up rail. | native adapter 07-33; funded-wallet client/test 07-42 | ContextVM-payment-model / 07-43 | controller-launched funded-wallet consent | `blocked` |
| model | INTEGRATE | D-128 exact receipt and original-operation reconciliation. | native adapter 07-34; Vertex Gemini ADC client/test 07-42 | ContextVM-payment-model / 07-43 | service Google ADC/project | `blocked` |
| compatible_host | INTEGRATE | D-128 preview and Phase 6 host UI contract. | native adapter 07-35; NIP-5D/reference-host/Chromium client/test 07-42 | security-host / 07-43 | promoted toolchain reference | `blocked` |
| signer | INTEGRATE | D-128 external user-owned manifest signing. | native adapter 07-35; NIP-46 client/test 07-42 | security-host / 07-43 | controller-launched user NIP-46 consent | `blocked` |
| promoted_cli | INTEGRATE | D-128 exact promoted CLI source and asset binding. | native adapter 07-36; concrete source client/test 07-42 | supply-chain / 07-43 | promoted source reference | `blocked` |
| upload | INTEGRATE | D-128 sealed deployment under original operation identity. | native adapter 07-36; Blossom client/test 07-42 | publication / 07-43 | deployment target reference | `blocked` |
| owner_relay | INTEGRATE | D-128 user-signed owner manifest publication. | native adapter 07-36; Nostr client/test 07-42 | publication / 07-43 | pre-signed owner event from NIP-46 | `blocked` |
| attestation_relay | INTEGRATE | D-128 distinct CVM build attestation publication. | native adapter 07-36; Nostr client/test 07-42 | publication / 07-43 | service-owned attestation key reference | `blocked` |

## Explicit opt-outs

| capability | decision | retained path |
|---|---|---|
| public_x402_l402_generation | OPT-OUT | ContextVM is the sole public v1 transport; future adapters remain transport-neutral ports. |
| worker_public_ingress | OPT-OUT | Generated code has no inbound port; typed coordinator ports carry effects. |
| provider_memory_snapshot_as_checkpoint | OPT-OUT | Cloud SQL fences and exact-generation GCS objects remain authoritative. |
| automatic_provider_payload_instrumentation | OPT-OUT | Manual allowlisted telemetry protects prompts, source, receipts, and cardinality. |

## Requirement edges

| Requirement | Explicit protected evidence edge |
|---|---|
| SESS-02 | Modal/Fly concurrent pool-hit, pool-miss, cold, step-load, contention, reclaim, and refusal cohorts prove the receipt-to-ready p95 or no-effect refusal contract. |
| OPS-01 | Collector receives concurrent bounded lifecycle telemetry cohorts with redaction and finite-cardinality assertions. |
| OPS-02 | Cloud Run, Cloud SQL, worker, payment/model, upload, and relay duplicate/failure schedules prove original-operation-only effects. |
| OPS-03 | GCS plus Cloud SQL restore subjects cover read/decrypt/checksum, owner/version/lease reattachment, infrastructure loss, retention, and expiry/deletion. |
| OPS-04 | Candidate-bound evidence binds all sixteen integrated capabilities, supply-chain records, SLO/chaos/restore outcomes, and the exact controller authorization receipt. |

## Coverage closure

- Every `INTEGRATE` row is owned by a plan, consumed by a protected suite, and fails closed when credential discovery is absent.
- Modal and Fly remain evidence-driven variants behind provider-neutral release/controller contracts; Cloud SQL is the selected database detail only.
- Plans 07-37–07-39 own the contracts/controller/session seam; Plans 07-40–07-44 own the missing deployment factory, concrete clients, exact-eight real composition, pricing, readiness, and product-command proof.
- Implementation Plans 07-40–07-44 create no live effects or protected evidence; they prove intended operations with fake/local harnesses. Only 07-44 may read authenticated scopes/prices, while 07-20 owns consent and 07-26 owns every real mutation, benchmark schedule, observation, promotion, and cleanup.
- The controller derives all configuration, topology, trust inputs, fresh costs, cleanup, and evidence. The user supplies only external NIP-46 owner signing plus NWC or funded Cashu consent through the controller-launched structured approval flow.
