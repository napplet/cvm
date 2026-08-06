# Roadmap: napplet-cvm

## Overview

napplet-cvm moves from proving the permanent napplet contract to a safe, prepaid creation loop: a user funds a Nostr-linked account, starts and revises a constrained agent session, previews the exact verified artifact, and explicitly publishes a user-owned manifest with CVM provenance. Phases follow the trust and state dependencies that make that loop credible: the artifact boundary and worker containment precede money; durable authorization and metering precede continuation; sealed preview precedes publication; and the five-second start promise is accepted only after it is measured under integrated production conditions.

## Active Milestone: v1.0 — Safe Napplet Generation MVP

**Goal:** A funded ContextVM user can submit a bounded idea and receive a safe, conformant, resumable, user-owned napplet that can be previewed and placed into a compatible napplet runtime.

**Scope:** All existing Phases 1–7 below. The milestone adds no phases or product scope; it is the parent outcome those phases already implement.

### Milestone Traceability

| Phase | How it advances v1.0 | Requirement ownership | Planning and verification artifacts |
|-------|----------------------|-----------------------|-------------------------------------|
| 1. Napplet Contract & Artifact Verification | Establishes the permanent conformant-napplet boundary and representative fail-closed evidence consumed by every later artifact path. | GEN-01–GEN-04, SAFE-05–SAFE-06 | `.planning/phases/01-napplet-contract-artifact-verification/` — context, discussion log, research, patterns, 6 plans, 6 summaries, blocker record, coverage, validation, review/fix, security audit, verification, and deferred-items record. |
| 2. Trusted Core & Isolated Agent Execution | Establishes bounded admission, serialized durable session authority, typed worker capabilities, isolation, checkpoint shape, and provider-separated evidence. | SESS-05, SAFE-01–SAFE-04 | `.planning/phases/02-trusted-core-isolated-agent-execution/` — context, research, AI spec, validation, coverage, source audit, 6 plans, 6 summaries, review/fix, security audit, and goal verification. |
| 3. ContextVM Funding & Funded Admission | Connects signed ContextVM identity and CEP-8 Lightning/Cashu settlement to one idempotent prepaid account and capped funded admission. | CTX-01–CTX-04, PAY-01–PAY-07, BILL-01–BILL-02, BILL-06 | `.planning/phases/03-contextvm-funding-funded-admission/` — context, discussion log, research, patterns, API coverage, validation, source audit, 7 plans and summaries, review/fix history, final clean review, security audit, and passed goal verification. |
| 4. Metered Generation & Revision Loop | Turns approved funds into exact-usage, serialized napplet creation, revision, repair, progress, and diagnostic actions. | BILL-03–BILL-05, SESS-01, SESS-03–SESS-04, GEN-05–GEN-06 | `.planning/phases/04-metered-generation-revision-loop/` — context, discussion log, research, AI spec, patterns, validation, 7 plans and summaries, review/fix history, immutable design evidence, security audit, and passed goal verification. |
| 5. Funding Interruption & Durable Resume | Preserves paid work across insufficient funds, the ten-minute live-worker window, explicit resume, and 30-day checkpoint retention. | CONT-01–CONT-07 | `.planning/phases/05-funding-interruption-durable-resume/` — context, research, patterns, validation, 7 plans and summaries, review/fix history, security audit, immutable design evidence, and passed goal verification. |
| 6. Sealed Preview & User-Owned Publication | Lets the user preview the exact verified artifact, retain signing custody, and explicitly deploy a manifest plus CVM attestation. | PREV-01–PREV-04, PUB-01–PUB-05 | `.planning/phases/06-sealed-preview-user-owned-publication/` — context, approved UI spec, current research, pattern map, API/source coverage, draft validation strategy, and 7 checker-approved plans across 6 waves; execution evidence remains pending. |
| 7. Admission SLO, Resilience & Launch Safety | Measures immediate-or-rejected admission, proves integrated failure safety, and closes the launch-hardening work deferred from Phase 1. | SESS-02, OPS-01–OPS-04 | `.planning/phases/07-admission-slo-resilience-launch-safety/` — 40/45 plans executed and summarized; phase goal verification remains blocked on protected live evidence. |

The phase-to-requirement assignments in this table are identical to `REQUIREMENTS.md` and the phase detail sections below. Existing paths are canonical; future phase artifacts are added to their numbered phase directories without moving or regenerating prior work.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Napplet Contract & Artifact Verification** - Prove a pinned toolchain can produce only conformant, independently verifiable napplets. (completed 2026-08-04)
- [x] **Phase 2: Trusted Core & Isolated Agent Execution** - Establish deterministic policy, serialized state, and a fenced worker boundary. (completed 2026-08-04)
- [x] **Phase 3: ContextVM Funding & Funded Admission** - Provide Nostr-linked accounts, CEP-8 top-ups, and safe prepaid authorization. (completed 2026-08-04)
- [x] **Phase 4: Metered Generation & Revision Loop** - Turn approved funds into exact-usage, constrained generation and repair actions. (completed 2026-08-05)
- [x] **Phase 5: Funding Interruption & Durable Resume** - Preserve safely-paused work through the ten-minute grace window and 30-day checkpoints. (completed 2026-08-05)
- [x] **Phase 6: Sealed Preview & User-Owned Publication** - Let users inspect, preview, sign, attest, and deploy one immutable artifact identity. (completed 2026-08-05)
- [ ] **Phase 7: Admission SLO, Resilience & Launch Safety** - Validate immediate capacity handling and safe operation through failure, load, and supply-chain gates.

## Phase Details

### Phase 1: Napplet Contract & Artifact Verification

**Goal**: Establish an executable napplet-only artifact contract and prove one representative NIP-5D creation/verification path that downstream product phases can build on.
**Depends on**: Nothing (first phase)
**Requirements**: GEN-01, GEN-02, GEN-03, GEN-04, SAFE-05, SAFE-06
**Success Criteria** (what must be TRUE):

  1. A tester can create a focused napplet only from the promoted authoritative scaffold/CLI compatibility set, following the installed `@napplet/skills` workflow and declaring only its necessary NAP capabilities.
  2. A tester receives an aggregate-hash artifact and representative evidence only after its pinned dependency build passes the maintained verification command and a real-Chromium conformance path.
  3. A request or generated bundle that attempts an arbitrary/full-stack app or direct browser, network, storage, signer, relay, external-asset, or service-worker authority is rejected rather than being treated as a conformant artifact.
  4. Dependency installation and build scripts stay resource-bounded and policy-checked, with no route to control-plane secrets or unrestricted network access.

**Validation gate**: Resolve one coherent `@napplet/cli` candidate and prove one pinned `create → init → skills install → frozen install → build → verify → test:conformance` fixture against the authoritative napplet packages and NIP-5D/NAP boundary. Phase 1 establishes the contract and evidence shape; exhaustive provenance, reproducibility, hostile-matrix, golden, waiver, and production-promotion certification is deferred to Phase 7.
**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Prove the candidate-manifest-to-bounded-command-to-canonical-evidence tracer.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Detect immutable candidates and assemble evidence-bound review input without install or promotion authority.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-03-PLAN.md — Review the exact CLI/package/source provenance before candidate image intake.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-04-PLAN.md — Materialize the reviewed image and enforce the sealed default-deny Docker promotion path.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 01-05-PLAN.md — Materialize the approved coherent CLI 0.5.2 set and prove one focused package-native/Chromium fixture.

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 01-06-PLAN.md — Prove representative SDK capability composition, fail-closed napplet-only policy, rejection evidence, and one aggregate design record.

**Cross-cutting constraints:**

- Candidate, image, native report, artifact, aggregate, and policy identities remain explicit and fail closed.
- Phase 1 produces design-verification evidence only; it does not create a production promoted pointer or claim the launch-hardening gates deferred to Phase 7.

### Phase 2: Trusted Core & Isolated Agent Execution

**Goal**: Untrusted text and agent activity are contained by a transport-neutral authority that serializes valid actions and never grants the worker control over money, session authority, or publication.
**Depends on**: Phase 1
**Requirements**: SESS-05, SAFE-01, SAFE-02, SAFE-03, SAFE-04
**Success Criteria** (what must be TRUE):

  1. A user submitting text that exceeds configured character, token, encoding, or structural limits receives a rejection before billable execution or worker allocation.
  2. Prompt-injection and jailbreak signals are recorded while deterministic policy continues to enforce the same allowed behavior regardless of classifier output.
  3. A session worker can use only typed, allowlisted tools scoped to its own session and cannot alter billing, session state, publish intent, or system policy.
  4. One user’s worker cannot read another session or control-plane credentials, and it has default-deny network egress except through scoped gateways.
  5. Simultaneous or duplicate session actions leave the user with one durable valid next state and artifact version, never competing mutations.

**Validation gate**: Select the worker implementation only after a production-like sandbox demonstrates per-session isolation, default-deny egress, scoped gateway behavior, browser/build support, and checkpoint export semantics. Modal is an initial candidate behind `WorkerPort`, not an assumed decision.
**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Prove the bounded-admission-to-versioned-action-to-mediated-tool-to-evidence tracer.

**Wave 2** *(after Wave 1; plans execute in parallel)*

- [x] 02-02-PLAN.md — Lock canonical text limits and restrictive-only classifier semantics.
- [x] 02-03-PLAN.md — Lock exact replay, conflict, stale, interruption, and concurrent transaction semantics.
- [x] 02-04-PLAN.md — Prove the closed tool gateway and deterministic isolated WorkerPort fake.

**Wave 3** *(after scoped WorkerPort contracts)*

- [x] 02-05-PLAN.md — Implement the opt-in Modal candidate adapter and honest passed/failed/blocked probe.

**Wave 4** *(after all deterministic expansions and provider observation)*

- [x] 02-06-PLAN.md — Compose the hardened core, run the 16-case eval, and emit provider-separated design evidence.

### Phase 3: ContextVM Funding & Funded Admission

**Goal**: A Nostr user can safely discover the service, fund one stable prepaid account, inspect its state, and authorize work without duplicate credits or undisclosed charges.
**Depends on**: Phase 2
**Requirements**: CTX-01, CTX-02, CTX-03, CTX-04, PAY-01, PAY-02, PAY-03, PAY-04, PAY-05, PAY-06, PAY-07, BILL-01, BILL-02, BILL-06
**Success Criteria** (what must be TRUE):

  1. A user can discover signed ContextVM generation, account, top-up, session, preview, and publication capabilities, and signed requests resolve to the same Nostr-public-key account without a password or service-held secret.
  2. A user can choose a mutually supported CEP-8 payment method and fund their account with a verified Lightning BOLT11 payment or trusted-mint Cashu value.
  3. A user can inspect each top-up’s pending, settled, credited, or failed state and their current balance; duplicate relay, notification, and client deliveries return durable results without repeating credits or other state changes.
  4. Before funded work is admitted, a user approves a disclosed maximum spend, and the service authorizes no more than the lesser of their balance and remaining cap while preserving all unused balance and cap.
  5. An operator can rotate the multi-mint Cashu allowlist while historical settlement records remain intact and reconciled treasury value cannot produce a duplicate credit.

**Validation gate**: Pin and contract-test current ContextVM/CEP-8 announcement, signed-event, replay, PMI, Lightning receipt, and Cashu settlement wire details against maintained fixtures before exposing the public adapter.
**Plans**: 7/7 plans executed

Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Prove the transport-neutral verified-account, exactly-once credit, cap-hold, admission, status, and replay tracer.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-02-PLAN.md — Admit exact integration packages automatically and implement the serializable PostgreSQL-wire monetary authority.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-03-PLAN.md — Publish truthful signed discovery and translate verified ContextVM/CEP-8 requests into durable funding commands.
- [x] 03-04-PLAN.md — Create service-owned Lightning top-ups and credit authoritative settled receipts exactly once.
- [x] 03-05-PLAN.md — Enforce versioned trusted-mint Cashu policy, online settlement, proof uniqueness, and non-crediting treasury reconciliation.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 03-06-PLAN.md — Couple approved cap holds to immediately usable capacity and expose the final redacted funded-account composition.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 03-07-PLAN.md — Execute the complete deterministic reference set and emit immutable provider-separated Phase 3 design evidence.

### Phase 4: Metered Generation & Revision Loop

**Goal**: A funded user can create, revise, repair, and inspect a constrained napplet session while every billable action is authorized, exact-usage metered, and serialized.
**Depends on**: Phase 3
**Requirements**: BILL-03, BILL-04, BILL-05, SESS-01, SESS-03, SESS-04, GEN-05, GEN-06
**Success Criteria** (what must be TRUE):

  1. A user can start a session from one bounded plain-text napplet idea, receive a stable session identifier with progress, approved cap, actual spend, and next required action, and submit bounded text-only revisions.
  2. Each generation, revision, or repair action is re-authorized before it starts and debits authoritative measured API usage exactly once using the price version in effect at authorization.
  3. A user can inspect immutable holds, releases, debits, credits, and reconciliation line items with provider usage inputs and remaining balance/cap.
  4. A timed-out or ambiguous provider request becomes a visible reconciliation state rather than being blindly retried or double charged.
  5. A failed or incomplete build returns diagnostics and validation evidence—not a previewable or publishable result—and any repair remains within the user’s cap, balance, and napplet policy.

**Validation gate**: Promote a model provider/proxy only if it can reserve an action ceiling, correlate authoritative usage receipts to the action, preserve a price version, and reconcile timeout ambiguity. Otherwise the service must pause in `usage_unknown` rather than assert an exact final charge.
**Plans**: 7/7 plans executed

- [x] 04-07-PLAN.md

**Wave 1**

- [x] 04-01-PLAN.md — Prove the funded start tracer with durable provider intent, exact receipt settlement, and one verified artifact advance.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 04-02-PLAN.md — Persist atomic PostgreSQL settlement, immutable billing history, and crash-safe replay.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 04-03-PLAN.md — Fence ambiguous provider operations in `usage_unknown` and reconcile only the original operation.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 04-04-PLAN.md — Add same-lineage revisions, honest artifact outcomes, and one separately authorized repair.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 04-05-PLAN.md — Expose owner-safe status and the three locked ContextVM generation/session tools.

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 04-06-PLAN.md — Seal the phase with twenty deterministic cases and content-addressed design evidence.

### Phase 5: Funding Interruption & Durable Resume

**Goal**: A user never loses paid session progress when funds run short, while no later deposit can silently restart or duplicate work.
**Depends on**: Phase 4
**Requirements**: CONT-01, CONT-02, CONT-03, CONT-04, CONT-05, CONT-06, CONT-07
**Success Criteria** (what must be TRUE):

  1. Before an unaffordable pending action starts, the session reaches a durable safe boundary and shows `needs_top_up` with its pending action, required funding, balance/cap, and ten-minute live-worker deadline.
  2. A verified top-up within ten minutes resumes only the same fenced live worker after the pending action is re-authorized.
  3. At the ten-minute deadline, the worker is released without further spend and the user’s encrypted immutable checkpoint preserves the conversation, agent state, workspace, artifact versions, validation evidence, ledger/action IDs, pending action, and compatible toolchain metadata.
  4. After the live window, a top-up alone does not restart work; a user must issue a signed explicit resume command and approve the displayed pending action.
  5. For 30 days a checkpoint can resume without two active workers or duplicate charges, then it expires securely and cannot be revived.

**Plans**: 7/7 plans executed

**Wave 1**

- [x] 05-01-PLAN.md — Prove the unaffordable-action pause tracer and precise owner-safe `needs_top_up` status.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 05-02-PLAN.md — Create the atomic durable continuation authority and PostgreSQL-wire parity.
- [x] 05-03-PLAN.md — Seal complete checkpoints and extend lease-bound worker lifecycle contracts.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 05-04-PLAN.md — Implement same-worker grace wake and deadline checkpoint/release ordering.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 05-05-PLAN.md — Add signed explicit `resume_session` and exactly-once checkpoint restore.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 05-06-PLAN.md — Enforce exact, race-safe, irreversible 30-day checkpoint expiry.

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 05-07-PLAN.md — Seal Phase 5 with deterministic reference coverage and immutable design evidence.

### Phase 6: Sealed Preview & User-Owned Publication

**Goal**: A user can inspect, preview, and explicitly publish one immutable verified napplet while retaining sole control of their private key and manifest signature.
**Depends on**: Phase 5
**Requirements**: PREV-01, PREV-02, PREV-03, PREV-04, PUB-01, PUB-02, PUB-03, PUB-04, PUB-05
**Success Criteria** (what must be TRUE):

  1. A user can preview only the exact immutable aggregate-hash artifact that passed validation, in a compatible NIP-5D `sandbox="allow-scripts"` shell without `allow-same-origin`.
  2. Before publishing, a user can inspect required and optional NAP capabilities, their consent implications, and compatibility with the selected runtime; unsupported capabilities are reported with graceful degradation rather than a direct-authority fallback.
  3. A user can explicitly create a publication intent binding their account, session, d-tag, capability set, and exact artifact hash, then locally sign the exact owning manifest through a trusted runtime or external signer without the CVM receiving their private key.
  4. The CVM verifies the user signature, creates a separate build attestation bound to the artifact, toolchain/policy versions, validation evidence, timestamp, and source session, and deploys the sealed bytes through the promoted `@napplet/cli` contract.
  5. A duplicate or timed-out publication request reconciles persisted intent and exact signed events, returning linked deployment/manifest/attestation identifiers without rebuilding, re-signing, double deploying, or creating conflicting ownership.

**Validation gate**: Verify the selected runtime can display and locally sign the exact manifest, resolve the promoted `@napplet/cli` deployment contract, and prove deploy-byte/hash continuity with end-to-end fixtures before calling the publication flow available.
**Plans**: 7/7 plans executed
**UI hint**: yes

Plans:

**Wave 1**

- [x] 06-01-PLAN.md — Prove the exact sealed-artifact-to-linked-publication end-to-end tracer.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 06-02-PLAN.md — Complete sealed preview, runtime status, and required/optional capability review.
- [x] 06-03-PLAN.md — Bind publication intent, external owner signing, exact event verification, and separate attestation.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 06-04-PLAN.md — Persist publication intent and effect state with memory, SQLite, and PostgreSQL parity.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 06-05-PLAN.md — Probe the promoted CLI source contract and implement exact-byte, reconciled publication effects.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 06-06-PLAN.md — Expose preview and user-owned publication through ContextVM and the narrow host surface.

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 06-07-PLAN.md — Seal deterministic reference coverage and content-addressed Phase 6 design evidence.

### Phase 7: Admission SLO, Resilience & Launch Safety

**Goal**: The integrated service can honestly promise immediate-or-rejected work and preserve money, sessions, artifacts, and publication effects through production failures.
**Depends on**: Phase 6
**Requirements**: SESS-02, OPS-01, OPS-02, OPS-03, OPS-04
**Success Criteria** (what must be TRUE):

  1. An accepted user request reaches an isolated ready worker within five seconds at p95, or the user immediately receives a retryable capacity response; no durable request queue is created.
  2. Operators can measure receipt-to-worker-ready latency, capacity rejections, generation, settlement, checkpoint, resume, validation, and publication outcomes without exposing prompts, keys, or payment secrets.
  3. Regional, relay, database, worker, and publication failures retain committed checkpoints, artifacts, evidence, usage receipts, and attestations while preserving single-writer session/ledger semantics and preventing duplicate money or events.
  4. A production promotion is blocked until pinned images and packages, SBOM/provenance, adversarial prompt/escape/exfiltration tests, payment/publication reconciliation tests, and five-second-p95 load evidence are available.

**Validation gate**: Benchmark Modal and at least one non-AWS fallback with the production-like image, target regions, relay delay, pool misses, database contention, reclaim/failure behavior, and step load. Select a worker vendor only after receipt-to-isolated-worker-ready p95 is at most five seconds with zero durable backlog; establish the database/failover claim to match the chosen deployment scope.

Phase 7 also closes the launch-hardening work intentionally deferred from Phase 1: exhaustive toolchain provenance, repeated/cross-environment reproducibility, full hostile and mutation coverage, formal golden approval, waiver drills, SBOM/provenance enforcement, and the final production promotion gate.
**Plans**: 44/47 plans executed
**Wave 1**

- [x] 07-00-PLAN.md
- [x] 07-01-PLAN.md

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07-02-PLAN.md
- [x] 07-05-PLAN.md
- [x] 07-08-PLAN.md

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07-03-PLAN.md
- [x] 07-06-PLAN.md

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07-04-PLAN.md
- [x] 07-07-PLAN.md

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 07-09-PLAN.md

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 07-10-PLAN.md

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 07-11-PLAN.md — Enforce immutable digest-bound delegated operator approval for the exact OpenTelemetry package set.

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 07-12-PLAN.md — Dispatch typed protected live adapters and route exact release bundles through the sole promotion decision.

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 07-13-PLAN.md — Derive public release verification exit status from the sole promotion decision.

**Wave 10** *(blocked on Wave 9 completion)*

- [x] 07-14-PLAN.md — Bind funded admission to canonical invocation identity and close its wire projection.

**Wave 11** *(blocked on Wave 10 completion)*

- [x] 07-15-PLAN.md — Enforce two-isolation reproducibility plus pinned Cosign/SBOM/provenance verification.

**Wave 12** *(blocked on Wave 11 completion)*

- [x] 07-16-PLAN.md — Require verified supply-chain records at protected certification and sole promotion boundaries.

**Wave 13** *(blocked on Wave 12 completion)*

- [x] 07-17-PLAN.md — Bind exact source bytes and Cosign/SBOM expectations to independent release policy.

**Wave 14** *(blocked on Wave 13 completion)*

- [x] 07-18-PLAN.md — Load and own the pinned protected certifier root at the release-promotion entrypoint.

**Wave 15** *(blocked on Wave 14 completion)*

- [x] 07-19-PLAN.md — Add the project-owned release controller, topology intent, provider discovery, and authorization-required dry run.

**Wave 16** *(blocked on Wave 15 completion)*

- [x] 07-21-PLAN.md — Implement and contract-test concrete resumable provider adapters locally without live effects.

**Wave 17** *(blocked on Wave 16 completion)*

- [x] 07-22-PLAN.md — Implement and contract-test controller-generated certifier configuration, adapter bundles, evidence trees, and trust material in isolated non-authoritative roots.

**Wave 18** *(blocked on Wave 17 completion)*

- [x] 07-23-PLAN.md — Implement and contract-test admission, telemetry, chaos, and restore adapters without provider effects or protected evidence.
- [x] 07-24-PLAN.md — Implement and contract-test security-host, supply-chain, payment/model, and publication adapters without spend, signing, publication, or protected evidence.

**Wave 19** *(blocked on Wave 18 completion)*

- [x] 07-25-PLAN.md — Finish the exact-eight registry, resumable controller, sole-evaluator/bundle/cleanup wiring, product command, documentation, and negative contract tests without external effects.

**Wave 20** *(blocked on Wave 19 completion)*

- [x] 07-27-PLAN.md — Correct current Cloud SQL/provider authority, capability coverage, verification expectations, and operator guidance without rewriting history.

**Wave 21** *(blocked on Wave 20 completion)*

- [x] 07-28-PLAN.md — Bind an exact USD cost/effect/scope/state authorization request and receipt to a zero-effect controller boundary.

**Wave 22** *(blocked on Wave 21 completion)*

- [x] 07-29-PLAN.md — Implement receipt-gated GCP project/billing/API bootstrap and fresh bounded Catalog pricing.
- [x] 07-32-PLAN.md — Implement Modal/Fly native providers and identical evidence-driven worker benchmark cohorts.
- [x] 07-33-PLAN.md — Compose real ContextVM and CEP-8 Lightning/Cashu adapters through existing domain ports.
- [x] 07-34-PLAN.md — Compose a real authoritative model dispatch/usage/reconciliation adapter.
- [x] 07-35-PLAN.md — Compose real compatible-host/browser and external user-owned signer adapters.

**Wave 23** *(blocked on Wave 22 completion)*

- [x] 07-30-PLAN.md — Implement Cloud Run multi-region and live Collector native providers.
- [x] 07-31-PLAN.md — Implement versioned GCS and sole-authority Cloud SQL PostgreSQL native providers.
- [x] 07-36-PLAN.md — Compose promoted napplet CLI, upload, owner-relay, and attestation-relay adapters.

**Wave 24** *(blocked on Wave 23 completion)*

- [x] 07-37-PLAN.md — Assemble all production provider families and exactly eight real protected suite ports.

**Wave 25** *(blocked on Wave 24 completion)*

- [x] 07-38-PLAN.md — Execute the exact-receipt controller through native provisioning, materialization, resume, and exact-eight evidence.

**Wave 26** *(blocked on Wave 25 completion)*

- [x] 07-39-PLAN.md — Finalize through the sole evaluator, immutable bundle, promotion, cleanup, and complete product-command resume.

**Wave 27** *(blocked on Wave 26 completion)*

- [x] 07-40-PLAN.md — Add the controller-generated hash-pinned deployment factory/config and structured official approval receipt with no-effect rejection.

**Wave 28** *(blocked on Wave 27 completion)*

- [x] 07-41-PLAN.md — Implement shared Google and Modal/Fly clients plus price/actual-cost contracts using fake/local verification; run no live provider or benchmark effects.

**Wave 29** *(blocked on Wave 28 completion)*

- [x] 07-42-PLAN.md — Implement separately testable ContextVM, payment, Vertex, host/NIP-46, CLI/upload, and relay clients with fake/local verification and explicit key custody.

**Wave 30** *(blocked on Wave 29 completion)*

- [x] 07-43-PLAN.md — Wire the exact-eight real port constructors, identical benchmark runners, complete execution inputs, and fake-only forced-resume proof without running live suites/schedules.

**Wave 31** *(blocked on Wave 30 completion)*

- [x] 07-44-PLAN.md — Generate the fresh sixteen-line request and prove one-command no-effect readiness/config/consent-descriptor behavior; allow authenticated read-only scope/price discovery only.

**Wave 32** *(blocked on Wave 31 completion)*

- [x] 07-45-PLAN.md — Compose authoritative sixteen-family current pricing and service-owned funding prerequisites; keep owner NIP-46 at real publication.

**Wave 33** *(blocked on Wave 32 completion)*

- [ ] 07-46-PLAN.md — Generate the protected config and concrete complete factory/session, then prove one-command zero-effect readiness.

**Wave 34** *(blocked on Wave 33 completion)*

- [ ] 07-20-PLAN.md — Connect any missing operator NWC Lightning and funded Cashu certification rails locally, then approve the exact structured request; owner NIP-46 remains deferred to real publication.

**Wave 35** *(blocked on Wave 34 completion)*

- [ ] 07-26-PLAN.md — Run the authorized controller through provisioning, discovery, all eight real protected suites, trust finalization, sole evaluation, actual-cost reconciliation, immutable bundle assembly, and bounded cleanup.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Napplet Contract & Artifact Verification | 6/6 | Complete    | 2026-08-04 |
| 2. Trusted Core & Isolated Agent Execution | 6/6 | Complete    | 2026-08-04 |
| 3. ContextVM Funding & Funded Admission | 7/7 | Complete    | 2026-08-04 |
| 4. Metered Generation & Revision Loop | 7/7 | Complete    | 2026-08-05 |
| 5. Funding Interruption & Durable Resume | 7/7 | Complete    | 2026-08-05 |
| 6. Sealed Preview & User-Owned Publication | 7/7 | Complete    | 2026-08-05 |
| 7. Admission SLO, Resilience & Launch Safety | 44/47 | In Progress|  |

### Milestone Progress Roll-up

- **Phases:** Phases 1–6 are verified complete; Phase 7 awaits protected live evidence and goal verification; 6/7 phases complete (86%).
- **Known plans:** 83/87 milestone plans executed. Plans 07-45–07-46 close the authoritative catalog, operator-funding prerequisite, concrete protected factory/config, and truthful one-command readiness gaps before 07-20 approval and 07-26 execution.
- **v1 requirements:** 54/54 assigned to exactly one Phase 1–7 owner; 49 verified complete and 5 Phase 7 requirements pending.
- **Current checkpoint:** Execute 07-45 then 07-46; use 07-20 only to connect any missing local operator NWC Lightning and funded Cashu certification rails plus final exact approval, then run 07-26 protected live certification. Future napplet-owner NIP-46 signing occurs during publication, not candidate certification.
- **Phase 1 preservation:** Phase 1 remains complete with its review, security, validation, verification evidence, and Phase 7 deferrals unchanged.

### Completion Reporting Contract

Every future phase completion report must include this milestone roll-up: milestone ID/name, phases completed/active/remaining, executed plan counts, v1 requirement completion/coverage, and the next milestone checkpoint. A phase-only completion summary is insufficient for v1.0 tracking.
