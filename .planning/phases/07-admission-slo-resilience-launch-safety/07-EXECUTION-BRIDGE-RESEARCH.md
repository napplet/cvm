# Phase 7: Deployment-owned Release Execution Factory — Bridge Research

**Researched:** 2026-08-06
**Scope:** unblock Plan 07-20 / protected execution only; no live action is authorized by this document.
**Confidence:** MEDIUM — code-path findings are HIGH; provider API choices are primary-source cited but need deployment-account validation.

## User Constraints (from CONTEXT.md)

- D-114–D-117: admission is measured from correlated signed receipt through exact-worker readiness, is immediately usable or rejected, never becomes a durable queue, and Modal/Fly selection is evidence-driven. [VERIFIED: codebase grep]
- D-118–D-125: telemetry and all recovery/promotion evidence are coordinator-derived, redacted, content-addressed, and reconcile only the original operation; unknown remains blocked. [VERIFIED: codebase grep]
- D-126–D-131: promotion is one fail-closed gate over immutable inputs; Cloud SQL for PostgreSQL is the sole database authority; `ReleaseProviderPort` and the controller remain provider-neutral; Modal/Fly remain measured variants. [VERIFIED: codebase grep]
- D-132–D-133: the controller creates the exact USD-bounded authorization request before an effect; it binds scopes, topology, candidate, effect/state digests, cleanup, retention, freshness, and expected receipt. The user supplies only official provider login/consent and one exact digest approval; credentials are never persisted. [VERIFIED: codebase grep]
- Deferred: public x402/L402, user-key custody, broad untested multi-region claims, and a durable generation queue remain out of scope. [VERIFIED: codebase grep]

## Project Constraints (from AGENTS.md)

- Output is a single-purpose conformant sandboxed napplet; text input is bounded; ContextVM is the only v1 public transport. [VERIFIED: codebase grep]
- CEP-8 Lightning/Cashu top-ups fund a prepaid ledger; exact usage is charged within an approved maximum and funded balance. [VERIFIED: codebase grep]
- The CVM must never receive/store a user Nostr private key. [VERIFIED: codebase grep]
- Use `@napplet/cli` and its deployment/manifest contract; do not reimplement publication. [VERIFIED: codebase grep]
- Use Cloud SQL for PostgreSQL as the money/session authority, GCP/Modal/Fly as current infrastructure, and no durable admission queue. [VERIFIED: codebase grep]

## Executive Finding

The repository already has the correct **fail-closed controller seam**, but intentionally lacks its one deployment-owned implementation. `loadReleaseExecutionSession()` only accepts a hash-pinned protected module and checks that it supplies a 16-family registry plus `prepareAuthorizedExecution`; `runReleaseCertification()` supplies the controller's current request to that session and then uses the returned receipt-bound input. [VERIFIED: codebase grep]

**Primary recommendation:** implement a separate deployment artifact exporting `createReleaseExecutionSession({ candidateSha256, workspace })`. It must load only secret *references* from the protected environment, use GCP ADC/project as the shared Google authority, create the service-owned ContextVM/attestation signing boundary, and require user-owned remote-signer consent only for the owner manifest. No local configuration, CLI argument, or user-provided JSON may supply provider profiles, receipts, ports, topology, evidence, or a pass result. [VERIFIED: codebase grep]

## Concrete Seam and Hash Binding

```text
hash-pinned protected certifier config
  -> hash-pinned deployment module
    -> createReleaseExecutionSession(candidateSha256, workspace)
       -> 16 ReleaseProviderPorts + exact receipt + 8 real suite ports
       -> controller dryRun() regenerates request from current discovery
       -> prepareAuthorizedExecution(request) checks exact request/receipt
       -> persist original provider operation -> plan -> apply/observe
       -> materialize only same candidate/topology + fresh worker selection
       -> run exact eight protected suites -> sole evaluator -> bundle -> promotion/cleanup
```

`ReleaseExecutionSession` must be one immutable object per candidate/request: `{ registry, prepareAuthorizedExecution }`. `registry.providers()` must enumerate the canonical 16 IDs in order; `prepareAuthorizedExecution` must return the structured exact receipt, materialization source/manifest/secret-reference inputs, selected worker evidence, eight real protected ports, finalization ports, and protected-verification references. The factory must reject any request whose candidate, topology, scopes, effect-plan digest, cost freshness, or expected receipt do not match the session's discovered facts. [VERIFIED: codebase grep]

### Inputs that must be hash-pinned into the session

| Input | Binding / consumer | Required rule |
|---|---|---|
| Candidate + source/package/lock/toolchain/policy/dataset hashes | controller candidate identity, all effects | Recompute before request and compare at every resume. [VERIFIED: codebase grep] |
| Desired topology + deployed observation | authorization, materializer, exact-eight records | Do not allow module configuration to select a different topology. [VERIFIED: codebase grep] |
| 16 account/project scope digests + cost-fact digests | authorization request | Discovery records only redacted hashes and names of secret references. [VERIFIED: codebase grep] |
| Exact structured receipt | every live provider boundary | Digest-only CLI input is insufficient; validate it against the current request immediately before each effect. [VERIFIED: codebase grep] |
| Worker comparison evidence | `materializeProtectedCertifier` | Only `modal` or `fly`, same candidate/topology, `passed`, and unexpired evidence may select the worker. [VERIFIED: codebase grep] |
| Manifest, sealed artifact/aggregate hashes, promoted CLI source snapshot | compatible host, signer, upload, relay | Preserve `@napplet/cli` as the source/deploy authority. [VERIFIED: codebase grep] |
| Source archive + reproducibility + supply-chain records | trust finalizer | Must be present before the sole evaluator/promotion. [VERIFIED: codebase grep] |
| Cleanup deadline/retention + original operation identities | finalizer and every provider | Cleanup observes/reuses only run-owned original operations; unresolved cleanup prevents completion. [VERIFIED: codebase grep] |

## Protected Suite Ports — Exact Eight

The session must supply `ProductionLiveProtectedCertificationPorts`, not an arbitrary adapter registry. `createProductionLiveProtectedCertificationRegistry()` is the sole translation into the exact suite registry. [VERIFIED: codebase grep]

| Suite port | Real material needed | Must be bound to |
|---|---|---|
| `admission` | Modal/Fly benchmark/load observation | selected candidate comparison, image, regions, load profile. [VERIFIED: codebase grep] |
| `telemetry` | collector export/query observation | collector image/config digest and allowlisted lifecycle vocabulary. [VERIFIED: codebase grep] |
| `chaos` | Cloud Run/Cloud SQL/GCS/worker fault controller | deployed topology and original-operation journal. [VERIFIED: codebase grep] |
| `durability` (maps to suite `restore`) | Cloud SQL + GCS read/decrypt/checksum/retention operations | durable owner/version/lease fences. [VERIFIED: codebase grep] |
| `security-host` | package-compatible host plus real Chromium | sealed artifact and aggregate hash only; no key material. [VERIFIED: codebase grep] |
| `supply-chain` | pinned toolchain/SBOM/provenance/reproducibility verifier | candidate and source archive. [VERIFIED: codebase grep] |
| `ContextVM-payment-model` | ContextVM, CEP-8 rails, Cashu, model original-receipt checks | exact request/receipt and test operation IDs. [VERIFIED: codebase grep] |
| `publication` | promoted CLI, external signer, Blossom upload, owner/attestation relays | exact sealed bytes, pre-signed owner event, attestation event. [VERIFIED: codebase grep] |

## Provider Implementation Matrix

All rows use the existing `ReleaseProviderPort` lifecycle: discovery is redacted/read-only; `plan` is receipt-checked; `apply` persists then effects; ambiguity uses `observe` of the same `operationId`; `cleanup` is run-owned and receipt-bounded. No provider adapter may turn a timeout into a replacement operation. [VERIFIED: codebase grep]

| Provider | Existing contract / missing concrete client | Default official transport + config/reference | Auth / user action unavoidable? | Discovery, effect, reconciliation/cleanup | Cost source + no-effect test |
|---|---|---|---|---|---|
| `cloud_run` | Native provider needs `CloudRunControlPlanePort`; no concrete client. [VERIFIED: codebase grep] | GCP Cloud Run Admin v2 REST via deployment GCP ADC; refs: project, region, service name, image digest, service account, env digest, min=3. Cloud Run supports v2 create/get/patch/delete and LROs. [CITED: https://docs.cloud.google.com/run/docs/reference/rest] | Service-owned GCP ADC and project/billing consent; no user runtime action after Plan 07-20 approval. [CITED: https://docs.cloud.google.com/run/docs/reference/authenticate-to-cloud-run-api] | Get service/LRO first; create/patch only after exact receipt; observe name/revision/image; delete run-owned service. [VERIFIED: codebase grep] | GCP catalog/contract price line; fake REST port asserts no mutation on bad receipt. [CITED: https://docs.cloud.google.com/billing/v1/how-tos/catalog-api] |
| `gcs` | Native provider needs `GcsControlPlanePort`; no concrete client. [VERIFIED: codebase grep] | GCP Storage JSON/official SDK with same ADC; refs: bucket, dual-region, versioning, retention, object prefixes. [ASSUMED] | Same GCP approval; no further user action. | Read bucket/object policy; configure versioning/retention and run-owned objects; observe generation/checksum; delete only ephemeral run prefix. [VERIFIED: codebase grep] | GCP storage/retention SKU lines; fake object-store port/local emulator. [VERIFIED: codebase grep] |
| `collector` | Native provider needs `CollectorControlPlanePort`; no concrete client. [VERIFIED: codebase grep] | Deploy pinned collector image through Cloud Run/GCP ADC; refs: image digest, service, redaction config digest, endpoint reference. [VERIFIED: codebase grep] | Same GCP approval; no user action. | Read deployment/config digest; create/update collector; query observed exporter health; remove run-owned collector. [VERIFIED: codebase grep] | Cloud Run/network SKU; fake collector port plus snapshot redaction tests. [VERIFIED: codebase grep] |
| `cloud_sql_postgres` | Native provider needs `CloudSqlPostgresControlPlanePort`; no concrete client. [VERIFIED: codebase grep] | Cloud SQL Admin v1 REST or official Node client under same ADC; refs: project, region, instance, `POSTGRES_17`, regional HA, backup/private-IP policy. Cloud SQL Admin has instance get/insert/list and operation polling. [CITED: https://docs.cloud.google.com/sql/docs/postgres/admin-api] | Same GCP project/billing approval; no user action. | Get exact instance/operation; create/update only receipt-bound; poll original LRO; delete only run-owned instance (never shared authority). [VERIFIED: codebase grep] | Cloud SQL catalog/contract price + backup/storage; fake Admin API/LRO port. [CITED: https://docs.cloud.google.com/billing/v1/how-tos/catalog-api] |
| `modal` | Existing `ModalSdkPort` + readiness command; missing `ModalClient` wrapper/session. [VERIFIED: codebase grep] | Existing `modal@0.9.0` JS SDK; `ModalClient`, named app/image, tagged sandbox, readiness probe, `blockNetwork:true` except scoped test phase. The SDK supports create/list/fromId/terminate. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox] | Deployment-owned Modal token/secret or profile; user action is not required if the deployment account is already authorized. [CITED: https://modal.com/docs/sdk/js/latest] | List by run tags; create only fresh sandbox; use `fromId`/tags on resume; terminate same run IDs. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox] | Provider usage/rate-card snapshot plus actual elapsed resource receipt; fake SDK verifies create=0 before receipt and terminate only original IDs. [VERIFIED: codebase grep] |
| `fly` | Existing `NativeFlyMachinesClientPort` + readiness command; missing API client. [VERIFIED: codebase grep] | Fly Machines REST with deployment-owned `FLY_API_TOKEN`; refs: app, region, image/config digest, machine label/run tag. Fly API expects bearer auth. [CITED: https://fly.io/docs/machines/api/working-with-machines-api/] | Deployment-owned token consent is required once by operator; no end-user action. | Get/list tagged Machine; create/update only receipt-bound; inspect same Machine; delete run-tagged Machine. [CITED: https://fly.io/docs/machines/guides-examples/managing-machines-with-the-api/] | Fly account rate/usage receipt snapshot; local HTTP fake validates original ID and deletion. [ASSUMED] |
| `contextvm` | Native wrapper needs real `ContextVmTransportPort` and existing funding adapter options. [VERIFIED: codebase grep] | Existing official `@contextvm/sdk@0.13.x` bridge over configured `wss://` relay set; refs: relay-set hash, service server pubkey, SDK/protocol version. ContextVM documents a TS SDK and CEP-8 payment integration. [CITED: https://docs.contextvm.org/] | Service-owned transport/server key only; never a user Nostr key. No user action beyond provider/account consent required by deployment. [VERIFIED: codebase grep] | Verify relay/connectivity and signed invocation replay semantics; invoke original event only; reconcile event ID; disconnect/close run subscriptions. [VERIFIED: codebase grep] | Relay/service fee schedule or zero evidence, timestamped; local relay test double covers duplicate/out-of-order event. [VERIFIED: codebase grep] |
| `cep8_lightning` | Existing wrapper requires `LightningReceiptPort` and `LightningTopUpCoordinator`; missing concrete Lightning receiver. [VERIFIED: codebase grep] | ContextVM CEP-8/Lightning rail adapter injected from the chosen receiver; refs: receiver endpoint hash, account ref, policy/capability version. ContextVM lists Lightning and NWC payment rails. [CITED: https://docs.contextvm.org/] | **Yes, deployment funding/receiver setup is unavoidable.** The exact test invoice maximum and receiver account must be consented/funded; user does not paste credentials. [VERIFIED: codebase grep] | Create/query exact invoice, persist/reconcile original top-up, never expose preimage; no “wallet” is supplied by this factory. [VERIFIED: codebase grep] | Invoice amount plus receiver fee quote, converted/ceiling-bound before USD approval; local receiver fake. [ASSUMED] |
| `cashu` | Existing wrapper requires `CashuSettlementPort`, `CashuWalletOperations`, coordinator; missing mint/wallet transport. [VERIFIED: codebase grep] | Cashu mint HTTP implementation selected by an approved mint-policy ref; the protocol defines mint quote → pay request → mint signatures, but not a hosted wallet. [CITED: https://cashubtc.github.io/nuts/04/] | **Yes, mint selection and a funded operational wallet/vault are unavoidable.** Do not invent either. The custodian/operator must approve mint URL/keyset policy and fund only the bounded test amount. [CITED: https://cashubtc.github.io/nuts/] | Read mint info/keysets/token state; submit/reconcile one top-up ID; cleanup means retain/reconcile audit state, never silently burn/replace proofs. [VERIFIED: codebase grep] | Mint fee/quote plus bounded proof value; local mint protocol server and proof-canary scan. [CITED: https://cashubtc.github.io/nuts/04/] |
| `model` | Existing HTTP model gateway needs authorized capability/profile and original receipt lookup. [VERIFIED: codebase grep] | Default Vertex AI Gemini using official `@google/genai` SDK **after package gate**; project/location from same GCP ADC, model/version and price-card digest pinned. Google documents Vertex AI mode with project/location. [CITED: https://cloud.google.com/vertex-ai/generative-ai/docs/sdks/overview] | Same GCP authorization; no end-user consent. | Read authorized capability/profile and fresh price card; call only original model operation; reconcile receipt, never redispatch ambiguous generation. [VERIFIED: codebase grep] | Original response usage metadata + a fresh model price-card digest, with ceiling before call; fake HTTP server returns known usage/unknown. [ASSUMED] |
| `compatible_host` | Existing package-host plus browser observation ports; missing concrete compatible host launcher/Chromium driver. [VERIFIED: codebase grep] | Use promoted napplet package/reference runtime and pinned Playwright Chromium in a local isolated worker; refs: host/package/runtime/browser versions and sealed/aggregate hashes. Napplet requires untrusted iframe without `allow-same-origin`. [CITED: https://napplet.run/docs/guide/nip-5d.html] | No user action. | Load exact sealed artifact, drive desktop/tablet/mobile and accessibility/capability checks; browser report is evidence; terminate worker/profile. [VERIFIED: codebase grep] | Isolated worker/browser elapsed cost; local fixture runtime and real Chromium smoke test. [VERIFIED: codebase grep] |
| `signer` | Existing `ExternalSignerBoundaryAdapter` needs `discover` and `signExactIntent`; missing NIP-46 client session. [VERIFIED: codebase grep] | NIP-46 remote signer over configured relays; request only `get_public_key` and the exact `sign_event` permission/kind needed for owner manifest. NIP-46 explicitly separates client, remote-signer, and user keypairs. [CITED: https://github.com/nostr-protocol/nips/blob/master/46.md] | **Yes, user-owned signer consent is unavoidable** for the owner-manifest signature. CVM may use only a disposable client connection key and must delete it on logout. [CITED: https://github.com/nostr-protocol/nips/blob/master/46.md] | Discovery/get public key first; request sign of exact intent; verify signed event; reconciliation observes event, no second sign request; close/logout connection. [VERIFIED: codebase grep] | No provider spend by default; signing consent receipt/evidence; local NIP-46 relay/signer double. [CITED: https://github.com/nostr-protocol/nips/blob/master/46.md] |
| `promoted_cli` | Existing source-contract adapter; no external client missing. [VERIFIED: codebase grep] | Pinned reviewed CLI source snapshot + native route only; `@napplet/cli` owns deployment metadata and NIP-5A manifest publication. [CITED: https://napplet.run/] | No user action. | Verify promoted source/route and exact aggregate before invoking its narrow upload/relay interfaces; no cleanup beyond evidence retention. [VERIFIED: codebase grep] | Zero direct provider cost; deterministic source-contract tests. [VERIFIED: codebase grep] |
| `upload` | Existing exact-sealed adapter needs `ExactSealedUploadPort`; missing Blossom transport. [VERIFIED: codebase grep] | Blossom BUD-02/BUD-11 HTTP client, scoped to a selected target ref; refs: server URL, auth public key/capability, retention, sealed/aggregate hashes. Blossom specifies `PUT /upload` and Nostr authorization. [CITED: https://github.com/hzrd149/blossom] | **Possibly.** If upload authorization is signed by the user key, use the same user-owned signer consent; if target supports a service-owned scoped uploader credential, no user action. Select exactly one in deployment policy. | HEAD/target capability and original upload observation; persist then upload exact bytes; reconcile checks hashes/location; delete only run-owned blobs if retention permits. [VERIFIED: codebase grep] | Target quote/fee or zero policy evidence; local BUD-02/BUD-11 server. [CITED: https://github.com/hzrd149/blossom] |
| `owner_relay` | Existing relay adapter needs `NostrRelayPort`; missing WebSocket client. [VERIFIED: codebase grep] | NIP-01 WebSocket relay client, configured relay-set digest, pre-signed owner event. `EVENT` publish is confirmed/denied by relay `OK`. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md] | Owner signature itself requires the signer row; relay connection normally does not need separate user action. | Query/observe exact event ID, publish only pre-signed exact bytes, reconcile same ID/relay set, no delete by default. [VERIFIED: codebase grep] | Relay fee policy/zero evidence; local relay emits `OK`, timeout, duplicate. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md] |
| `attestation_relay` | Same relay adapter; missing WebSocket client. [VERIFIED: codebase grep] | Same NIP-01 client, but sign attestation with a **service-owned attestation key** held in deployment secret manager/HSM reference; refs: attestation pubkey, relay set, artifact hashes. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md] | No user action; this is CVM attestation, not a user manifest. [VERIFIED: codebase grep] | Observe/publish/reconcile the precomputed attestation event ID; cleanup subscriptions only. [VERIFIED: codebase grep] | Relay fee policy/zero evidence; same local relay tests with distinct pubkey assertion. [VERIFIED: codebase grep] |

## Lightning and Cashu: No Fabricated Wallet Decision

Two concrete rails exist, but neither is a “wallet solution” this plan can invent:

1. **Nostr Wallet Connect (NIP-47) for a deployment/operator wallet** — suitable only if its operator creates a scoped connection with a bounded spending policy, funds it, and approves the exact certification maximum. It is not a replacement for the user manifest signer and must not be stored in the repository. [CITED: https://github.com/nostr-protocol/nips/blob/master/47.md]
2. **Cashu mint + service vault/wallet operations** — suitable only when an operator selects an allowed mint/keyset policy and funds the bounded test value; Cashu NUTs specify mint/melt/token flows, not custody or a hosted-wallet choice. [CITED: https://cashubtc.github.io/nuts/]

For v1 certification, make both rails **blocked** until the deployment session supplies their existing coordinator ports and the controller includes their bounded test value/fees in the exact request. Do not add a new wallet package or generate/persist Cashu proofs in the factory. [VERIFIED: codebase grep]

## Cost Estimation and the Current $36 Defect

The controller's current static effect plan sums to **36,000,000 USD micros ($36)** and labels its source `release-effect-plan-v1`, with a fixed 24-hour freshness window. The repository already has `createGcpCostEstimator()`, which rejects stale/non-USD/missing/region-mismatched catalog data and produces line-item/maximum/source hashes, but `controller.effectPlan()` does not consume it. [VERIFIED: codebase grep]

Replace the fixed figure before any authorization request with this evidence bundle:

1. Obtain GCP SKUs for the exact two regions and quantities; use the Billing Catalog for public prices and the Pricing API/account-specific quote where contract prices apply. [CITED: https://docs.cloud.google.com/billing/v1/how-tos/catalog-api]
2. Add fresh, hash-pinned Modal/Fly rate or usage-estimate records, the Vertex model/version price card, the selected relay/upload fee policy, and CEP-8/Cashu bounded test-value/fee quote. Each must carry observed/fresh-until timestamps and source reference. [ASSUMED]
3. Compute USD micros using exact integer arithmetic, six GCP components plus non-GCP line items, a stated bounded headroom rule, and the minimum freshness expiry. Reject mixed/expired inputs; create a new request whenever any line differs. [VERIFIED: codebase grep]
4. At completion, append actual provider receipt/usage observations to the immutable bundle; an unprovable cost stays `unknown`/blocked, never zero. [VERIFIED: codebase grep]

## Safe Plan Boundaries and Sequence

1. **Factory contracts/config:** add a deployment-only module schema and make it the sole `createReleaseExecutionSession` exporter. It receives candidate/workspace, secret references, and no raw secrets in returned state. [VERIFIED: codebase grep]
2. **Google authority first:** one ADC/project/bootstrap implementation serves Cloud Run, GCS, collector, Cloud SQL, Billing estimator, and Vertex. Implement read-only discovery before effect methods. [CITED: https://docs.cloud.google.com/run/docs/reference/authenticate-to-cloud-run-api]
3. **Worker clients:** implement Modal and Fly ports with tags equal to the original operation ID and deterministic observe/terminate paths; collect same-run comparison evidence before materialization. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox]
4. **Protocol/publication clients:** add ContextVM, Lightning receiver, Cashu mint-policy, NIP-46 signer, Blossom, and NIP-01 relay ports only behind secret-reference/config validation. The owner signer is the sole externally user-consented key operation. [CITED: https://github.com/nostr-protocol/nips/blob/master/46.md]
5. **Protected suite and finalization composition:** build all eight real ports, pass them to the existing protected registry, and provide finalization/promotion/cleanup ports. Do not add a second evaluator. [VERIFIED: codebase grep]
6. **Only then perform Plan 07-20:** authenticated discovery regenerates the exact evidence-based USD request; the user verifies/approves that digest. Plan 07-26 remains the only live protected run. [VERIFIED: codebase grep]

## No-effect Integration Test Gate

- Hash-pinned config/module: invalid path, hash, mode, credentials, export, session shape, or provider order fails before module interaction. [VERIFIED: codebase grep]
- Fake factory returns all 16 ports but a bad/stale/mismatched receipt; assert exactly zero `plan/apply/observe/cleanup`, worker, signer, relay, upload, or suite calls. [VERIFIED: codebase grep]
- Per provider: local HTTP/WebSocket fake records discovery, original operation ID, retry/ambiguity observation, and run-owned cleanup; assert no arbitrary resource ID is accepted. [VERIFIED: codebase grep]
- Google: fake ADC token and REST/LRO server; Modal/Fly: SDK/API fakes; ContextVM/NIP-46/NIP-01: local relay plus signer/wallet fakes; Blossom: local BUD server; Chromium: local pinned compatible-host fixture. [ASSUMED]
- Cost: stale, wrong-currency, unknown SKU, changed rate/quantity, expired model/rail quote, and a total over approved maximum each regenerate/block the request with zero effects. [VERIFIED: codebase grep]
- Verify the exact eight records remain independently written and that any missing/blocked/non-real record produces no bundle/promotion. [VERIFIED: codebase grep]

## Open Decisions That Cannot Be Guessed

1. Which service-controlled Lightning receiver and Cashu mint/vault satisfy the limited certification rail? This needs an operator-selected provider, scoped credential reference, and funded maximum; protocol specifications do not select one. [CITED: https://cashubtc.github.io/nuts/]
2. Does the selected Blossom target use service-scoped authorization or require the same user remote signer as the owner manifest? The answer changes only this upload consent edge, not key-custody rules. [CITED: https://github.com/hzrd149/blossom]
3. What actual account-specific non-GCP rate sources/freshness windows are accepted for Modal, Fly, relay, Blossom, and model pricing? Until configured, the request must remain blocked rather than retain $36. [ASSUMED]

## Sources

- [Cloud Run Admin API](https://docs.cloud.google.com/run/docs/reference/rest), [Cloud SQL Admin API](https://docs.cloud.google.com/sql/docs/postgres/admin-api), [Cloud Billing Catalog/Pricing guidance](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api), and [Vertex AI Gen AI SDK](https://cloud.google.com/vertex-ai/generative-ai/docs/sdks/overview) — GCP authority, API and costing facts. [CITED]
- [Modal JavaScript Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox) and [Modal JS SDK](https://modal.com/docs/sdk/js/latest) — worker lifecycle/auth facts. [CITED]
- [Fly Machines API](https://fly.io/docs/machines/api/working-with-machines-api/) — worker API/auth facts. [CITED]
- [ContextVM docs](https://docs.contextvm.org/), [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md), [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md), [Cashu NUTs](https://cashubtc.github.io/nuts/), [Blossom BUDs](https://github.com/hzrd149/blossom), and [napplet deployment docs](https://napplet.run/) — protocol boundaries. [CITED]
- Current Phase 7 contracts, native adapters, controller, materializer, finalizer, plans 07-27–07-39, coverage, and resolved bridge records — implementation gap and safety constraints. [VERIFIED: codebase grep]

## Assumptions Log

| # | Claim | Risk if wrong |
|---|---|---|
| A1 | GCS/collector can use the recommended GCP ADC REST/SDK implementation without a Bun compatibility issue. | Choose official REST wrapper or move handle into Node sidecar. |
| A2 | Modal/Fly/non-GCP services can emit deployment-account rate snapshots with bounded freshness. | USD request must stay blocked; do not fall back to $36. |
| A3 | A local HTTP/WebSocket protocol harness can faithfully exercise required port semantics before live certification. | Add provider sandbox/test-account evidence before Plan 07-26. |

## Planning Readiness

The bridge is implementation-ready, with one remaining external authority boundary: deployment-owned client/credential/rail configuration and the exact user approval. Do not run a live certification while any provider is profile-only, any cost line is stale, or an eight-suite port is non-real.
