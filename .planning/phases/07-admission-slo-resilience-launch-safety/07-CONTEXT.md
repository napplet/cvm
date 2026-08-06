# Phase 7: Admission SLO, Resilience & Launch Safety - Context

**Gathered:** 2026-08-05
**Status:** Ready for research and planning
**Mode:** Autonomous smart discuss; recommendations resolved from locked prior decisions and the user's standing autonomy direction

<domain>
## Phase Boundary

Phase 7 turns the completed deterministic napplet-cvm design into an honestly certifiable v1.0 release. It measures the signed-request-receipt-to-isolated-worker-ready path, makes capacity admission immediate-or-rejected with no durable generation queue, adds redacted operational telemetry, proves recovery across the deployment scope without duplicate financial/session/publication effects, certifies the selected live integrations, and blocks production promotion until all required load, security, supply-chain, compatibility, UI-host, and recovery evidence exists.

This phase owns `SESS-02` and `OPS-01` through `OPS-04`, plus the launch-hardening work explicitly deferred by Phases 1–6. It may select and certify providers only from measured evidence. It does not add x402/L402, rich inputs, automatic publication/resume/top-up, user-key custody, arbitrary app generation, or a durable request queue.

</domain>

<decisions>
## Implementation Decisions

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
- **D-128:** Live certification includes the selected ContextVM relay/SDK path, CEP-8 Lightning and Cashu rails, model receipt/reconciliation adapter, worker and checkpoint/object adapters, compatible host preview and local/external signer, promoted CLI source/asset, upload target, relay publication, Cloud SQL for PostgreSQL deployment, and the Phase 6 UI-review host requirements for visible copy, responsive tokens, touch/focus/dialog/live-region behavior. Credentials absent from the environment produce explicit blocked evidence, never fabricated readiness.
- **D-129:** Preserve Phase 1's auditable owner-waiver capability only for time-bounded, named non-safety exceptions with evidence, expiry, rollback trigger, and affected release/artifact identity. NIP-5D conformance, sealed-byte/hash integrity, user-key custody, direct-authority escape, ledger imbalance/double charge, duplicate ownership/publication, missing five-second SLO evidence, and unexecuted required live certification are non-waivable for v1.0.
- **D-130:** Cloud SQL for PostgreSQL is the sole Phase 7 database authority. Current and future authoritative runtime, provider, setup, research, verification, and operator instructions must not introduce a CockroachDB or ccloud path; completed summaries and immutable historical evidence remain untouched.
- **D-131:** Provider-neutral `ReleaseProviderPort` contracts and the release controller remain the primary provisioning abstraction. Cloud SQL is a selected provider detail, while Modal and Fly remain measured worker variants whose selection is evidence-driven under the identical certification schedule.
- **D-132:** The controller creates the exact authorization request before any live effect. It binds ISO-4217 currency `USD`, a bounded maximum in micros, estimate source and freshness, bounded run duration, cleanup and retention, provider account/project scopes, GCP project bootstrap/billing/API-enablement effects, candidate/topology/effect/state digests, expiry, and the expected receipt. Any stale input or changed state invalidates the request and requires regeneration.
- **D-133:** The user supplies only official provider login or consent when authentication requires it and one exact digest approval or verification. The controller derives provider configuration, topology, trust inputs, evidence, bounded cost, and cleanup; it never persists credentials and performs no live effect before the exact approval receipt validates.

### the agent's Discretion

- Choose the current fallback worker candidate, target regions, load generator, sample sizes, step profile, and confidence method after primary-source research, provided D-114–D-117 remain measurable and fail closed.
- Choose OpenTelemetry exporters, dashboard/report layout, evidence schema, and safe correlation encoding while preserving D-118–D-121 and bounded cardinality.
- Choose the smallest production-like deployment topology and chaos harness that can honestly satisfy the declared launch scope; do not overclaim beyond tested failure domains.
- Choose exact promotion command/artifact names and operator presentation while preserving the immutable gate, non-waivable classes, and explicit blocked evidence.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets

- `FundedAdmissionService`, `ReadyCapacityPort`, and `createFundedCore` already implement reserve-now-or-refuse semantics, compensation, durable ambiguity, owner-safe results, and the seam where receipt-to-ready telemetry must begin/end.
- `ModalWorkerAdapter`, `observeLiveModalIsolation`, `WorkerPort`, leases, deterministic worker doubles, and checkpoint lifecycle ports provide a vendor-neutral live-probe surface without moving provider authority into the domain core.
- Funding, metering, continuation, publication, and reconciliation stores already persist intent before effect and retain original operation identities; Phase 7 should drive fault injection through these seams rather than introduce a parallel orchestrator.
- Content-addressed evidence writers, promotion manifests/candidate detection, Phase 2–6 design evidence, and the Phase 6 validated source-provenance contract provide the release-candidate evidence foundation.
- ContextVM announcement/adapter, safe status schemas, and the Phase 6 host-surface/UI review provide the public operational and compatible-host integration points.

### Established Patterns

- External inputs and provider results are parsed into strict finite contracts before authority or claims are granted.
- Exact replay and original-operation reconciliation are normal paths; ambiguity is visible and never resolved by blind redispatch.
- Provider/platform evidence is separated from domain correctness, and `not_observed` never becomes readiness.
- Package-native napplet behavior remains authoritative beneath NIP-5D; the CVM composes and certifies it rather than cloning it.
- Planning/release evidence is content-addressed and public/status output is an explicit allowlist.

### Integration Points

- Instrument signed ContextVM receipt, funded capacity claim, worker lease/readiness, and refusal without changing transport-neutral admission semantics.
- Add production-like load/fault drivers around `ReadyCapacityPort`, `WorkerPort`, SQL/object adapters, payment/model gateways, continuation coordinator, and publication ports.
- Extend verification/evidence and promotion modules with live observation records, SBOM/provenance, reproducibility/golden, host UI, and release-gate aggregation.
- Keep control-plane deployment/provider configuration behind adapters; no new public HTTP generation surface enters v1.

</code_context>

<specifics>
## Specific Ideas

- The user wants something cutting edge, non-AWS where practical, billed by the second or minute, and able to start isolated work in seconds; selection must follow measured production-like evidence rather than preference alone.
- “No queues” means accepted work starts now; capacity pressure is returned fluidly as a retryable refusal without taking funds or hiding backlog.
- The trust model does not need ceremony during design, but Phase 7 is the point where launch claims become evidence-backed and fail closed.
- Napplet packages chase NIP-5D and remain trusted; certification should surface upstream defects for package fixes rather than create local compatibility forks.

</specifics>

<deferred>
## Deferred Ideas

- Public x402/L402 transports, rich inputs, collaboration, portable export/delete, standalone attestation verification, and service-margin pricing remain v2 requirements.
- A broader multi-region claim than the topology actually deployed and tested is deferred until matching live evidence exists.

</deferred>

---

*Phase: 7-Admission SLO, Resilience & Launch Safety*
*Context gathered: 2026-08-05*
