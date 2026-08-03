# Roadmap: napplet-cvm

## Overview

napplet-cvm moves from proving the permanent napplet contract to a safe, prepaid creation loop: a user funds a Nostr-linked account, starts and revises a constrained agent session, previews the exact verified artifact, and explicitly publishes a user-owned manifest with CVM provenance. Phases follow the trust and state dependencies that make that loop credible: the artifact boundary and worker containment precede money; durable authorization and metering precede continuation; sealed preview precedes publication; and the five-second start promise is accepted only after it is measured under integrated production conditions.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Napplet Contract & Artifact Verification** - Prove a pinned toolchain can produce only conformant, independently verifiable napplets.
- [ ] **Phase 2: Trusted Core & Isolated Agent Execution** - Establish deterministic policy, serialized state, and a fenced worker boundary.
- [ ] **Phase 3: ContextVM Funding & Funded Admission** - Provide Nostr-linked accounts, CEP-8 top-ups, and safe prepaid authorization.
- [ ] **Phase 4: Metered Generation & Revision Loop** - Turn approved funds into exact-usage, constrained generation and repair actions.
- [ ] **Phase 5: Funding Interruption & Durable Resume** - Preserve safely-paused work through the ten-minute grace window and 30-day checkpoints.
- [ ] **Phase 6: Sealed Preview & User-Owned Publication** - Let users inspect, preview, sign, attest, and deploy one immutable artifact identity.
- [ ] **Phase 7: Admission SLO, Resilience & Launch Safety** - Validate immediate capacity handling and safe operation through failure, load, and supply-chain gates.

## Phase Details

### Phase 1: Napplet Contract & Artifact Verification

**Goal**: A verified artifact can only be a small, single-purpose NIP-5D napplet created and validated by one promoted, reproducible toolchain.
**Depends on**: Nothing (first phase)
**Requirements**: GEN-01, GEN-02, GEN-03, GEN-04, SAFE-05, SAFE-06
**Success Criteria** (what must be TRUE):

  1. A tester can create a focused napplet only from the promoted authoritative scaffold/CLI compatibility set, following the installed `@napplet/skills` workflow and declaring only its necessary NAP capabilities.
  2. A tester receives a reproducible, aggregate-hash artifact and evidence only after its pinned dependency build passes the maintained verification command and real-Chromium conformance suite.
  3. A request or generated bundle that attempts an arbitrary/full-stack app or direct browser, network, storage, signer, relay, external-asset, or service-worker authority is rejected rather than being treated as a conformant artifact.
  4. Dependency installation and build scripts stay resource-bounded and policy-checked, with no route to control-plane secrets or unrestricted network access.

**Validation gate**: Resolve `@napplet/cli` provenance and prove one pinned `create → init → skills install → build → verify → test:conformance → dry-run publish` fixture against the authoritative scaffold, SDK, NIP-5D/NAP contract, and Chromium suite. Until this gate passes, automated publication is not claimed.
**Plans:** 2/11 plans executed

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Prove the candidate-manifest-to-bounded-command-to-canonical-evidence tracer.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Detect immutable candidates and assemble evidence-bound review input without install or promotion authority.

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 01-03-PLAN.md — Review the exact CLI/package/source provenance before candidate image intake.

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 01-04-PLAN.md — Materialize the reviewed image and enforce the sealed default-deny Docker promotion path.

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 01-05-PLAN.md — Prove the focused fixture and select compatible NAP paths from the same exact passing candidate.

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 01-06-PLAN.md — Implement focused-scope, dependency, authority-gap, and capability-necessity policy.
- [ ] 01-07-PLAN.md — Prove two-clean-build byte identity and stage immutable pending golden review inputs.

**Wave 7** *(blocked on Wave 6 completion)*

- [ ] 01-08-PLAN.md — Run hostile source and mutation cases through the sealed native-first gate.

**Wave 8** *(blocked on Wave 7 completion)*

- [ ] 01-09-PLAN.md — Enforce promotion state, hard blockers, narrow waivers, and layered evidence.

**Wave 9** *(blocked on Wave 8 completion)*

- [ ] 01-10-PLAN.md — Review the exact candidate evidence and pending golden bytes.

**Wave 10** *(blocked on Wave 9 completion)*

- [ ] 01-11-PLAN.md — Materialize approved goldens and atomically promote the reviewed immutable toolchain.

**Cross-cutting constraints:**

- Candidate identity includes every protocol, package, executable, lockfile, scaffold, image, runtime, browser, fixture, golden, and policy pin required by D-04.

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
**Plans**: TBD

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
**Plans**: TBD

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
**Plans**: TBD

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

**Plans**: TBD

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
**Plans**: TBD
**UI hint**: yes

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
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Napplet Contract & Artifact Verification | 2/11 | In Progress|  |
| 2. Trusted Core & Isolated Agent Execution | 0/TBD | Not started | - |
| 3. ContextVM Funding & Funded Admission | 0/TBD | Not started | - |
| 4. Metered Generation & Revision Loop | 0/TBD | Not started | - |
| 5. Funding Interruption & Durable Resume | 0/TBD | Not started | - |
| 6. Sealed Preview & User-Owned Publication | 0/TBD | Not started | - |
| 7. Admission SLO, Resilience & Launch Safety | 0/TBD | Not started | - |
