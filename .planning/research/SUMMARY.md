# Project Research Summary

**Project:** napplet-cvm  
**Domain:** prepaid, Nostr-native agent service for producing conformant NIP-5D napplets  
**Researched:** 2026-08-03  
**Confidence:** MEDIUM

## Executive Summary

napplet-cvm is not a general AI app builder. It is a ContextVM/CEP-8 v1 service that accepts bounded text, charges exact confirmed usage from a Nostr-public-key-linked prepaid account, and produces only small, single-purpose NIP-5D napplets. The permanent product boundary is an opaque-origin napplet sandbox: generated artifacts use the authoritative scaffold and typed NAP capabilities, never direct browser storage, networking, relay, signer, shell, or service-key access. Preview is permitted only for a sealed, independently verified aggregate-hash build; publication is a separate two-signature flow in which the user signs their own manifest and the CVM signs only provenance.

Build this as a transport-neutral TypeScript core with serializable financial/session state, an append-only ledger, durable checkpoints and idempotent outboxes. ContextVM over Nostr and CEP-8 are thin v1 adapters; they do not own money, state transitions, or workers. Per-session workers are disposable strongly isolated sandboxes with no durable authority, no credentials, and default-deny egress. Admission must reserve both spend headroom and a ready fenced worker before accepting an action. If the isolated worker cannot become ready within the five-second p95 start budget, reject with a retryable capacity response: there is no durable request queue.

The design is coherent, but its most important external assumptions are not yet decisions: ContextVM/CEP-8 and NIP-5D are alpha/living protocols; the napplet CLI/package ecosystem has a version-source split; and no vendor documentation proves the end-to-end five-second SLO. Roadmap work should lock the domain invariants now while treating protocol compatibility, CLI promotion, exact model receipts, and Modal/alternative-worker readiness as explicit acceptance gates rather than facts implied by package versions or marketing.

## Key Findings

### Recommended Stack

The recommended implementation shape is a pinned TypeScript/Bun control plane on warm Google Cloud Run instances, a PostgreSQL-wire strongly transactional ledger/session store, dual-region immutable object storage, and a warm pool of Modal JavaScript Sandboxes for the only v1 agent/build workspace. Cloud Run is a control-plane choice, not an untrusted build environment; Modal is a provisional worker-plane choice behind a `WorkerPort`, not a permanent vendor lock-in. The database must serialize all account debits, holds, leases, idempotency records, and publication intent; checkpoints and evidence are content-addressed objects referenced by committed metadata.

Package versions in [STACK.md](./STACK.md) are useful starting pins, not roadmap commitments. The `@napplet` toolchain must be promoted only as a tested compatibility set from the authoritative scaffold through real-Chromium conformance and dry-run publish. In particular, `@napplet/cli` provenance/version must be resolved before production publication is claimed.

**Core technologies:**

- **TypeScript 5.9.x + Bun >=1.2.0:** shared, transport-neutral core and ContextVM-compatible control-plane runtime; pin image digests after interoperability testing.
- **Cloud Run + health-checked regional ingress:** warm ContextVM/Nostr adapter and coordinator replicas; duplicate relay delivery is expected and must be harmless.
- **Serializable PostgreSQL-compatible database:** append-only ledger, reservations, sessions, leases, idempotency keys, and transactional outbox; no KV or mutable balance is authoritative.
- **Dual-region object storage:** encrypted, immutable 30-day checkpoints, build artifacts, conformance evidence, and attestations.
- **Modal Sandboxes behind `WorkerPort`:** per-session isolated workspace with a prebuilt image and warm inventory; default-deny network and no control-plane/user credentials.
- **Pinned napplet toolchain:** authoritative CLI/scaffold, `@napplet/skills`, SDK, Vite manifest tooling, and Chromium conformance gate; never hand-write manifest/publication behavior.

### Expected Features

All v1 table stakes are tightly coupled: ContextVM discovery and stable pubkey accounts; CEP-8 Lightning/Cashu top-ups; a hard session cap with exact per-action receipts; immediate bounded generation and text-only revisions; scaffolded build/repair/conformance; exact-hash sandbox preview; explicit user-signed publication plus CVM attestation; and top-up/checkpoint continuity. None should be presented as optional polish, because omitting any one breaks the trust model or the promised creation loop.

**Must have (table stakes):**

- Signed ContextVM discovery/invocation mapped idempotently to a Nostr-pubkey account.
- CEP-8 top-up capability for Lightning and trusted-mint Cashu, credited exactly once after verified settlement.
- User-approved cap plus reserve-then-finalize exact-usage ledger; show holds, settled use, remaining cap, price version, and reconciliation state.
- Accept-now-or-reject admission, isolated generation, bounded text revisions, and visible progress—never a hidden durable queue.
- Authoritative scaffold/skills, forbidden-authority checks, reproducible build, and real-browser conformance before preview.
- Preview of the exact verified aggregate hash in an `allow-scripts`-only NIP-5D shell.
- Explicit user-owned manifest signing after preview; CVM attestation and idempotent deployment/publication reconciliation.
- Safe insufficient-funds pause: live continuation only within ten minutes, then explicit resume from a 30-day durable checkpoint.

**Should have after the core loop is proven:**

- Capability-minimal manifest/consent presentation and richer runtime compatibility reporting.
- Cost estimates/margin policy informed by observed metered usage, without weakening the cap.
- Checkpoint export/delete controls and attestation-verifier UX.
- Expanded trusted-Cashu-mint policy and treasury operations only after one safe flow is operational.

**Defer (v2+ or permanent boundary):**

- x402/L402 public adapters and collaborative sessions; retain ports only in v1.
- Images, files, URLs, repositories, existing-code ingestion, arbitrary websites, full-stack apps, or generated backends.
- Direct browser/network/signer/relay/storage authority, service custody of user keys, automatic publication, automatic post-window resume, overages, auto-top-ups, and durable generation queues.

### Architecture Approach

Use ports-and-adapters around a trusted modular core. The adapter verifies signed/replayed ContextVM messages and translates CEP-8 settlements; the core serializes identity, idempotency, ledger, session, policy, and publication intent; the worker is a fenced executor; an independent verifier rebuilds/tests untrusted output; and a publication coordinator performs the user-signature/CVM-attestation/deployment saga. The central rule is that a worker or relay message never authorizes a debit, state transition, or publish by itself.

**Major components:**

1. **ContextVM/CEP-8 adapter** — v1 Nostr transport, signature/decryption/replay validation, correlation, and payment-message translation; no business state.
2. **Core command, idempotency, and policy layer** — canonical commands, bounded text/capability checks, durable response replay, and the sole authority for state transitions.
3. **Ledger and settlement adapters** — immutable double-entry credit/hold/consumption postings, trusted settlement verification, and reconciliation.
4. **Session orchestrator and allocator** — fenced leases, per-action authorization, checkpoint-before-pause, ten-minute grace, explicit resume, and no-queue capacity rejection.
5. **Isolated worker + metering proxy** — scoped tool surface, ephemeral workspace, model-request/receipt control, and no direct data-plane authority.
6. **Independent verifier and preview shell** — reproducible sealed build, dependency/authority scans, Chromium conformance, then exact-hash NIP-5D preview.
7. **Publication coordinator** — immutable publish intent, local user-signature verification, CVM attestation, stable CLI idempotency, and post-timeout reconciliation.

### Critical Pitfalls

1. **Treating a napplet as a normal web app** — enforce authoritative scaffold/SDK, declared NAPs, static bundle checks, and real shell tests using `allow-scripts` without `allow-same-origin`; bind messages to `MessageEvent.source` plus manifest/hash identity.
2. **Making prompt defenses the authority boundary** — bounded text and detection are signals only; contain the agent with typed allowlisted tools, deterministic policy enforcement, isolated workspaces, and adversarial tool-trace tests.
3. **Combining worker, credentials, build, and preview** — split control plane, per-session executor, independent verifier, shell preview, and publication adapter; default-deny egress and inject only short-lived scoped credentials.
4. **Post-hoc billing or mutable balances** — reserve a pessimistic operation ceiling in a serializable transaction, settle confirmed provider usage exactly once, and retain `usage_unknown` for reconciliation instead of reissuing a timed-out call.
5. **Breaking hash/signing/publish continuity** — seal one artifact before preview; sign/attest/deploy by its immutable identity only; persist the exact signed event and reconcile rather than re-signing on timeout.

## Implications for Roadmap

The roadmap should be organized around irreversible trust and state invariants, not the visible happy-path sequence. Deliver non-billable napplet correctness first, then agent isolation, then prepaid accounting before any funded execution. ContextVM can be introduced after the core command/ledger contracts exist; it should not be the project skeleton.

### Phase 1: Napplet Contract, Reproducible Artifact, and Verification Foundation

**Rationale:** The permanent napplet-only boundary determines what can safely be generated, previewed, billed, and published. It is also the fastest way to discover alpha toolchain incompatibility before wiring paid execution.

**Delivers:** Pinned authoritative scaffold acceptance fixture; policy for one focused napplet and declared NAPs; hermetic dependency/build setup; forbidden-authority scanning; real Chromium conformance; sealed aggregate-hash artifact/evidence model; compatible-shell preview fixture.

**Addresses:** conformance-first generation, exact verified preview, capability-minimal output.

**Avoids:** generic-web-app authority leakage, previewing unverified output, dependency/build-script drift, hand-written manifest logic.

**Validation gate:** `create → init → skills install → build → verify → test:conformance → dry-run publish` succeeds for one pinned CLI/scaffold/toolchain set. Until it does, publication remains a research risk, not a deliverable.

### Phase 2: Core State Model and Isolated Agent Harness

**Rationale:** The agent must never become an authority over data, money, or publication. Establish core ports and fenced execution before connecting real payments or public transport.

**Delivers:** transport-free command/state model, policy engine, idempotency envelopes, state-version/fencing rules, object-backed checkpoint format, `WorkerPort`, scoped model/artifact gateways, and a per-session hardened sandbox with adversarial tool tests.

**Addresses:** bounded text generation/revisions and secure artifact-scope policy.

**Avoids:** prompt-injection side effects, worker breakout/secret exposure, cross-session reads, and workers directly transitioning session state.

### Phase 3: Prepaid Ledger, CEP-8 Top-Ups, and Funded Admission

**Rationale:** Financial correctness must precede any action that can incur model cost. CEP-8 is a top-up adapter, while exact-generation charges remain an internal invariant.

**Delivers:** pubkey-account mapping; append-only double-entry ledger; idempotent Lightning/Cashu top-up settlement; holds; max-spend admission; ContextVM/CEP-8 adapter contract tests; signed status/error replies.

**Addresses:** Nostr-native account, CEP-8 funding, hard session cap, and no-funded-work-without-credit behavior.

**Avoids:** duplicate credits, lost settlements, mutable balances, client-asserted payment success, and protocol types leaking into the core.

### Phase 4: Exact Metering, Generation Actions, and Revision Semantics

**Rationale:** A cap has meaning only when every billable operation is pre-authorized and reconciled by the durable core—not when a worker reports a total afterwards.

**Delivers:** per-operation reserve/authorize/finalize flow, provider request/receipt reconciliation, price-versioned usage line items, action sequence idempotency, constrained generation/revision loop, and verified artifact candidates.

**Addresses:** honest variable-cost generation, iterative revisions, visible usage, and repair constrained by the same policy.

**Avoids:** cap overspend, concurrent revision races, floating-point/accounting ambiguity, and retry double-debits.

### Phase 5: Top-Up Pause, Ten-Minute Live Grace, and 30-Day Resume

**Rationale:** Continuity has financial authorization semantics; it cannot be bolted onto a worker timer after generation is live.

**Delivers:** checkpoint-before-pause state transitions, `needs_top_up` pending action, live-worker grace handling, worker release at ten minutes, explicit signed resume, retention/expiry deletion, and failover/concurrent-resume tests.

**Addresses:** funded interruption recovery and two-tier continuity without surprise spending.

**Avoids:** silent restart after a later top-up, dual workers, lost paid work, and expired checkpoint revival.

### Phase 6: Sealed Preview and Two-Signature Publication

**Rationale:** The user can only consent meaningfully if preview, manifest, attestation, and deployed bytes all identify the same immutable artifact.

**Delivers:** preview service for verified hash, publish intent binding the account/d-tag/capabilities/hash, user-local manifest signing handoff and validation, CVM attestation, CLI deployment saga, relay/deploy reconciliation, and end-to-end byte/hash tests.

**Addresses:** exact preview, explicit user-owned publication, provenance bundle, and capability visibility.

**Avoids:** CVM key custody, automatic publication, rebuild-on-publish, different manifest/deploy bytes, and duplicate signed events.

### Phase 7: Five-Second Admission SLO and High-Availability Correctness

**Rationale:** Availability claims are only valid after the complete debit-to-worker and publish/session state machines exist. Scaling before their fences/outboxes would amplify double-spend and split-brain failures.

**Delivers:** regional warm-pool sizing/admission, explicit `busy/retry-after`, SLO telemetry from request receipt to isolated-worker-ready, single-writer financial/session failover plan, outage/partition reconciliation, and operational dashboards/runbooks.

**Addresses:** immediate-start contract, no durable queue, infrastructure-failure resilience.

**Avoids:** hidden platform queues, misleading warm-only latency, double debit/publish, and regional split brain.

### Phase 8: Security, Supply Chain, and Operational Launch Gate

**Rationale:** The high-risk boundaries must be revalidated against the integrated system and every promoted protocol/tool/image version.

**Delivers:** SBOM/lock/toolchain artifact linkage; escape/exfiltration and prompt-injection corpus; key rotation/audit controls; production reconciliation playbooks; final SLO/load/chaos evidence; version-pinned adapter compatibility suite.

**Addresses:** safe operation of the full v1 surface.

**Avoids:** supply-chain drift, credential leakage, false exactness claims, and protocol regression after alpha dependency updates.

### Phase Ordering Rationale

- Artifact conformance and isolation come before money because the service must first prove it can only produce the permanent permitted artifact class.
- Ledger/admission precedes public paid generation; no model call may be attachable before credit, cap, reservation, and idempotency are durable.
- Metering precedes pause/resume, then verified preview precedes publication; each later promise depends on earlier immutable action/artifact identity.
- HA is deliberately late: it must preserve, not redesign, the proven single-writer ledger, lease, checkpoint, and publication semantics.

### Research Flags

Phases likely needing deeper research during planning:

- **Phase 1:** napplet CLI source/version split and exact NIP-5D/NIP-5A/NAP compatibility; require the real fixture, not package-name assumptions.
- **Phase 2:** selected sandbox provider’s isolation, network controls, browser support, snapshot/export behavior, and scoped-gateway implementation.
- **Phase 3:** current ContextVM SDK/CEP-8 method/receipt/replay contract and Lightning/Cashu PMI/trusted-mint settlement details.
- **Phase 4:** model-provider quote, maximum-reservation, exact-usage receipt, timeout reconciliation, and pricing-version capabilities.
- **Phase 6:** CLI deployment contract, manifest ownership signing handoff, event persistence/retry semantics, and deploy-byte verification.
- **Phase 7:** benchmark Modal and at least one non-AWS fallback using the production-like image, target regions, relay delay, and step load; validate p95 <= 5 seconds with zero durable backlog.

Phases with established patterns (research can be focused rather than open-ended):

- **Phase 3 ledger core:** serializable SQL, append-only postings, unique settlement references, and transactional outbox are established patterns—implementation testing is the main risk.
- **Phase 5 state machine:** lease fencing, compare-and-swap transitions, encrypted object checkpoints, and retention jobs are established; apply them to the exact ten-minute/30-day semantics.
- **Phase 8 controls:** SBOM, pinned digests, adversarial tests, OpenTelemetry traces, and chaos drills are standard, though the particular protocol fixtures remain custom.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Vendor capabilities and registry metadata were checked, but worker/vendor readiness, commercial availability, and the five-second end-to-end SLO are unbenchmarked. |
| Features | MEDIUM | Requirements and permanent boundaries are clear; NIP-5D/ContextVM contracts are alpha/living and need pinned fixtures. |
| Architecture | MEDIUM-HIGH | Core patterns—ports/adapters, serializable ledger, outbox, fencing, immutable artifacts—are mature; integration behavior is not yet proven. |
| Pitfalls | HIGH | Risks and mitigations align across all research files and established financial/sandbox/security failure modes; validation remains essential. |

**Overall confidence:** MEDIUM. The roadmap decisions above are sound because they preserve invariants under changing vendors/protocols; package and provider selections are conditional until their gates pass.

### Gaps to Address

- **Napplet ecosystem compatibility:** resolve CLI provenance and pin a successful scaffold/skills/SDK/Vite/conformance compatibility set; no automated publication claim before dry-run evidence.
- **ContextVM/CEP-8 contract:** verify current endpoint names, signed-event/replay rules, payment messages, Lightning and Cashu settlement receipts against maintained fixtures before adapter implementation.
- **Exact-usage model provider:** choose only a provider/proxy arrangement that can reserve a ceiling, identify requests, return authoritative usage, and reconcile timeouts; otherwise surface `usage_unknown` and pause rather than promise exact final charge.
- **Five-second SLO/vendor selection:** measure receipt-to-isolated-worker-ready at declared load/regions, including pool misses, relay latency, database contention, failure/reclaim, and overload rejection. Modal is recommended for the initial benchmark, not assumed sufficient.
- **HA scope decision:** CockroachDB multi-region is the recommended target for regional continuity; Cloud SQL single-region HA is a permissible cost-first launch alternative only if the product does not claim regional failover until later.
- **Signing/runtime integration:** validate that a compatible trusted runtime can display and locally sign the exact user manifest while preserving CVM attestation linkage and no private-key exposure.

## Sources

### Primary (HIGH confidence)

- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) — user-event ownership/signature model.
- Modal Sandbox, Google Cloud Run/Storage, CockroachDB, and npm registry sources catalogued in [STACK.md](./STACK.md) — documented capabilities and version metadata, subject to implementation gates.

### Secondary (MEDIUM confidence)

- [NIP-5D draft](https://github.com/nostr-protocol/nips/pull/2303), [napplet NIP-5D guide](https://napplet.run/docs/guide/nip-5d.html), and [napplet Vite tooling](https://napplet.run/docs/packages/vite-plugin.html) — current experimental sandbox, manifest, and build behavior.
- [ContextVM documentation](https://docs.contextvm.org/) and [CEP-8 specification](https://docs.contextvm.org/spec/ceps/cep-8/) — v1 transport/payment direction, to be contract-tested.
- [Cashu merchant guidance](https://docs.cashu.space/merchants) — trusted-mint verification and settlement considerations.
- [ARCHITECTURE.md](./ARCHITECTURE.md), [FEATURES.md](./FEATURES.md), [PITFALLS.md](./PITFALLS.md), and [STACK.md](./STACK.md) — detailed synthesis inputs and validation evidence.

---
*Research completed: 2026-08-03*  
*Ready for roadmap: yes*
