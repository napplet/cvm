# Production gap record

Current direction: provider-neutral application; simple Ansible/container deployment on homelab or VPS. See `07-NO-GOOGLE-CLOUD-DECISION.md` and `docs/architecture/provider-neutral-deployment.md`. All provider-specific topology and non-google-v1 execution instructions below are historical, not active requirements.

## Superseded Google-composition baseline

The following inventory records earlier implementation work. Its Google provider selections are historical and must not direct new execution; reusable mechanisms still require revalidation in the revised composition.


This matrix is the gap-closure input for the resumed production-readiness work. It distinguishes implemented/refusal-safe code from fresh production evidence. Historical private-development results remain valid only for the environment in which they were produced.

## Initial audit snapshot — 2026-10-27

- Source: `napplet/cvm` `main` deployed at `24252f744b8cd5f33a216c264a658623b98b7a42` by completed Coolify job `yzuxxcgg9g5li8pk4umujulp` (2026-10-27 12:03:11Z); homelab `master` at `6b6e6a6`.
- Live private deployment: Coolify app `x13wc0i56wce31hkg4jrtmsq` is healthy on Beta. Signed WSS uses service key `715bd434527b8e1fd73201bb48ec9b91444229250798c4bbc1c24c32320e4bbf`. Its active provider is `ChatGPT subscription · local test sats`.
- The current deployment runs a single-host privileged nested Docker engine plus local PostgreSQL, two development Cashu mints, an NWC hub, and a relay. It is a working private development composition, not an HA control plane or approved production sandbox.
- `release:certify --candidate toolchains/candidates/initial.json --request` stops at `local_setup_required` with zero effects before exposing execution-readiness blockers. No production dependency call site or protected observation has run.
- CI evidence `40498472843` has 19 failures and one error because the payment job selects the entire `tests/dev` prefix without provisioning its shared payment config, browser, and worker prerequisites. GUI run `40498472848` cannot start its pinned AMD64 relay on the ARM64 runner. These are release-impacting prerequisites until repaired or accurately isolated by contract.

## Current implementation observation — 2026-10-28

CVM GitHub main includes PR41 (`c5261d4565600b85c7f0bae59fe16a82458b0657`);
homelab master includes PR132 (`187c1a0ea8be24a15fd67e38be39a6d403fd9acd`).
Beta still serves the preserved private deployment above. No protected production
suite or cutover has run. Dated evidence is retained in `07-PRODUCTION-RESUMPTION.md`.

## Reviewed continuation — 2026-10-31

The implementation columns in the original matrix below retain the2026-10-27/28 baseline. Use this dated overlay and [STATE](../../STATE.md) for current execution; “covered” in the coverage audit means assigned to plans, not production-certified.

| Boundary | Current reviewed/source proof | Remaining completion evidence |
| --- | --- | --- |
| Private Beta preservation | Read-only07:58:47Z observation preserved appUUID, healthy private service, repository and mainline selection; no new deployment revision inferred. | Pre-cutover backup, fresh restoration, quiesce/cutover/rollback under exact approval. |
| Cashu concurrent semantic-proof custody | PR102 clean deep iteration4 and all8 required checks; merged mainb68a6cdb, imported roota905283. Canonical PG16 cases/523 assertions; root focused19 passed,1 expected PG skip. | Real consent, settlement/custody and interruption drills under receipt; code proof is not live funding certification. |
| Retained subject recovery | PR98 merged and imported; actual PostgreSQL clone/recovery proof for7 legacy retained subjects, native original-operation bridge and expiry cleanup. | Priced V2 normal path and real Cloud SQL/GCS fresh-instance certification remain open. |
| Mounted priced resume | PR101 explicit V2 lineage with historical V1 bytes preserved, typed accounting holds and strict legacy/priced restore facts under repair; append-only migration017 awaiting actual PostgreSQL proof. | First mounted provider dispatch, injected late finalizer failure, fresh original-only reconciliation, all7 V2 restore subjects, deep clean review and all exact CI. |
| Resource ownership and actual cost | PR100 merged immutable resource progress, dispatch fences and held unknown costs. PR1038eb1590 adds grant-scoped original BigQuery GET recovery, immutable raw capture and bounded transport. Actual CLI fixture21 cases/193 assertions; exact-head PG7 cases/211 assertions and image checks passed. | PR103 deep review and remaining CI; native account/IAM/export/coverage proof, separately approved future first-query authority, Modal and other paid-family cost coverage. Unknown cannot finalize. |
| Whole compiler and image mechanism | PR102/root and PR103 full pinned TypeScript5.9.3 passed; hosted PR103 image packaging/non-root/network-none/missing-authority refusal passed. | Final merged candidate/config/OCI/SBOM/provenance measurement and full required gates after remaining source work. |
| Real release evidence | No protected suite, paid query, model/funding effect, deployment, public enablement or cutover performed during this continuation. | Exact16 provider graph,8 fresh real candidate-bound suites, locked thresholds, sole evaluator, immutable bundle, cleanup and approved production deployment. |

Counts remain103/114 milestone plans and63/74 Phase7 plans. Plans65–73 and authorization/execution20/26 remain incomplete. See [billing proof](07-65-BILLING-TRANSPORT-BOUNDS-HANDOFF.md) and the active mounted priced-resume review/execution handoffs. No approval request is ready while independent implementation remains feasible.

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
| Complete production composition / D-134–D-140 | The mounted runtime and receipt executor construct the sixteen-provider/eight-suite graph; publication certification mechanisms have actual local transport proof. | Finish real suite controls and the ordinary-user preview/publication ports; the production funding graph currently does not supply those optional routes. | CLI constructs the full graph and source-bound request; no injected placeholder or loopback transport remains in production. | 63–70, 73 |
| Google transports | Loopback-only injected clients enforce shapes for Cloud Run, GCS, Collector, Cloud SQL, and Vertex. | ADC-backed HTTPS transports with verified request/response contracts, stable operation IDs, observe-before-retry, and run-owned cleanup. | Contract tests plus read-only capability discovery; effects remain receipt-gated. | 63, 65 |
| Worker isolation | Modal adapter and worker policy exist; private nested Docker proves only development containment. | Official Modal and Fly transports with immutable image, filesystem/network/resource/lifetime/capability restrictions and no service credentials in workers. | Security-host and admission records prove the enforced boundary; the privileged nested engine is never cited as production certification. | 64, 68, 69 |
| ContextVM public transport | Signed WSS works privately and canonical invocation identity exists. | Production SDK relay client, durable invocation/operation identity, observation and reconciliation; no HTTP generation route. | Real signed request/reconnect/replay observations through ContextVM over Nostr. | 66, 69, 70 |
| Production model and pricing | ChatGPT subscription works with synthetic local-test-sat rates. | Keep credentials private for development, select the D-136 production model path, use current source-attributed USD prices and actual receipts, and refuse fixture/rate fallbacks. | Price/source digests, model receipt reconciliation, and exact charged usage in the payment/model suite. | 65, 66, 69 |
| CEP-8 Lightning | Durable coordinator and NWC test rail exist. | Real NWC consent and settlement; recover a lost create response before payment hash persistence by querying the original durable identity only. | Lost-response drill reaches one final invoice/credit without reissue or duplicate credit. | 62, 66, 69 |
| Cashu custody | Commitment replay checks and encrypted generic rail material exist. | Durable encrypted received-proof custody, semantic proof identity across re-encoding, service-owned output evidence for ambiguous swaps, and recovery. | Restart/ambiguous-swap/re-encoded-spent-token cases result in one credit at most and retain ownership proof. | 60, 61, 66, 69 |
| Exact billing/caps | Reservations, exact settlement, cancellation and retry logic exist. | Bind real provider receipts/rates to the production realm and live concurrent/crash cases. | Immutable receipts reconcile reservation to actual usage without exceeding balance or approved cap. | 60, 65, 66, 69 |
| Publication and key custody | Mainline PR27–36 include verified source bytes, named CLI receipts, durable contexts, separate service attestation, actual CLI upload/relay composition and query-only observation after expiry; combined TLS/NIP-46/CLI/PG mechanism passed fresh CI. | Approved server metadata now reaches actual CLI manifests and signed-tag blob retrieval passes. Complete the normal user path, compatible-host browser proof, full-runtime recovery and protected real-provider publication/cleanup. No golden future artifact or pre-signed owner event is required. | Publication suite proves user-owned signing, exact artifact, partial-effect reconciliation, and that no user private key entered CVM state. | 67, 69, 70, 26 |
| Ordinary preview/publication | Domain services and ContextVM owner-scoped arguments exist. PR37 adds durable verification/object references and request indexes; PR38 retains actual CLI output and capability-file presence/absence in new archives. Certification publication is composed separately. | PR39/40 add verified unselected CLI0.13 intake and explicit direct identity/archive readers; PR41 adds prepared matched source2/bundle3 production, bounded data-only purpose/declarations, real Chromium and fresh restore on ARM64/native AMD64 with legacy default preserved. Finish retained original-hash profile selection, meaningful capability policy, direct publication helpers/source composition, completed-action owner access and normal preview/publication ports before activation. Existing Paja0.19.0 smoke cannot certify the new core0.34.0/Paja0.21.4 host profile. | A signed customer flow generates, previews, reviews, signs and publishes its own artifact across restart; foreign/test-accounting artifacts and invented metadata are refused. | 69, 70, 72 |
| Production topology | Current Coolify app is one private host. Approved architecture requires two warm Cloud Run regions, Cloud SQL HA, dual-region GCS, and measured Modal/Fly. | Keep Coolify/Beta as preserved migration source and private fallback; provision the separately justified production authorities and route only after release gates. | Architecture decision, reproducible manifests, exact failure-domain claim, healthy multi-region control plane, and rollback. | 58, 63, 64, 71, 72 |
| Operator surface | `./homelab cvm` exposes production plan/deploy/status/certify/verify/backup/restore-test/cutover/rollback on merged master; receipt execution checks exact mainlines and completed digests. | Exercise actual protected operations and lifecycle/restore/rollback evidence after the final exact authorization; keep administration private. | Commands own defaults and emit redacted candidate/revision/evidence identities. | 71, 72 |
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
