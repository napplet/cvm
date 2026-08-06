# API Coverage — Phase 7 external capability authority

> All external capabilities required by D-128 are `INTEGRATE`. The controller and `ReleaseProviderPort` derive configuration, topology, cost, and evidence; no row grants a user authority to author those facts. Any missing credential or topology input produces immutable `blocked` evidence, never a live pass.

| capability | decision | reason | production adapter / port owner plan | protected-suite consumer | credential discovery | absence state |
|---|---|---|---|---|---|---|
| cloud_run | INTEGRATE | D-128 control-plane deployment and ingress-loss drills. | `ReleaseProviderPort` / 07-28 | chaos, restore | controller validates configured provider scope | `blocked` |
| gcs | INTEGRATE | D-128 retained checkpoint, artifact, and evidence objects. | object-store port / 07-29 | restore | controller validates bucket binding | `blocked` |
| collector | INTEGRATE | D-128 candidate-bound redacted lifecycle export. | telemetry exporter port / 07-30 | telemetry | controller validates collector profile | `blocked` |
| cloud_sql_postgres | INTEGRATE | Sole D-130 database authority for ledger, lease, and publication fences. | `ReleaseProviderPort` / 07-28 | chaos, restore | controller validates Cloud SQL scope | `blocked` |
| modal | INTEGRATE | D-131 measured worker candidate under the shared contract. | worker provider port / 07-31 | admission, chaos | controller validates protected profile | `blocked` |
| fly | INTEGRATE | D-131 non-AWS worker variant measured under the same contract. | worker provider port / 07-31 | admission, chaos | controller validates protected profile | `blocked` |
| contextvm | INTEGRATE | Sole v1 signed invoke, replay, and response transport. | `ContextVmAdapter` / 07-32 | contextvm-payment-model | controller validates relay profile | `blocked` |
| cep8_lightning | INTEGRATE | D-128 Lightning prepaid top-up rail. | payment rail port / 07-32 | contextvm-payment-model | controller validates rail profile | `blocked` |
| cashu | INTEGRATE | D-128 Cashu prepaid top-up rail. | payment rail port / 07-32 | contextvm-payment-model | controller validates rail profile | `blocked` |
| model | INTEGRATE | D-128 exact receipt and original-operation reconciliation. | `ModelGateway` / 07-33 | contextvm-payment-model | controller validates model profile | `blocked` |
| compatible_host | INTEGRATE | D-128 preview and Phase 6 host UI contract. | host presentation port / 07-34 | security-host | controller validates host profile | `blocked` |
| signer | INTEGRATE | D-128 local/external user-owned manifest signing. | signer facade / 07-34 | security-host | controller validates signer profile | `blocked` |
| promoted_cli | INTEGRATE | D-128 exact promoted CLI source and asset binding. | napplet CLI facade / 07-35 | supply-chain | controller validates promoted source pin | `blocked` |
| upload | INTEGRATE | D-128 sealed deployment under original operation identity. | upload facade / 07-36 | publication | controller validates upload target scope | `blocked` |
| owner_relay | INTEGRATE | D-128 user-signed owner manifest publication. | owner relay facade / 07-36 | publication | controller validates relay profile | `blocked` |
| attestation_relay | INTEGRATE | D-128 distinct CVM build attestation publication. | attestation relay facade / 07-36 | publication | controller validates relay profile | `blocked` |

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
- The controller derives all configuration, topology, trust inputs, cost, cleanup, and evidence. The user supplies only official provider login/consent and an exact digest approval or verification.
