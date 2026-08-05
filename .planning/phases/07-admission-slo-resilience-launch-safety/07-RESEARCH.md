# Phase 7: Admission SLO, Resilience & Launch Safety - Research

**Researched:** 2026-08-05
**Domain:** Evidence-backed immediate admission, recovery, observability, and release certification
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Admission SLO and Capacity Semantics

- **D-114:** The SLO clock starts when the ContextVM adapter has received and correlated the signed invocation, before funded capacity admission, and stops only when a freshly leased isolated worker passes the production readiness probe for that exact session. Record relay delivery separately; do not subtract database contention, pool misses, lease work, image start, or readiness checks from the service latency.
- **D-115:** Work is accepted only after one immediately usable capacity lease is durably bound to the owner/session/admission command. If capacity cannot be reserved inside the bounded admission deadline, return a stable retryable `capacity_unavailable` result, release/avoid every hold, and persist no generation request queue. Checkpointed paused sessions remain explicit state, never queued admission.
- **D-116:** Benchmark the existing Modal candidate and at least one credible non-AWS workspace fallback selected by current primary-source research. Measure pool hit, pool miss, cold start, step load, contention, reclaim, and failure cohorts with the production-like immutable image. Select a production worker only if the end-to-end accepted cohort is at most five seconds p95 with zero durable backlog; otherwise v1.0 promotion stays blocked.
- **D-117:** Capacity refusal is an ordinary owner-safe ContextVM result with a bounded retry hint and correlation ID. It must not disclose regional inventory, provider internals, other tenants, prices, secrets, or raw errors, and an exact duplicate must replay the same refusal without a new reservation attempt.

### Operational Telemetry and Evidence

- **D-118:** Use one versioned OpenTelemetry lifecycle vocabulary across admission, worker readiness, generation/model usage, ledger settlement, checkpoint, resume, validation, preview, publication, reconciliation, and promotion. Every span/metric is derived at trusted coordinator boundaries and carries only allowlisted correlation identities and finite outcome codes.
- **D-119:** Ordinary telemetry never contains prompts, revision text, generated source, chain-of-thought, Nostr private keys, signer material, Cashu proofs, Lightning preimages, provider credentials, native receipts, raw ContextVM envelopes, CLI output, or runtime messages. Account/session/action/operation identities are hashed or access-controlled, and all metric labels use bounded-cardinality enums rather than user/provider strings.
- **D-120:** Report admission p50/p95/p99 plus sample count and rejection rate, split by provider, region, pool hit/miss, image identity, and load cohort in evidence—not high-cardinality production metric labels. A release SLO claim names its exact window, image, regions, concurrency/step profile, failure policy, and confidence/sample threshold; vendor marketing or synthetic process start alone is never evidence.
- **D-121:** Load, chaos, security, compatibility, and supply-chain results are canonical content-addressed records referenced by one immutable release-candidate evidence bundle. Failed, skipped, missing-credential, or `not_observed` checks remain explicit and block only the claims/gates they own; no report self-assertion may substitute for executed observations.

### Failure Scope, Recovery, and Availability Claims

- **D-122:** The mandatory fault matrix covers duplicate/out-of-order relay delivery, regional ingress loss, database serialization/unavailability, capacity-provider ambiguity, worker loss at every action/checkpoint boundary, object-store interruption, model receipt ambiguity, payment notification/reconciliation, restore/expiry races, preview/source-contract invalidation, and partial publication effects. Every drill asserts no duplicate credit, debit, worker mutation, session/artifact version, checkpoint claim, deployment, owner event, or attestation.
- **D-123:** Availability claims match the topology actually deployed and tested. Multi-region ingress does not imply multi-region database/object/worker continuity; document the precise failure domain, RTO/RPO, active/standby behavior, and any single-region launch boundary. A wider claim remains blocked until its live drill passes.
- **D-124:** Recovery always resumes from the durable command/lease/intent/original-operation record. Reconciliation may observe or release the original effect but never create a replacement charge, provider call, settlement credit, signer request, relay event, deployment, or resume worker. If an outcome cannot be proved, preserve a visible unknown/blocked state.
- **D-125:** Checkpoints, sealed artifacts, validation evidence, usage receipts, promotion evidence, owner events, and attestations must be restorable and hash-verifiable after a tested infrastructure instance failure for their promised retention. Backup/object presence alone is insufficient: the drill must read, decrypt where applicable, validate identity/checksum, reattach through owner/version fences, and prove expiry/deletion behavior.

### Production Promotion and Certification

- **D-126:** Production promotion is a single fail-closed gate over exact immutable inputs: worker/control-plane images, package/lock/toolchain identities, database migrations, configuration/policy versions, SBOM/provenance, load/SLO evidence, fault-matrix results, payment/model/publication reconciliation, hostile escape/exfiltration tests, napplet conformance, compatible-host preview/signing, and release-candidate evidence digest. Missing or stale evidence cannot be waived by a green unit suite.
- **D-127:** Close the Phase 1 launch deferrals here: authoritative source provenance, repeated and cross-environment byte reproducibility, hostile/mutation coverage, reviewed content-addressed golden change, promotion-manifest completeness, SBOM/provenance enforcement, and exercised rollback/waiver behavior. NIP-5D and promoted napplet packages remain authoritative; fix/promote upstream package behavior instead of adding CVM protocol forks.
- **D-128:** Live certification includes the selected ContextVM relay/SDK path, CEP-8 Lightning and Cashu rails, model receipt/reconciliation adapter, worker and checkpoint/object adapters, compatible host preview and local/external signer, promoted CLI source/asset, upload target, relay publication, PostgreSQL/Cockroach deployment, and the Phase 6 UI-review host requirements for visible copy, responsive tokens, touch/focus/dialog/live-region behavior. Credentials absent from the environment produce explicit blocked evidence, never fabricated readiness.
- **D-129:** Preserve Phase 1's auditable owner-waiver capability only for time-bounded, named non-safety exceptions with evidence, expiry, rollback trigger, and affected release/artifact identity. NIP-5D conformance, sealed-byte/hash integrity, user-key custody, direct-authority escape, ledger imbalance/double charge, duplicate ownership/publication, missing five-second SLO evidence, and unexecuted required live certification are non-waivable for v1.0.

### the agent's Discretion

- Choose the current fallback worker candidate, target regions, load generator, sample sizes, step profile, and confidence method after primary-source research, provided D-114–D-117 remain measurable and fail closed.
- Choose OpenTelemetry exporters, dashboard/report layout, evidence schema, and safe correlation encoding while preserving D-118–D-121 and bounded cardinality.
- Choose the smallest production-like deployment topology and chaos harness that can honestly satisfy the declared launch scope; do not overclaim beyond tested failure domains.
- Choose exact promotion command/artifact names and operator presentation while preserving the immutable gate, non-waivable classes, and explicit blocked evidence.

### Deferred Ideas (OUT OF SCOPE)

- Public x402/L402 transports, rich inputs, collaboration, portable export/delete, standalone attestation verification, and service-margin pricing remain v2 requirements.
- A broader multi-region claim than the topology actually deployed and tested is deferred until matching live evidence exists.
</user_constraints>

## Project Constraints (from AGENTS.md)

- Use codebase-memory graph discovery before grep/glob for code definitions and relationships.
- Preserve the permanent napplet boundary, text-only input, ContextVM-only v1 transport, CEP-8 prepaid ledger, five-second immediate-or-rejected admission, default-deny isolation, user-key non-custody, and `@napplet/cli` deployment contract. [VERIFIED: PROJECT.md]
- Do not add a public HTTP generation API, a durable generation queue, direct authority in the napplet, or a CVM-held Nostr key. [VERIFIED: PROJECT.md]
- Do not edit implementation code outside a GSD execution workflow. This research output is the only permitted artifact for this task. [VERIFIED: AGENTS.md]

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SESS-02 | Accepted work reaches a ready isolated worker within five seconds p95 or receives immediate retryable refusal. | Receipt-to-ready clock, durable lease-before-accept, Modal/Fly benchmark protocol, and confidence gate. |
| OPS-01 | Lifecycle telemetry is measurable without prompt/key/payment-secret disclosure. | Trusted-boundary OTel vocabulary, redaction/property tests, finite attributes, OTLP collector pattern. |
| OPS-02 | Failures retain single-writer and exactly-once money/session/event semantics. | Original-operation fault matrix, Cockroach retry policy, lease fences, deterministic chaos schedules. |
| OPS-03 | Durable state survives infrastructure-instance failure for promised retention. | Object generation/checksum restore drill, GCS lifecycle/versioning limits, explicit topology/RTO/RPO evidence. |
| OPS-04 | Promotion requires pinned supply chain, adversarial/reconciliation, and SLO evidence. | Content-addressed evidence bundle, Sigstore attestation verification, non-waivable live-certification matrix. |
</phase_requirements>

## Summary

Phase 7 is a certification and integration phase, not a rewrite of admission, continuity, or publication. The graph shows already-separated `ReadyCapacityPort`, `FundedAdmissionService`, worker adapter, continuation leases, promotion candidate, and evidence modules. In particular, the admission service persists a capacity intent, claims one dispatch, reconciles ambiguity, and compensates reservations; the Modal adapter is intentionally candidate-only and already produces `blocked` evidence when live credentials are unavailable. [VERIFIED: codebase graph + `src/funding/funded-admission.ts` + `src/worker-adapters/modal-worker.ts`]

Use an explicit benchmark/certification harness around those ports. The only admission success is: signed ContextVM receipt correlated → one durable capacity/worker lease → exact-session production readiness probe passes. Anything else is either a stable refusal or an original-operation reconciliation state; it must never become a durable backlog. Modal’s official warm-pool pattern supports this readiness model, but its own sample uses a queue internally; this project must keep any ready-inventory coordination outside the user-visible accepted-work contract and prove durable generation backlog is zero. [CITED: https://modal.com/docs/examples/sandbox_pool] [VERIFIED: 07-CONTEXT.md]

The production worker decision remains unselected until comparable live evidence exists for Modal and one non-AWS fallback. Fly Machines is the strongest currently researched fallback because its official API controls fast-launching VMs programmatically; it is only a candidate, not a selected worker, until it passes the same isolated image/readiness/failure benchmark. Live ContextVM/CEP-8, payment rails, model provider, database/object topology, host/signer, CLI/upload/relay credentials are absent locally; their results must be canonical `blocked` or `not_observed` evidence and must block the gated launch claim. [CITED: https://www.fly.io/docs/machines/api/working-with-machines-api/] [VERIFIED: local environment audit]

**Primary recommendation:** Add a fail-closed release-certification harness that measures actual receipt-to-ready latency and injects failures through existing ports; select Modal or Fly only after both live cohorts meet the same evidence contract, otherwise leave promotion blocked.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Signed receipt to capacity decision | API / Backend | Database / Storage | ContextVM adapter correlates authenticated input; SQL persists idempotency/intent before capacity I/O. [VERIFIED: `src/contextvm/adapter.ts`, `src/funding/funded-admission.ts`] |
| Exact-session worker readiness | API / Backend | Isolated worker provider | Coordinator owns lease/readiness proof; worker provider only reports a constrained observation. [VERIFIED: `ReadyCapacityPort`, Modal adapter] |
| SLO telemetry and evidence | API / Backend | CDN / Static — | Trusted coordinator is the only safe telemetry producer; evidence is immutable storage, not client telemetry. [VERIFIED: D-118–D-121] |
| Checkpoint/artifact/evidence recovery | Database / Storage | API / Backend | Object bytes and SQL fences must both be verified before coordinator reattachment. [VERIFIED: D-124–D-125] |
| Control-plane regional failover | Frontend Server (SSR) — | API / Backend / Database | There is no SSR surface; regional ingress is stateless control-plane routing backed by the actual selected state topology. [VERIFIED: PROJECT.md] |
| Host preview/signing certification | Browser / Client | API / Backend | Compatible host owns presentation/signer; coordinator verifies only signed public result and owner/version fences. [VERIFIED: 07-UI-SPEC.md, Phase 6 verification] |
| Promotion gate | API / Backend | Database / Storage | Gate verifies immutable identities/evidence and writes only the candidate decision/evidence reference. [VERIFIED: `src/promotion/run-promotion.ts`] |

## Standard Stack

### Core

| Library / service | Version | Purpose | Why Standard |
|-------------------|---------|---------|--------------|
| Existing `modal` | `0.9.0` pinned | Candidate isolated worker adapter | Existing project adapter already constrains vendor objects/errors and probes isolation; official JS Sandbox API has resource, timeout, lifecycle, filesystem, and network controls. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox] |
| Fly Machines API | API current at certification | Non-AWS fallback workspace candidate | API can create/manage Machines; region-local volume semantics make external checkpoint storage mandatory. It must meet the identical test contract before selection. [CITED: https://www.fly.io/docs/machines/api/working-with-machines-api/] [CITED: https://www.fly.io/docs/machines/api/volumes-resource/] |
| CockroachDB PostgreSQL-wire deployment | Provisioned version pinned at deploy | Authoritative idempotency, funds, leases, and original-operation records | Default serializable behavior is correct only with bounded transaction-retry handling and no effects inside the retried transaction body. [CITED: https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference] |
| Cloud Run multi-region control plane | Managed, image-digest pinned | Signed ingress/coordinator replicas | Cloud Run supports a single service deployed to multiple regions; min-instance scaling applies per region. It does not prove worker or database continuity. [CITED: https://docs.cloud.google.com/run/docs/multiple-regions] |
| GCS dual-region object store | Managed, bucket config evidence pinned | Checkpoint/artifact/evidence archives | Object generation/versioning enables exact-object restore, but object versioning does not protect bucket deletion and requires lifecycle/soft-delete policy. [CITED: https://docs.cloud.google.com/storage/docs/object-versioning] |

### Supporting

| Library / tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `@opentelemetry/api` | `1.9.1` [VERIFIED: npm registry] | Manual trusted coordinator spans/metrics | Use only the reviewed lifecycle vocabulary and injected test exporter. Official docs identify it as the JS telemetry API package. [CITED: https://opentelemetry.io/docs/languages/js/exporters/] |
| `@opentelemetry/resources`, `sdk-trace-base`, `sdk-metrics` | `2.10.0` [WARNING: flagged as suspicious — verify before using.] | Resource binding and in-process trace/metric providers | Pin as one compatible family after Bun image smoke testing and human verification. These official OpenTelemetry monorepo packages were published recently and seam-rated `SUS`. [CITED: https://opentelemetry.io/docs/languages/js/exporters/] |
| `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/exporter-metrics-otlp-proto` | `0.221.0` [WARNING: flagged as suspicious — verify before using.] | OTLP HTTP/protobuf export | Export only redacted coordinator signals to a digest-pinned Collector; do not auto-instrument worker/provider data. [CITED: https://opentelemetry.io/docs/languages/js/exporters/] |
| OpenTelemetry Collector | Image digest selected in certification | OTLP receive/forward boundary | Use in protected/live tier; the official JS guidance recommends Collector export in production. [CITED: https://opentelemetry.io/docs/languages/js/exporters/] |
| Cosign / Sigstore | CLI version and identity pinned at release | Verify image/blob signatures and in-toto attestation predicates | Verify artifact digest, identity, and required predicate policy; missing/hidden attestations fail closed. [CITED: https://docs.sigstore.dev/cosign/verifying/attestation/] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Modal workspace pool | Fly Machines pool | Fly is a viable non-AWS candidate with lifecycle API control, but its region-local volumes and no measured project readiness proof mean it cannot inherit Modal eligibility. [CITED: https://www.fly.io/docs/machines/api/working-with-machines-api/] |
| Manual coordinator OTel | Automatic Node instrumentation | Do not use for v1: it could collect untrusted payloads and official Node setup does not certify Bun runtime behavior. [CITED: https://opentelemetry.io/docs/languages/js/exporters/] |
| Sigstore attestation verification | Self-authored provenance format | Do not hand-roll signatures/attestation verification; Sigstore supports in-toto predicates and policy verification. [CITED: https://docs.sigstore.dev/cosign/verifying/attestation/] |

**Installation:**

```bash
# Required only after the human checkpoint accepts the exact OTel family and Bun smoke test.
bun add --exact @opentelemetry/api@1.9.1 @opentelemetry/resources@2.10.0 \
  @opentelemetry/sdk-trace-base@2.10.0 @opentelemetry/sdk-metrics@2.10.0 \
  @opentelemetry/exporter-trace-otlp-proto@0.221.0 \
  @opentelemetry/exporter-metrics-otlp-proto@0.221.0
```

## Package Legitimacy Audit

| Package | Registry | Age / source repo | Verdict | Disposition |
|---------|----------|-------------------|---------|-------------|
| `@opentelemetry/api@1.9.1` | npm | OpenTelemetry JS repository; no postinstall | OK | Approved; official docs + registry confirm package. |
| `@opentelemetry/resources@2.10.0` | npm | OpenTelemetry JS repository; published 2026-07-21; no postinstall | SUS | Flagged — `checkpoint:human-verify` before install. |
| `@opentelemetry/sdk-trace-base@2.10.0` | npm | OpenTelemetry JS repository; published 2026-07-21; no postinstall | SUS | Flagged — `checkpoint:human-verify` before install. |
| `@opentelemetry/sdk-metrics@2.10.0` | npm | OpenTelemetry JS repository; published 2026-07-21; no postinstall | SUS | Flagged — `checkpoint:human-verify` before install. |
| `@opentelemetry/exporter-trace-otlp-proto@0.221.0` | npm | OpenTelemetry JS repository; published 2026-07-21; no postinstall | SUS | Flagged — `checkpoint:human-verify` before install. |
| `@opentelemetry/exporter-metrics-otlp-proto@0.221.0` | npm | OpenTelemetry JS repository; published 2026-07-21; no postinstall | SUS | Flagged — `checkpoint:human-verify` before install. |

**Packages removed due to [SLOP] verdict:** none.

**Packages flagged as suspicious [SUS]:** all non-API OpenTelemetry packages above. The warning is an age heuristic, not a claim of maliciousness; exact compatibility and Bun runtime behavior remain a human-gated precondition. [VERIFIED: npm registry + package-legitimacy seam]

## Architecture Patterns

### System Architecture Diagram

```text
signed ContextVM invocation
  -> adapter correlates receipt timestamp / action fingerprint
  -> serializable admission intent + one capacity-dispatch claim
  -> WorkerPoolPort (Modal candidate OR Fly candidate)
       -> immutable image -> exact-session readiness probe
       -> [ready] durable capacity/worker lease -> funded admission -> worker execution
       -> [refused/deadline] release/avoid holds -> stable capacity_unavailable
       -> [ambiguous] original intent only -> reconciliation_pending
  -> trusted coordinator emits allowlisted OTel lifecycle events
  -> canonical evidence writer
       -> content-addressed local/immutable object records
       -> release candidate gate
          -> pass only if deterministic + required live certification all pass
```

### Recommended Project Structure

```text
src/
├── admission/                    # receipt clock, capacity facade, load protocol
├── telemetry/                    # versioned allowlist, redactor, in-memory/OTLP exporters
├── certification/                # immutable observation schemas and live blocked evidence
├── resilience/                   # fault schedules, provider-neutral fault ports, restore drills
├── promotion/                    # extend candidate evidence/gate, never bypass it
└── worker-adapters/              # Modal and Fly adapters behind one readiness/lease port
tests/
├── phase-07/                     # deterministic admission, telemetry, gate tests
├── evals/                        # canonical fault/adversarial reference matrix
└── live/                         # credential-gated probes; blocked evidence when unavailable
evidence/
└── certification/                # content-addressed local output, excluded from mutable claims
```

### Pattern 1: Durable intent, then bounded capacity observation

**What:** Retain the existing `ReadyCapacityPort.reserveNow/observe/release` seam; introduce a readiness-qualified lease record containing `provider`, immutable image digest, region, exact session/action, probe digest, monotonic receipt/ready timestamps, and expiry.

**When to use:** Every initial admission and resumed worker allocation. Do not use a process-created timestamp, a free slot count, or a vendor “started” status as ready.

**Example:**

```ts
// Coordinator-owned; no vendor error or raw response may escape.
const receiptAt = clock.monotonicNow();
const intent = await capacityStore.createOrRead(command);
const observation = await capacity.reserveNow({ intentReference: intent.reference });
if (observation.status !== "available" || !passesExactSessionProbe(observation)) {
  return await refuseOrReconcileOriginalIntent(intent, observation);
}
await capacityStore.bindReadyLease({ intent, observation, receiptAt, readyAt: clock.monotonicNow() });
return fundedAdmission.accept(intent);
```

The existing admission implementation already uses durable intent, one dispatch claim, capacity observation, release compensation, and exact replay; preserve that ordering rather than replacing it. [VERIFIED: `src/funding/funded-admission.ts`]

### Pattern 2: Trusted-boundary telemetry, evidence-side dimensional analysis

**What:** Define a strict schema such as `cvm.lifecycle.v1` with finite span names/outcomes and an allowlist of hashed/access-controlled correlations. Emit p50/p95/p99 split reports from the immutable benchmark record, not from high-cardinality metric labels.

**When to use:** All coordinator transitions: `receipt`, `capacity_claim`, `worker_probe`, `admission_result`, `provider_intent`, `receipt_lookup`, `checkpoint`, `restore`, `validate`, `preview`, `publish`, `reconcile`, `promotion`.

**Example:**

```ts
// Source: OpenTelemetry JS exporter docs; attributes are locally allowlisted.
span.setAttributes({
  "cvm.lifecycle.version": "v1",
  "cvm.outcome": "capacity_refused",
  "cvm.pool_cohort": "miss",
  "cvm.image_id": imageDigestPrefix,
});
// Never attach input text, source, raw receipt/envelope, provider error, or ID as a metric label.
```

OTLP HTTP/protobuf exports traces and metrics to a Collector; use a sink-inspected exporter in fast tests and the Collector only in protected/live certification. [CITED: https://opentelemetry.io/docs/languages/js/exporters/]

### Pattern 3: Original-operation-only fault recovery

**What:** Fault injection changes the answer from an adapter (`available`, `refused`, `unknown`, lost response, serializable retry) but never removes/replaces the durable command, lease, capacity intent, debit intent, checkpoint claim, or publication operation.

**When to use:** Every D-122 fault. A test must assert effect counters against original IDs and exact durable state—not simply that an error returned.

### Pattern 4: Evidence is a verified input to promotion

**What:** Extend the existing content-addressed promotion evidence with a strict `CertificationObservation` union (`passed`, `failed`, `blocked`, `not_observed`, `stale`) that includes candidate digest, input identity, executed command/profile, observation digest, timestamp, and owned claim(s). Promotion verifies every required observation and freshness window before it can pass.

**When to use:** All live and deterministic certification results. The current promotion runner intentionally returns `blocked` at `certification-deferred`; evolve that terminal deferred stage into a complete verifier, never a boolean override. [VERIFIED: `src/promotion/run-promotion.ts`]

### Anti-Patterns to Avoid

- **Vendor-created equals ready:** require an exact-session readiness probe; Modal documents a distinct Ready lifecycle event only when a readiness probe succeeds. [CITED: https://modal.com/docs/guide/sandboxes]
- **Internal queue equals hidden backlog:** never use a durable generation queue. A worker-provider pool can maintain inventory, but its occupancy/claim state is capacity infrastructure and cannot make an accepted request wait. [VERIFIED: D-115]
- **Transaction retry wraps an external effect:** Cockroach `40001` retry handling must only retry the serializable database transaction; external effects require their own prewritten original operation and lookup reconciliation. [CITED: https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference]
- **Object exists equals restore passed:** verify exact generation, decrypt/read, checksum, owner/version/lease fence, reattachment, and expiry. [VERIFIED: D-125]
- **Metrics are a data lake:** reject unknown/free-text attributes before export; report large split dimensions inside evidence files. [VERIFIED: D-118–D-120]
- **Signature present equals provenance passed:** verify expected identity, artifact digest, and predicate policy; absence/hidden data must fail closed. [CITED: https://docs.sigstore.dev/cosign/verifying/attestation/]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Sandbox lifecycle/egress isolation | Containers or network filters in the domain layer | Modal/Fly worker adapter plus provider controls and exact-session probe | Lifecycle, network, and terminal-state behavior is provider-specific. [CITED: https://modal.com/docs/guide/sandbox-networking] |
| Telemetry protocol/export | Custom trace wire format or unbounded JSON metrics | OpenTelemetry API/SDK + OTLP Collector | Standard exporter/data model; project retains redaction vocabulary ownership. [CITED: https://opentelemetry.io/docs/languages/js/exporters/] |
| Attestation crypto/verification | Custom signing or hand-parsed provenance | Cosign/Sigstore in-toto verification plus policy | Signatures alone do not prove a predicate or availability. [CITED: https://docs.sigstore.dev/cosign/verifying/attestation/] |
| Database failover semantics | Application guesses based on connection errors | Cockroach transaction retry + durable original-operation reconciliation | A connection/retry outcome does not prove whether external work happened. [CITED: https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference] |
| GCS recovery | Object name/object presence check | Generation-pinned object fetch plus authenticated manifest/checksum/restore drill | Versioning and soft delete have distinct guarantees/limits. [CITED: https://docs.cloud.google.com/storage/docs/object-versioning] |

**Key insight:** The product’s financial/public effects already have durable identities. Phase 7 should make provider behavior observable and certifiable around those identities, not introduce a second “resilience” state machine.

## Common Pitfalls

### Pitfall 1: Measuring a shorter admission clock

**What goes wrong:** The report starts after DB/capacity work or ends when a worker process appears.

**How to avoid:** Stamp trusted monotonic time at correlated adapter receipt and exact readiness-probe success; retain both in benchmark evidence with lease/session IDs protected by access control. [VERIFIED: D-114]

### Pitfall 2: Pool contamination or expiring inventory

**What goes wrong:** A reused worker is claimed without validating image, sandbox health, tenant cleanup, remaining lifetime, or session probe.

**How to avoid:** Pool items are immutable-image, one-session leases; evict on any failed probe/expiry and prove no filesystem/process state crosses sessions. Modal’s reference pool checks health and remaining lifetime before claim. [CITED: https://modal.com/docs/examples/sandbox_pool]

### Pitfall 3: Egress default accidentally reaches production

**What goes wrong:** Modal Sandboxes have public outbound connectivity by default and the generated build or malicious dependency exfiltrates data.

**How to avoid:** `blockNetwork: true` for build/test/restore; a separately certified, narrowly scoped model gateway phase is the only possible egress exception. Domain allowlisting is beta and cannot be the only defense. [CITED: https://modal.com/docs/guide/sandbox-networking]

### Pitfall 4: Treating a multi-region control plane as end-to-end HA

**What goes wrong:** Two Cloud Run regions are reported as regional resilience despite one database, bucket, worker region, or relay topology.

**How to avoid:** Record deployed components/regions, failure domain, active/standby state, measured RTO/RPO, and claim only what the drill proves. [CITED: https://docs.cloud.google.com/run/docs/multiple-regions] [VERIFIED: D-123]

### Pitfall 5: A green unit suite promotes unavailable integrations

**What goes wrong:** Fixture results override absent ContextVM, CEP-8, rail, model, host/signer, CLI, upload, relay, or database/object observation.

**How to avoid:** Required live certification writes `blocked`/`not_observed` with a credential/topology reason and promotion verifies it as non-pass. [VERIFIED: D-121, D-128]

### Pitfall 6: OTel cardinality/privacy regression

**What goes wrong:** Raw account/action IDs, prompt fragments, provider errors, or model names become attributes/labels.

**How to avoid:** Contract-test every exporter record with forbidden canaries, length/type rules, enum-only labels, and schema-calculated maximum series; hash/access-control correlations only. [VERIFIED: D-118–D-120]

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| “Container started” operational claim | Probe-qualified ready lease plus receipt-to-ready evidence | Measures the user-visible contract, not vendor start time. [CITED: https://modal.com/docs/guide/sandboxes] |
| Raw high-cardinality metrics for every identifier | Finite OTel attributes plus protected immutable benchmark records | Operational telemetry can remain safe and usable. [VERIFIED: D-118–D-120] |
| Image signature only | Signature + attestation predicate policy + identity/digest verification | Prevents accepting a signed but wrong/incomplete provenance claim. [CITED: https://docs.sigstore.dev/cosign/verifying/attestation/] |
| Bucket presence/backup as durability | Tested read/decrypt/checksum/fence/expiry restoration | Ties an availability promise to an executed recovery observation. [VERIFIED: D-125] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Fly Machines can be configured as an isolated one-session workspace with the project’s required default-deny egress and exact readiness semantics. It is only a candidate pending live design/benchmark. | Standard Stack / Open Questions | Could make it unsuitable as Modal fallback. |
| A2 | The listed OTel packages work together under the selected Bun image. Registry existence and official JS docs do not certify Bun compatibility. | Standard Stack | Telemetry implementation could fail at runtime. |
| A3 | A specific SBOM generator/format integration can meet the release gate without extending the project’s trust boundary. | Supply-chain implementation | Could require an additional vetted tool or a revised release process. |

## Open Questions (RESOLVED)

1. **Which workspace provider wins Modal-versus-Fly certification?**
   - What we know: Modal has an existing adapter and official probe/pool/network primitives; Fly offers API-managed fast-launching VMs. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox] [CITED: https://www.fly.io/docs/machines/api/working-with-machines-api/]
   - What's unclear: Selected regions, immutable-image cold/pool/step performance, egress isolation, and p95 acceptance under the exact load profile.
   - Resolution: No provider is selected by research or deterministic tests. Plan 07-10 alone may decide Modal-versus-Fly selection from fresh protected evidence produced by the identical immutable-image benchmark, cohort, readiness, isolation, cleanup, sample, confidence, and zero-backlog contract. If either required record is absent, stale, incomplete, or non-pass, both remain unselected and promotion stays blocked. This resolves the decision procedure; it does not claim the live benchmark has run.

2. **What exact topology earns the availability claim?**
   - What we know: Cloud Run can deploy one service to multiple regions and per-region minimum instances apply. [CITED: https://docs.cloud.google.com/run/docs/multiple-regions]
   - What's unclear: Provisioned Cockroach/GCS/worker locations, relay routing, and paid-tier configuration.
   - Resolution: Availability language is bounded to the exact protected topology that passes Plan 07-10: named component and region inventory, routing, data/object/worker failure domains, active/standby behavior, executed fault/restore drills, measured RTO/RPO, and recorded limitations. Two ingress regions or structural configuration alone confer no wider database, object, relay, or worker continuity claim. Until such evidence passes, the corresponding availability claim remains blocked. This resolves claim scope; it does not assert any topology has passed.

3. **Which live profiles/credentials are available?**
   - What we know: Local audit found Bun, Node, npm, and Docker, but no Modal, Fly, gcloud, Cockroach, cosign, syft, OTel Collector, or Playwright CLI.
   - What's unclear: ContextVM relay, CEP-8 Lightning/Cashu, model, host/signer, CLI asset/upload/relay, and managed storage/database credentials.
   - Resolution: Plan 07-10 protected preflight inventories every required profile, credential reference, tool, sample, and topology input. Any absence emits candidate/input-bound `blocked` or `not_observed` evidence, exits nonzero, and blocks promotion; it is never replaced by fixture or deterministic evidence. This resolves fail-closed behavior while preserving the empirical fact that protected profile availability has not yet been observed.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Bun | local deterministic/fast test tier | ✓ | 1.3.14 | — |
| Node/npm | registry/package verification | ✓ | Node 25.2.1 / npm 11.6.2 | — |
| Docker | production-like image and Collector tests | ✓ | 28.5.2 | Local deterministic fake only; cannot certify image/Collector claim. |
| Modal CLI/credentials | Modal live certification | ✗ | — | Emit `blocked`, benchmark Fly only if its credentials exist. |
| Fly CLI/token | fallback live certification | ✗ | — | Emit `blocked`; no fallback claim. |
| gcloud credentials | Cloud Run/GCS live drills | ✗ | — | Emit `blocked`; local object-store fake is non-claim-bearing. |
| Cockroach/PostgreSQL target | SQL failover drill | ✗ | — | Existing SQL-shaped tests only; no availability claim. |
| Cosign + trusted identity | provenance verification | ✗ | — | Deterministic schema tests only; no supply-chain pass. |
| ContextVM/CEP-8/rail/model/host/signer/CLI/upload/relay credentials | end-to-end certification | ✗ | — | Explicit `not_observed` evidence; v1 promotion blocked. |

**Missing dependencies with no fallback:** all live credentials/topologies above for a v1.0 promotion claim.

**Missing dependencies with fallback:** provider CLIs may be invoked from digest-pinned protected certification images rather than installed on developer machines, but absence must still result in `blocked` evidence when the image/credential is unavailable.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Bun test 1.3.14 [VERIFIED: local environment] |
| Config file | `package.json`; no separate test config currently exists. [VERIFIED: `package.json`] |
| Fast run command | `bun test tests/phase-07 tests/evals/phase-07-reference-set.test.ts --timeout 10000` (Wave 0) |
| Medium deterministic command | `bun run eval:phase07 && bun run verify:phase07-evidence` (Wave 0 scripts) |
| Full suite command | `bun test --timeout 10000` |
| Protected live command | `bun run certify:phase07 -- --profile=release` (Wave 0; nonzero for missing required observation) |

### Tiered Test Strategy and Evidence Paths

| Tier | Runs | Must prove | Evidence path |
|------|------|------------|---------------|
| Fast (<30 s) | Unit/property/fake-provider schedules | D-114 clock inclusion, no queue/refusal replay, telemetry redaction/cardinality, original-operation effect counts, gate rejects missing/stale evidence | `evidence/design/phase-07.json` and test output |
| Medium (CI/image) | Deterministic reference corpus, toolchain/conformance, local Docker Collector, image reproducibility/mutation | 64 named cases, fault/adversarial matrix, OTel sink/OTLP schema, pinned image/lock/SBOM/provenance schema and golden/waiver behavior | `evidence/certification/<candidate>/deterministic/*.json` |
| Live (protected) | Real Modal and Fly benchmark, Cloud Run/GCS/SQL fault drills, ContextVM/CEP-8/rails/model/host/signer/CLI/upload/relay | Candidate-bound readiness p95, credentials/topology, restore/expiry, real compatibility/publication, exact provider reconciliation | `evidence/certification/<candidate>/live/*.json` |

### Fault, Load, and Adversarial Matrices

| Matrix | Minimum cases | Oracle |
|--------|---------------|--------|
| Admission load | Modal + Fly; pool hit, pool miss, cold, step load, contention, reclaim, provider ambiguity | Receipt timestamp to exact probe timestamp; p50/p95/p99, count, zero backlog, one lease/accepted request; refusal has zero hold/session. |
| Fault/recovery | Every D-122 class and each action/checkpoint/publication boundary | Original command/intent/lease only; credit/debit/worker/session/artifact/checkpoint/deploy/owner-event/attestation counters equal expected exactly. |
| Restore/retention | object interruption, corrupt/wrong generation/checksum, wrong owner/version/lease, expiry/delete, infrastructure instance loss | Read/decrypt/verify/reattach succeeds only for the exact retained object; false for every mutation/expired object. |
| Telemetry privacy | prompt/source/key/proof/preimage/credential/raw-envelope/receipt/CLI/runtime canaries; unknown attributes and cardinality bomb | No forbidden value reaches exporter; unknown record is dropped/redacted; finite violation metric only. |
| Security/host | prompt/tool injection, traversal/symlink/cross-session, egress, dependency/postinstall, direct authority, iframe spoof, host UI state/accessibility matrix | Zero forbidden effect; sealed artifact/host signer/publication identity remains exact. |
| Supply chain | changed lock/image/package/source/migration/config/policy/SBOM/provenance/golden/waiver | Candidate gate blocks every mutation/missing/stale/non-waivable waiver. |

### Phase Requirements → Verification Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SESS-02 | Receipt-to-exact-ready p95 <= 5s or immediate stable no-effect refusal | fast + protected load | `bun test tests/phase-07/admission-slo.test.ts`; `bun run certify:phase07 -- --suite=admission` | ❌ Wave 0 |
| OPS-01 | Versioned safe telemetry across lifecycle | unit/property + Collector | `bun test tests/phase-07/telemetry-policy.test.ts`; `bun run eval:phase07 -- --suite=telemetry` | ❌ Wave 0 |
| OPS-02 | No duplicate/lost state/effects through fault matrix | deterministic + protected chaos | `bun test tests/evals/phase-07-reference-set.test.ts`; `bun run certify:phase07 -- --suite=chaos` | ❌ Wave 0 |
| OPS-03 | Real restore, identity/fence/expiry, instance-failure claim | deterministic + protected restore | `bun test tests/phase-07/restore-drill.test.ts`; `bun run certify:phase07 -- --suite=restore` | ❌ Wave 0 |
| OPS-04 | Candidate blocks missing/stale/mutated evidence; live gate closes all prerequisites | unit + protected release | `bun test tests/phase-07/promotion-gate.test.ts`; `bun run candidate:verify` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** focused fast test plus `bun test --timeout 10000` for changes crossing admission, persistence, worker, promotion, or publication boundaries.
- **Per wave merge:** `bun run eval:phase07 && bun run verify:phase07-evidence`.
- **Release candidate:** 100% of certification traces and reports retained in the immutable bundle; at least 1,000 accepted observations for the selected SLO cohort and at least 200 each forced pool-hit and pool-miss/cold-contention cohorts, as locked by the AI-SPEC. [VERIFIED: 07-AI-SPEC.md]
- **Phase gate:** full suite green plus all required live observations `passed` and fresh; any `blocked`, `not_observed`, `failed`, `skipped`, or stale required observation blocks promotion.

### Wave 0 Gaps

- [ ] `src/telemetry/contracts.ts`, `src/telemetry/redaction.ts`, `src/telemetry/otel.ts` — versioned safe lifecycle vocabulary and test exporter.
- [ ] `src/certification/contracts.ts`, `src/certification/evidence.ts` — strict content-addressed observation and freshness schema.
- [ ] `src/resilience/fault-harness.ts`, `src/admission/benchmark.ts` — provider-neutral schedules, monotonic timing, confidence report.
- [ ] `src/worker-adapters/fly-worker.ts` — candidate-only Fly implementation, only after provider API/credential checkpoint.
- [ ] `tests/phase-07/*.test.ts`, `tests/evals/phase-07-reference-set.test.ts`, `tests/fixtures/phase-07-reference-set.json` — all named deterministic requirements/matrix cases.
- [ ] `scripts/eval-phase-07.ts`, `scripts/verify-phase-07-evidence.ts`, `scripts/certify-phase-07.ts` — deterministic verification and protected live blocked-evidence runner.
- [ ] `07-VALIDATION.md` — generate from this validation map before execution.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | ContextVM verified pubkey only; no private-key custody. [VERIFIED: PROJECT.md] |
| V3 Session Management | yes | Session/action/version/lease fences and owner-safe status outputs. [VERIFIED: existing continuity/persistence modules] |
| V4 Access Control | yes | Closed grants, exact-session worker leases, original-operation-only reconciliation. [VERIFIED: Phase 2–6 context] |
| V5 Input Validation | yes | Strict Zod parsing at ContextVM, provider, telemetry, evidence, host, and restore boundaries. [VERIFIED: existing code pattern] |
| V6 Cryptography | yes | SHA-256 identity checks; use Sigstore/Cosign for release attestation verification, never custom signatures. [CITED: https://docs.sigstore.dev/cosign/verifying/attestation/] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Replayed/duplicate signed request or relay delivery | Repudiation / Tampering | Fingerprinted idempotency + durable result/original operation; test exact replay refusal/acceptance. |
| Capacity/pool ambiguity triggers duplicate worker/hold | Tampering | One durable dispatch claim; compensate/reconcile original capacity reference only. [VERIFIED: `FundedAdmissionService`] |
| Generated code/dependency exfiltration | Information Disclosure | Default `blockNetwork`, no worker credentials, egress canaries, terminate/quarantine on violation. [CITED: https://modal.com/docs/guide/sandbox-networking] |
| Telemetry secret/free-text leakage | Information Disclosure | Schema allowlist/redaction before exporter and canary inspection. [VERIFIED: D-118–D-119] |
| Lost/forged provenance | Tampering | Verify signer identity, exact digest, and in-toto predicate policy; fail closed on absence. [CITED: https://docs.sigstore.dev/cosign/verifying/attestation/] |
| Failover retries external money/publication | Tampering | SQL retry only for transaction; lookup/reconcile original external operation, never redispatch. [CITED: https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference] |

## Sources

### Primary (MEDIUM confidence)

- [Modal Sandboxes](https://modal.com/docs/guide/sandboxes) — lifecycle, readiness probes, timeouts, JavaScript controls.
- [Modal Sandbox networking](https://modal.com/docs/guide/sandbox-networking) and [warm pool example](https://modal.com/docs/examples/sandbox_pool) — default outbound behavior, blocking/allowlists, health/readiness/expiry handling.
- [Modal JavaScript Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox) — JS creation parameters and lifecycle operations.
- [Cloud Run multi-region deployment](https://docs.cloud.google.com/run/docs/multiple-regions) and [Cloud Storage object versioning](https://docs.cloud.google.com/storage/docs/object-versioning) — per-region scaling and versioning/soft-delete limits.
- [Cockroach transaction retry reference](https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference) — serializable `40001` retry semantics.
- [OpenTelemetry JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/) and [OTLP exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) — Collector, OTLP exports/endpoints.
- [Sigstore in-toto attestations](https://docs.sigstore.dev/cosign/verifying/attestation/) and [verification guidance](https://docs.sigstore.dev/cosign/verifying/verify/) — predicate/digest/identity verification and fail-closed caveat.
- [ContextVM docs](https://docs.contextvm.org/) — ContextVM/CEP-8 documentation entry point.
- [napplet runtime and CLI overview](https://napplet.run/) and [NIP-5D guide](https://napplet.run/docs/guide/nip-5d.html) — host-brokered signer/relay and CLI publication boundary.
- [Fly Machines API](https://www.fly.io/docs/machines/api/working-with-machines-api/) and [volume API](https://www.fly.io/docs/machines/api/volumes-resource/) — fallback candidate lifecycle and regional persistence semantics.

### Internal (HIGH confidence)

- `07-CONTEXT.md`, `07-UI-SPEC.md`, `07-AI-SPEC.md`, `REQUIREMENTS.md`, `06-VERIFICATION.md` — locked scope, live-certification gates, UI host evidence, and requirements.
- Codebase graph and `src/funding/funded-admission.ts`, `src/worker-adapters/modal-worker.ts`, `src/promotion/run-promotion.ts`, `src/contextvm/adapter.ts` — existing seams and current blocked/candidate behavior.

## Metadata

**Confidence breakdown:**

- Standard stack: MEDIUM — official vendor docs confirm capabilities; local topology, credentials, and Bun/provider compatibility remain unobserved.
- Architecture: HIGH — graph/code confirms existing admission, worker, persistence, and promotion boundaries.
- Pitfalls: MEDIUM — vendor/database/OTel/Sigstore primary docs confirm mechanics; actual severity under selected topology must be measured.

**Research date:** 2026-08-05

**Valid until:** 7 days for provider/package/live-integration details; rerun before selecting a vendor or installing the flagged OTel packages.
