# Phase 7 production gap matrix — 2026-10-27

This matrix is the gap-closure input for the resumed production-readiness work. It distinguishes implemented/refusal-safe code from fresh production evidence. Historical private-development results remain valid only for the environment in which they were produced.

## Current authoritative baseline

- Source: `napplet/cvm` `main` deployed at `24252f744b8cd5f33a216c264a658623b98b7a42` by completed Coolify job `yzuxxcgg9g5li8pk4umujulp` (2026-10-27 12:03:11Z); homelab `master` at `6b6e6a6`.
- Live private deployment: Coolify app `x13wc0i56wce31hkg4jrtmsq` is healthy on Beta. Signed WSS uses service key `715bd434527b8e1fd73201bb48ec9b91444229250798c4bbc1c24c32320e4bbf`. Its active provider is `ChatGPT subscription · local test sats`.
- The current deployment runs a single-host privileged nested Docker engine plus local PostgreSQL, two development Cashu mints, an NWC hub, and a relay. It is a working private development composition, not an HA control plane or approved production sandbox.
- `release:certify --candidate toolchains/candidates/initial.json --request` stops at `local_setup_required` with zero effects before exposing execution-readiness blockers. No production dependency call site or protected observation has run.
- CI evidence `40498472843` has 19 failures and one error because the payment job selects the entire `tests/dev` prefix without provisioning its shared payment config, browser, and worker prerequisites. GUI run `40498472848` cannot start its pinned AMD64 relay on the ARM64 runner. These are release-impacting prerequisites until repaired or accurately isolated by contract.

## Requirement and implementation gaps

| Requirement / boundary | Current implementation | Missing production work | Required completion evidence | Plan |
|---|---|---|---|---|
| In-place preservation | Coolify lifecycle, signed identity, persistent private state, artifacts, projects, and audit records work on Beta. | Record the authority split and prove backup/restore before any cutover; keep Beta serving privately during preparation. | Restorable pre-cutover backup, row/object counts, identity/artifact digest comparison, and rollback rehearsal. | 58, 72 |
| Test/real-money boundary | The live homelab composition explicitly labels its balances as local test sats. | Production mode must use a distinct accounting realm backed only by Cloud SQL and real rails; it must refuse development faucets, FakeWallet, fixture models, synthetic rates, and development keys. Preserve the test realm read-only during migration. | Construction tests prove a test balance cannot satisfy a production reservation; production config cannot instantiate development adapters. | 60, 70, 72 |
| SESS-02 / D-114–D-117 | Funded admission and retryable capacity refusal are deterministic and fail closed. | Real Modal and Fly transports, identical cohorts, immediate capacity claim, and fresh 1,000 accepted plus two 200-attempt forced cohorts. | Candidate-bound admission record: p95 <= 5,000 ms, one-sided 95% confidence, zero accepted backlog, stable duplicate refusal. | 64, 66, 68, 70, 73, 26 |
| OPS-01 / D-118–D-121 | Bounded OTel vocabulary and evidence schemas exist. | Authenticated Collector transport and candidate-bound lifecycle observation across the deployed topology. | Fresh real telemetry suite with redaction canaries and bounded-cardinality proof. | 63, 68, 70, 73, 26 |
| OPS-02 / D-122–D-124 | Original-operation and deterministic fault behavior exist. | Live relay, region, SQL, object, worker, model, payment, signer, upload, publication, and cleanup reconciliation. | Chaos suite shows no duplicate credit/debit/worker/object/signature/event/attestation/promotion effect and preserves unknown states. | 61–70, 72, 26 |
| OPS-03 / D-125 | Checkpoint envelopes and restore validators exist; private restart recovery passed. | GCS dual-region encrypted checkpoint/artifact authority, 30-day lifecycle, fresh-instance Cloud SQL/GCS restore, ten-minute live-worker grace, lease reclaim, explicit resume, and deletion drill. | Restore suite uses a fresh instance, decrypts and hashes exact objects, reattaches owner/version fences, and verifies expiry. | 63, 68, 70, 72, 26 |
| OPS-04 / D-126–D-129 | Sole evaluator, pinned trust root, provenance and refusal gates exist. | All eight fresh real suites and production deployment inputs; CI prerequisites must be green without weakening gates. | Immutable bundle accepted only with exact eight records and pinned candidate/config/source/toolchain inputs. | 59, 65, 67–73, 26 |
| Cloud SQL authority / D-130 | PostgreSQL transactional stores and serializable migrations exist. | Provision PostgreSQL 17 regional HA as the only production authority; migrate without importing test balances. | HA instance/config digest, serializable money tests, backup and fresh-instance restore. | 60, 63, 70–72 |
| Provider-neutral controller / D-131–D-133 | Provider contracts, exact authorization request, receipt validation, and zero-effect dry run exist. | Build authenticated transports and materialize complete readiness before funding/approval is requested. | Review projection contains fresh prices, exact scopes/effects/cost/expiry and zero effect counters; any digest change invalidates it. | 63–67, 73, 20 |
| Complete production composition / D-134–D-140 | Factories validate exact sixteen provider and eight suite shapes. | Application call sites for `materializePreapproval` and `createProductionOperationalDependencies`; production session factory and protected config. | CLI constructs the full graph and source-bound request; no injected placeholder or loopback transport remains in production. | 63–70, 73 |
| Google transports | Loopback-only injected clients enforce shapes for Cloud Run, GCS, Collector, Cloud SQL, and Vertex. | ADC-backed HTTPS transports with verified request/response contracts, stable operation IDs, observe-before-retry, and run-owned cleanup. | Contract tests plus read-only capability discovery; effects remain receipt-gated. | 63, 65 |
| Worker isolation | Modal adapter and worker policy exist; private nested Docker proves only development containment. | Official Modal and Fly transports with immutable image, filesystem/network/resource/lifetime/capability restrictions and no service credentials in workers. | Security-host and admission records prove the enforced boundary; the privileged nested engine is never cited as production certification. | 64, 68, 69 |
| ContextVM public transport | Signed WSS works privately and canonical invocation identity exists. | Production SDK relay client, durable invocation/operation identity, observation and reconciliation; no HTTP generation route. | Real signed request/reconnect/replay observations through ContextVM over Nostr. | 66, 69, 70 |
| Production model and pricing | ChatGPT subscription works with synthetic local-test-sat rates. | Keep credentials private for development, select the D-136 production model path, use current source-attributed USD prices and actual receipts, and refuse fixture/rate fallbacks. | Price/source digests, model receipt reconciliation, and exact charged usage in the payment/model suite. | 65, 66, 69 |
| CEP-8 Lightning | Durable coordinator and NWC test rail exist. | Real NWC consent and settlement; recover a lost create response before payment hash persistence by querying the original durable identity only. | Lost-response drill reaches one final invoice/credit without reissue or duplicate credit. | 62, 66, 69 |
| Cashu custody | Commitment replay checks and encrypted generic rail material exist. | Durable encrypted received-proof custody, semantic proof identity across re-encoding, service-owned output evidence for ambiguous swaps, and recovery. | Restart/ambiguous-swap/re-encoded-spent-token cases result in one credit at most and retain ownership proof. | 60, 61, 66, 69 |
| Exact billing/caps | Reservations, exact settlement, cancellation and retry logic exist. | Bind real provider receipts/rates to the production realm and live concurrent/crash cases. | Immutable receipts reconcile reservation to actual usage without exceeding balance or approved cap. | 60, 65, 66, 69 |
| Publication and key custody | CLI publication, NIP-46 owner signing boundary, partial relay reconciliation and attestation exist. | Real promoted CLI/upload/host/signer/owner relay/attestation relay adapters under original operation IDs. | Publication suite proves user-owned signing, exact artifact, partial-effect reconciliation, and that no user private key entered CVM state. | 67, 69, 70, 26 |
| Production topology | Current Coolify app is one private host. Approved architecture requires two warm Cloud Run regions, Cloud SQL HA, dual-region GCS, and measured Modal/Fly. | Keep Coolify/Beta as preserved migration source and private fallback; provision the separately justified production authorities and route only after release gates. | Architecture decision, reproducible manifests, exact failure-domain claim, healthy multi-region control plane, and rollback. | 58, 63, 64, 71, 72 |
| Operator surface | `./homelab cvm` supports private deploy/inspect/verify/restart/smoke. | Stable production `plan`, `deploy`, `status`, `certify`, `backup`, `restore-test`, `cutover`, and `rollback` commands; private authenticated administration. | Commands own defaults and emit redacted candidate/revision/evidence identities. | 71, 72 |
| Authorization and release | Plans 07-20 and 07-26 are intentionally unexecuted. | Finish all no-effect implementation/readiness first, then obtain the exact controller receipt and execute the protected path. | 07-20 receives a concrete request; 07-26 produces exact-eight real evidence, sole-evaluator result, immutable bundle, and cleanup. | 73 -> 20 -> 26 |
| Mainline reproducibility | Current live source is on merged mainline in both repositories. | Every production manifest/runbook/code change must merge before it backs live state. | Exact deployed CVM and homelab revisions are on `origin/main` / `origin/master`; clean status and reproducible commands recorded. | Every plan; final gate in 70 |

## Architecture decision

The current Beta service is preserved through preparation and remains the source for state migration. It cannot satisfy the approved availability, database, object durability, or untrusted-worker boundaries: one host is not HA, local volumes are not dual-region object storage, and privileged nested Docker is not a certified production sandbox. Those demonstrated requirements justify separate production Cloud Run, Cloud SQL, GCS, and Modal/Fly resources. Coolify and `./homelab cvm` remain the operator lifecycle and migration surface; no replacement occurs before backup/restore proof and an authorized candidate passes certification. The exact tested failure domain, rather than the presence of two ingress regions alone, determines the availability claim.

## Execution order and effect boundary

Plans 58–73 are implementation and no-effect readiness work. They must complete before Plan 07-20. Plan 07-20 is the sole bounded authorization checkpoint. Plan 07-26 then provisions, runs all eight protected suites, evaluates, promotes, cuts over only on success, and cleans up resources covered by the receipt. A changed candidate, topology, scope, price catalog, cost envelope, controller state, or expiry requires a regenerated request.

## Multi-source coverage audit

| Source | ID / constraint | Coverage | Status |
|---|---|---|---|
| GOAL | Immediate-or-rejected work with preserved money/session/artifact/publication effects | 60–73, 20, 26 | COVERED |
| REQ | SESS-02 | 64, 66, 68, 70, 73, 26 | COVERED |
| REQ | OPS-01 | 63, 68, 70, 73, 26 | COVERED |
| REQ | OPS-02 | 60–72, 26 | COVERED |
| REQ | OPS-03 | 63, 68, 70, 72, 26 | COVERED |
| REQ | OPS-04 | 59, 65, 67–73, 26 | COVERED |
| CONTEXT | D-114–D-117 admission semantics and cohorts | 64, 66, 68, 70, 73, 26 | COVERED |
| CONTEXT | D-118–D-121 telemetry/evidence | 63, 68, 70, 73, 26 | COVERED |
| CONTEXT | D-122–D-125 recovery/durability | 60–72, 26 | COVERED |
| CONTEXT | D-126–D-129 promotion/non-waivable gates | 59, 65, 67–73, 26 | COVERED |
| CONTEXT | D-130–D-140 authority, providers, receipt and exact graph | 58, 60, 63–73, 20, 26 | COVERED |
| RESEARCH | Cloud SQL 17 HA; dual-region GCS; warm Cloud Run; Modal primary with Fly measured; pinned napplet/Chromium toolchain | 58, 63–73, 26 | COVERED |
| USER | Preserve private deployment/data; explicit test/real accounting boundary; real funding/billing; treasury closure; eight suites; final authorization; root commands; mainline config | 58–73, 20, 26 | COVERED |
| DEFERRED | x402/L402, rich inputs, collaboration, wider untested regional continuity | excluded | EXCLUDED |

