# Requirements: napplet-cvm

**Defined:** 2026-08-03
**Core Value:** A user can describe one focused applet and receive a safe, conformant napplet that can be previewed and placed directly into a compatible napplet runtime.
**Owning Milestone:** v1.0 — Safe Napplet Generation MVP

Every requirement under `v1 Requirements` is owned by milestone v1.0 and retains exactly one existing Phase 1–7 assignment. The `v2 Requirements` section remains deferred and is not part of v1.0 completion.

## v1 Requirements

Requirements for the initial release. Each maps to exactly one roadmap phase.

### ContextVM and Identity

- [x] **CTX-01**: A user can discover the CVM and its supported generation, account, top-up, session, preview, and publication capabilities through a signed ContextVM announcement.
- [x] **CTX-02**: A signed ContextVM request resolves to one stable account identified by the user's Nostr public key without a password or service-held user secret.
- [x] **CTX-03**: Replaying or redelivering the same signed ContextVM request returns its durable prior result without repeating a state change, charge, credit, worker action, or publication.
- [x] **CTX-04**: A user can query their current balance, active and resumable sessions, pending actions, and settlement states through ContextVM.

### Funding and Settlement

- [x] **PAY-01**: A user can invoke a separate CEP-8 top-up capability and choose a mutually supported payment method through PMI negotiation.
- [x] **PAY-02**: A user can fund their account by paying a Lightning BOLT11 request whose settlement is verified before credit is posted.
- [x] **PAY-03**: A user can fund their account with Cashu from a configured trusted mint only after token amount, unit, mint, and spendability are verified.
- [x] **PAY-04**: A user can see each top-up move through explicit pending, settled, credited, or failed states with its amount, unit, rail, and settlement reference.
- [x] **PAY-05**: A verified settlement credits the user's balance exactly once even when payment notifications, relay messages, or client requests are duplicated.
- [x] **PAY-06**: An operator can configure and rotate an allowlist containing multiple trusted Cashu mints without changing historical settlement records.
- [x] **PAY-07**: Accepted Cashu value is automatically reconciled into treasury settlement records without crediting the user twice or treating an unspendable token as settled value.

### Metering and Spend Safety

- [x] **BILL-01**: Before the first billable action, a user explicitly approves a maximum spend for the session in a disclosed currency unit.
- [x] **BILL-02**: The service authorizes each billable action before execution and never spends beyond the lesser of the user's funded balance and remaining approved session cap.
- [x] **BILL-03**: After a completed action, the service debits the authoritative measured API usage exactly once using the price version that applied when the action was authorized.
- [x] **BILL-04**: A user can inspect an immutable line item for every hold, release, debit, credit, and reconciliation, including provider usage inputs and remaining balance/cap.
- [x] **BILL-05**: A timed-out or ambiguous provider request enters an explicit reconciliation state and is not blindly retried or double charged.
- [x] **BILL-06**: Unused funded balance and unused session cap remain available and are never converted into an undisclosed fixed generation fee or automatic overage.

### Session Admission and Interaction

- [x] **SESS-01**: A user can start a generation session using one bounded plain-text napplet idea and no file, image, URL, repository, or existing-code input.
- [ ] **SESS-02**: An accepted request obtains a ready isolated worker and begins execution within five seconds at p95; otherwise the user receives an immediate retryable capacity response.
- [x] **SESS-03**: A user receives a stable session identifier plus visible state, progress, approved cap, actual spend, and next required action.
- [x] **SESS-04**: A user can submit bounded plain-text revisions to the same session, with each revision separately authorized and metered.
- [x] **SESS-05**: Concurrent or duplicated session actions are serialized so only one valid next action can mutate a session or artifact version.

### Napplet Generation and Verification

- [x] **GEN-01**: The agent scaffolds every new napplet through the promoted authoritative napplet CLI/boilerplate compatibility set and follows the installed `@napplet/skills` workflow.
- [x] **GEN-02**: The agent generates only a small, single-purpose NIP-5D napplet/nsite and rejects or narrows requests for arbitrary websites, full-stack applications, or generated backends.
- [x] **GEN-03**: Generated application code uses promoted `@napplet/sdk`/NAP interfaces and declares only the hard capabilities required for the focused napplet to function.
- [x] **GEN-04**: Each artifact is built reproducibly with pinned dependencies and passes the maintained verification command, forbidden-authority checks, and real-Chromium conformance suite.
- [x] **GEN-05**: The agent may repair a failing artifact only while the next repair action remains within the funded balance, approved cap, and permanent napplet policy.
- [x] **GEN-06**: A failed or incomplete artifact is returned only with diagnostics and evidence; it is never labeled previewable or publishable.

### Defensive Execution

- [x] **SAFE-01**: The service rejects prompt and revision input that exceeds configured character, token, encoding, or structural limits before allocating billable execution.
- [x] **SAFE-02**: The service detects and records prompt-injection and jailbreak signals while enforcing deterministic policy independently of classifier output.
- [x] **SAFE-03**: The agent can use only typed, allowlisted tools scoped to the current session and cannot alter billing, session authority, publication intent, or system policy.
- [x] **SAFE-04**: Each worker is isolated from other sessions, has no user/control-plane credentials or durable authority, and uses default-deny network egress through scoped gateways.
- [x] **SAFE-05**: Dependency resolution and build scripts are pinned, policy-checked, resource-bounded, and prevented from accessing control-plane secrets or unrestricted networks.
- [x] **SAFE-06**: Static and runtime checks reject direct `fetch`, XHR, WebSocket, browser storage, cookies, `window.nostr`, external asset loading, service workers, app-owned signing/relay code, or any bypass of shell-mediated NAP authority.

### Funding Interruption and Resume

- [x] **CONT-01**: Before an action that the remaining balance or cap cannot cover, the service reaches a durable safe boundary instead of starting the action or failing the session.
- [x] **CONT-02**: A paused user sees a `needs_top_up` state containing the pending action, required additional funding, current balance/cap, and ten-minute live-worker deadline.
- [x] **CONT-03**: A verified top-up completed within ten minutes resumes the same fenced live worker only after the pending action is re-authorized.
- [x] **CONT-04**: At the ten-minute deadline the service writes a complete durable checkpoint and releases the live worker without continuing to spend.
- [ ] **CONT-05**: A checkpoint preserves the conversation, agent state, workspace, artifact versions, validation evidence, ledger/action identifiers, pending action, and compatible toolchain metadata in encrypted immutable storage.
- [x] **CONT-06**: After the live window, a later top-up does not restart work automatically; the user must send an explicit signed resume command and approve the displayed pending action.
- [x] **CONT-07**: A checkpoint is resumable for 30 days, cannot create two active workers or duplicate prior charges on resume, and is securely expired after the retention window.

### Preview and Compatibility

- [ ] **PREV-01**: A user can preview only the exact immutable aggregate-hash artifact that passed all required validation gates.
- [ ] **PREV-02**: Preview runs in a compatible NIP-5D shell using `sandbox="allow-scripts"` without `allow-same-origin`, with all sensitive actions brokered through supported NAP domains.
- [ ] **PREV-03**: Before publication, a user can inspect the napplet's required and optional NAP capabilities, the consent implications of each, and compatibility against the selected runtime.
- [ ] **PREV-04**: Preview reports unsupported capabilities clearly and verifies graceful degradation instead of enabling a direct-authority fallback.

### Publication and Provenance

- [ ] **PUB-01**: After preview, a user can explicitly create a publication intent bound to the exact artifact hash, d-tag, capability set, account, and session.
- [ ] **PUB-02**: The trusted runtime or external signer presents the exact owning manifest to the user and returns a user-signed event without exposing the user's private key to the CVM.
- [ ] **PUB-03**: The CVM verifies the user signature and signs a separate build attestation binding the artifact hash, toolchain/policy versions, validation evidence, timestamp, and source session.
- [ ] **PUB-04**: Publication through the promoted `@napplet/cli` contract deploys the sealed bytes and returns links/identifiers that bind the deployment, user manifest, CVM attestation, and aggregate hash.
- [ ] **PUB-05**: A duplicate or timed-out publication request reconciles the persisted intent and exact signed events without rebuilding, re-signing, double deploying, or emitting a conflicting ownership event.

### Availability and Operations

- [ ] **OPS-01**: The service exposes measured request-receipt-to-worker-ready latency, capacity rejection, generation, payment, checkpoint, resume, validation, and publication telemetry without leaking prompts, keys, or payment secrets.
- [ ] **OPS-02**: Regional, relay, database, worker, or publication failures preserve single-writer ledger/session semantics and do not lose committed progress or duplicate money and event effects.
- [ ] **OPS-03**: Checkpoints, sealed artifacts, validation evidence, usage receipts, and attestations remain durably available for their promised retention across an infrastructure instance failure.
- [ ] **OPS-04**: Production promotion requires pinned images/packages, SBOM and provenance evidence, adversarial prompt/escape/exfiltration tests, payment and publication reconciliation tests, and measured five-second p95 load evidence.

## v2 Requirements

Deferred until the v1 creation loop and its trust boundaries are validated.

### Pricing Experience

- **COST-01**: A user receives a pre-run cost estimate derived from observed usage without weakening the hard session cap.
- **COST-02**: An operator can configure and disclose a service-margin policy independently of raw provider usage.

### User Data and Verification

- **DATA-01**: A user can export a portable session checkpoint before expiry.
- **DATA-02**: A user can explicitly delete a retained checkpoint before its automatic expiry.
- **ATST-01**: A user can verify a CVM build attestation through a standalone verifier independent of the generation service.

### Additional Adapters and Inputs

- **ADPT-01**: A client can access the transport-neutral generation core through an x402 HTTP adapter.
- **ADPT-02**: A client can access the transport-neutral generation core through an L402 HTTP/gRPC adapter.
- **INPT-01**: A user can provide explicitly supported rich inputs only after separate provenance, malware, licensing, privacy, and cost controls exist.
- **COLL-01**: Multiple principals can collaborate in one session with explicit ownership, spend-cap consent, checkpoint privacy, and publication rules.

## Out of Scope

Explicitly excluded to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Arbitrary websites, full-stack apps, or generated backends | The product generates only focused, sandboxed napplets. |
| Direct browser/network/storage/signer/relay authority | Violates the NIP-5D shell-mediated security contract. |
| Service custody or delegation of a user's private key | User ownership requires local/external signing without CVM key access. |
| Automatic publication after generation | The user must preview and explicitly approve the exact artifact. |
| Overages, automatic top-ups, or automatic cap increases | These undermine prepaid spend safety. |
| Automatic resume after the ten-minute live window | A later deposit must not cause surprise spending. |
| Durable request queue | Conflicts with the immediate-start-or-reject contract. |
| Preview of failed or unverified artifacts | Diagnostics are allowed; runtime preview is reserved for verified immutable builds. |
| Indefinite abandoned checkpoint retention | v1 checkpoints expire after 30 days. |
| Public HTTP, x402, or L402 access in v1 | ContextVM is the only v1 public adapter. |

## Traceability

Milestone v1.0 owns every row in this table. Existing requirement IDs and phase assignments are authoritative and unchanged.

| Phase | v1.0 requirement groups | Count | Current status |
|-------|--------------------------|------:|----------------|
| Phase 1 | GEN-01–GEN-04, SAFE-05–SAFE-06 | 6 | Complete |
| Phase 2 | SESS-05, SAFE-01–SAFE-04 | 5 | Complete |
| Phase 3 | CTX-01–CTX-04, PAY-01–PAY-07, BILL-01–BILL-02, BILL-06 | 14 | Complete |
| Phase 4 | BILL-03–BILL-05, SESS-01, SESS-03–SESS-04, GEN-05–GEN-06 | 8 | Complete |
| Phase 5 | CONT-01–CONT-07 | 7 | Pending |
| Phase 6 | PREV-01–PREV-04, PUB-01–PUB-05 | 9 | Pending |
| Phase 7 | SESS-02, OPS-01–OPS-04 | 5 | Pending |

| Requirement | Phase | Status |
|-------------|-------|--------|
| CTX-01 | Phase 3 | Complete |
| CTX-02 | Phase 3 | Complete |
| CTX-03 | Phase 3 | Complete |
| CTX-04 | Phase 3 | Complete |
| PAY-01 | Phase 3 | Complete |
| PAY-02 | Phase 3 | Complete |
| PAY-03 | Phase 3 | Complete |
| PAY-04 | Phase 3 | Complete |
| PAY-05 | Phase 3 | Complete |
| PAY-06 | Phase 3 | Complete |
| PAY-07 | Phase 3 | Complete |
| BILL-01 | Phase 3 | Complete |
| BILL-02 | Phase 3 | Complete |
| BILL-03 | Phase 4 | Complete |
| BILL-04 | Phase 4 | Complete |
| BILL-05 | Phase 4 | Complete |
| BILL-06 | Phase 3 | Complete |
| SESS-01 | Phase 4 | Complete |
| SESS-02 | Phase 7 | Pending |
| SESS-03 | Phase 4 | Complete |
| SESS-04 | Phase 4 | Complete |
| SESS-05 | Phase 2 | Complete |
| GEN-01 | Phase 1 | Complete |
| GEN-02 | Phase 1 | Complete |
| GEN-03 | Phase 1 | Complete |
| GEN-04 | Phase 1 | Complete |
| GEN-05 | Phase 4 | Complete |
| GEN-06 | Phase 4 | Complete |
| SAFE-01 | Phase 2 | Complete |
| SAFE-02 | Phase 2 | Complete |
| SAFE-03 | Phase 2 | Complete |
| SAFE-04 | Phase 2 | Complete |
| SAFE-05 | Phase 1 | Complete |
| SAFE-06 | Phase 1 | Complete |
| CONT-01 | Phase 5 | Pending |
| CONT-02 | Phase 5 | Pending |
| CONT-03 | Phase 5 | Pending |
| CONT-04 | Phase 5 | Pending |
| CONT-05 | Phase 5 | Pending |
| CONT-06 | Phase 5 | Pending |
| CONT-07 | Phase 5 | Pending |
| PREV-01 | Phase 6 | Pending |
| PREV-02 | Phase 6 | Pending |
| PREV-03 | Phase 6 | Pending |
| PREV-04 | Phase 6 | Pending |
| PUB-01 | Phase 6 | Pending |
| PUB-02 | Phase 6 | Pending |
| PUB-03 | Phase 6 | Pending |
| PUB-04 | Phase 6 | Pending |
| PUB-05 | Phase 6 | Pending |
| OPS-01 | Phase 7 | Pending |
| OPS-02 | Phase 7 | Pending |
| OPS-03 | Phase 7 | Pending |
| OPS-04 | Phase 7 | Pending |

**Coverage:**

- v1 requirements: 54 total
- Owned by milestone v1.0: 54
- Mapped to phases: 54
- Unmapped: 0 ✓
- Complete: 25
- Execution complete; verification pending: 0
- Pending: 29

---
*Requirements defined: 2026-08-03*
*Last updated: 2026-08-04 after Phase 3 completion; requirement IDs and phase assignments unchanged*
