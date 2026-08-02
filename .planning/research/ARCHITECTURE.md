# Architecture Research

**Domain:** prepaid, Nostr-authenticated ContextVM service for generating conformant sandboxed napplets
**Researched:** 2026-08-03
**Confidence:** MEDIUM

## Recommended Architecture

Build a transport-neutral TypeScript core around one strongly consistent relational database, an append-only object store, and disposable isolated workers. ContextVM/Nostr is an adapter, not where generation, accounting, or session policy lives. A successfully accepted action means the core has atomically authenticated the public key, deduplicated the request, reserved its maximum affordable cost, persisted the next action, and leased a worker. It never means that a message merely reached a relay.

### System Overview

```
Untrusted client / signed Nostr events
              │ ContextVM + CEP-8 v1 only
              ▼
┌────────────────────────────────────────────────────────────────────┐
│ EDGE ADAPTER                                                        │
│ ContextVM protocol, NIP-44 decrypt/verify, replay window, response │
└───────────────┬──────────────────────────┬─────────────────────────┘
                │ authenticated Command    │ signed progress/events
                ▼                          ▲
┌────────────────────────────────────────────────────────────────────┐
│ TRANSPORT-NEUTRAL CORE (trusted, stateless except durable writes)   │
│ Identity & policy │ Session orchestrator │ Ledger │ Publication      │
│ idempotency gate  │ state machine/fences │ append-only│ coordinator  │
└───────┬──────────┴───────────┬───────────┴───────┬──────────────────┘
        │ serializable tx       │ command/outbox           │ signed intent
        ▼                       ▼                          ▼
┌───────────────────┐  ┌────────────────────┐  ┌─────────────────────┐
│ PostgreSQL primary │  │ Worker allocator   │  │ User trusted signer │
│ accounts/ledger/   │  │ warm pool/leases   │  │ + compatible shell  │
│ sessions/actions   │  └─────────┬──────────┘  └─────────┬───────────┘
└───────┬───────────┘            │ fenced job               │ ownership signature
        │                         ▼                           │
┌───────▼───────────┐  ┌─────────────────────────────────────────────┐
│ Object storage    │  │ PER-SESSION MICROVM / strong sandbox        │
│ checkpoints,      │  │ agent + pinned scaffold + build + test only │
│ artifact evidence │  │ no host mounts, no service/user secrets     │
└───────────────────┘  └─────────┬───────────────────────────────────┘
                                  │ artifact + evidence (untrusted)
                                  ▼
                       ┌──────────────────────────────────────┐
                       │ Trusted verifier / preview publisher  │
                       │ scan, build, conformance, exact hash  │
                       └────────────┬─────────────────────────┘
                                    │ verified immutable build
                                    ▼
                       @napplet/cli deployment + CVM attestation
```

The separation is deliberate: Nostr relays, user prompts, CEP-8 payment messages, LLM/tool output, generated source, package metadata, browser preview messages, and external deployment responses are all untrusted input. Only the core's authenticated commands and transactionally committed state authorize money, worker execution, or publication.

### Component Responsibilities and Trust Boundaries

| Component | Owns | Communicates with | Trust boundary / rule |
|---|---|---|---|
| ContextVM adapter | discovery, signed event decrypt/verify, wire correlation, CEP-8 message translation | Nostr relays; core command API | Never computes balances or calls a worker. Verify sender pubkey and event/replay identity before making a command. |
| Identity and authorization | `pubkey → account`, service policy, account status | adapter; session and ledger services | Public key is an identifier, never proof that a payment or an ownership signature is valid by itself. |
| Command/idempotency gate | canonical request hash, response replay, causal action key | every mutating core API | Durable unique `(account_id, operation, idempotency_key)` recorded before effects; same key with different normalized payload is a conflict. |
| Session orchestrator | prompt/revision policy, durable state machine, worker lease fencing, checkpoints | ledger, allocator, verifier | The sole component permitted to transition a session; workers request transitions, never write them. |
| Ledger and payment adapters | accounts, immutable postings, holds, consumed usage, top-up settlement/reconciliation | CEP-8 adapter, orchestrator | Ledger is the money authority; balances are projections, never mutable source of truth. |
| Worker allocator | regional warm capacity, short lease, fencing token, readiness telemetry | orchestrator; sandbox platform | Allocates immediately or returns `capacity_unavailable`; it must not create a durable queue. |
| Agent worker | bounded iteration, tool execution, workspace mutation, usage report, checkpoint bundle | model proxy, package mirror, object storage via scoped gateway | MicroVM per session; cannot reach database, relays, production network, user signer, deployment credential, or another worker. |
| Artifact verifier | deterministic build, forbidden-authority scan, dependency/policy allowlist, browser conformance, evidence and aggregate hash | artifact store; compatible runtime test fixture | Rebuilds and tests independently of agent claims. Failure creates a non-publishable artifact. |
| Preview service | serves only an immutable verified build to a compatible sandbox shell | browser/runtime; artifact store | A raw Vite page is not a preview. Use `allow-scripts` without `allow-same-origin`, and let the shell broker NAP capabilities. |
| Publication coordinator | publish intent, exact artifact binding, CVM attestation, `@napplet/cli` side effect, result reconciliation | user-owned signer/runtime; `@napplet/cli` | CVM signs its attestation only; user signs the owning manifest. Private keys never cross this boundary. |

### Recommended Project Structure

```
src/
├── core/                     # transport-free command handlers and domain services
│   ├── sessions/              # state machine, checkpoints, worker fencing
│   ├── ledger/                # double-entry postings, reservations, usage finalization
│   ├── artifacts/             # immutable artifact/evidence records and verifier policy
│   ├── publication/           # two-signature publish saga and reconciliation
│   └── idempotency/           # canonical hashing, durable result replay
├── ports/                     # interfaces owned by the core
│   ├── transport.ts           # authenticated command/reply envelope
│   ├── payment.ts             # settlement/top-up adapter interface
│   ├── worker.ts              # lease/start/checkpoint/cancel interface
│   ├── model.ts               # metered model proxy interface
│   ├── artifact-store.ts      # append-only blob/evidence interface
│   └── publisher.ts           # deployment and manifest publication interface
├── adapters/
│   ├── contextvm/             # v1 Nostr + CEP-8 only
│   ├── sandbox/               # chosen microVM provider and scoped gateways
│   ├── postgres/              # transaction repositories and outbox dispatcher
│   ├── object-store/          # encrypted artifacts/checkpoints with retention
│   └── napplet-cli/           # CLI runner behind publisher port
├── worker-image/              # pinned base image, scaffold, skills, tool policy
│   ├── harness/               # agent loop; no business authority
│   └── validation/            # worker-local fast checks; not final acceptance
├── verifier/                  # independent reproducible build and browser suite
├── policy/                    # input limits, capability rules, scan rules, spend rules
└── observability/             # audit events, metrics, trace/context propagation
```

`core/` cannot import Nostr, CEP-8, `@napplet/cli`, or sandbox-vendor SDKs. `ports/` points outward and makes x402/L402 an additive adapter later. The worker image is versioned with its scaffold, skills, pinned dependencies, and verification tools so a checkpoint records exactly what produced a build.

## End-to-End Data Flows

### 1. Discover, Top Up, and Start a Session

```
Client pubkey → ContextVM adapter → verify/decrypt/replay check
  → core.idempotencyGate → ledger/session transaction → allocator
  ← signed reply / CEP-8 payment-required or accepted action id ←
```

1. Discovery exposes read-only capability and price metadata. The adapter maps the verified Nostr pubkey to an account; no conventional password/session is created.
2. A top-up request gets a service-created `top_up_id` and CEP-8 payment instructions. Lightning and Cashu adapters normalize an independently verifiable settlement into `PaymentSettled(top_up_id, provider_reference, amount)`. The ledger inserts the external reference and credit posting in one transaction. Duplicate settlement notifications return the original result; a reused external reference is rejected.
3. `start_session` includes an idempotency key, bounded text prompt, requested capability profile, and user-approved maximum spend. The core validates text/size/prompt policy before admission.
4. In one serializable transaction, the core locks the account balance projection, computes `available = credits - consumed - active_holds`, caps the requested maximum to available funds, creates session/action records, and posts a reservation hold. It then creates an outbox command for worker allocation.
5. The allocator leases a pre-warmed, ready worker in the selected healthy region and writes `(session_id, lease_id, fencing_token, expires_at)` before returning acceptance. If none is available inside the admission budget, the core reverses the unused reservation and returns an explicit retry/capacity error. It does **not** persist an accepted request for later scheduling.

### 2. Metered Generation and Revision

```
orchestrator → fenced action → worker/model proxy → usage receipt
       ↑                          ↓                     ↓
   state + ledger hold ← checkpoint + artifacts ← verifier gate
```

1. The worker receives only an action ID, immutable session input bundle, short-lived scoped artifact credentials, a model-proxy token limited to that action's remaining reservation, and its fencing token.
2. The agent uses the authoritative scaffold and `@napplet/skills`. It may modify only its ephemeral workspace. Model calls go through a service-controlled proxy that records provider request IDs and exact token/cost usage and refuses a request that exceeds remaining action/session allowance.
3. Before each billable model/tool operation, the worker asks the core for a spend authorization keyed by `(action_id, operation_sequence)`. The core atomically converts part of the hold to an operation reservation. Final usage converts that reservation into immutable consumption postings; unused amount returns to the session hold. This permits exact charging without trusting a worker-reported aggregate.
4. The worker uploads a content-addressed workspace snapshot and structured usage/evidence receipt. The orchestrator records it using compare-and-swap on its fencing token and action sequence. A revision is a new action against the same session/workspace lineage, not a mutation of prior evidence.
5. The independent verifier rebuilds the candidate from the exact snapshot, scans forbidden browser/authority surfaces, runs package/build checks and the Chromium-backed conformance suite, and records the build aggregate hash. Only `verified` builds can transition to preview.

### 3. Balance Exhaustion, Pause, and Resume

```
remaining reservation insufficient
  → commit checkpoint + stop new billable calls + PAUSED_AWAITING_TOPUP
  → top-up settled within 10 min → same fenced worker resumes
  → otherwise release worker → EXPLICIT_RESUME_REQUIRED
```

When the next authorization cannot be funded, the core first persists a checkpoint pointer, conversation/agent cursor, workspace snapshot, validation evidence, durable usage ledger, and pending next action. It then transitions the session to `PAUSED_AWAITING_TOPUP` and tells the worker to stop issuing billable work. This ordering prevents a debit without recoverable work state.

A settled top-up within the ten-minute live window may resume the existing worker only after a fresh approval/remaining-cap check; it must use a new action ID, not replay an interrupted model request. At ten minutes, the allocator expires/revokes the lease and the core transitions to `EXPLICIT_RESUME_REQUIRED`. Later top-ups change balance only. An explicit signed `resume_session` command makes a new reservation and starts a new worker from the durable checkpoint. The checkpoint/object bundle is retained for 30 days, then a retention job tombstones the session and securely deletes blobs according to storage policy.

### 4. Preview and Publish

```
verified artifact/hash → compatible shell preview → user chooses publish
  → user-owned manifest signature → CVM attestation → @napplet/cli saga
  → reconcile unique publish key → published manifest/deployment receipt
```

Preview binds to an immutable `(artifact_id, aggregate_hash, verifier_policy_version)`. The browser shell must use the NIP-5D sandbox configuration (`allow-scripts`, no `allow-same-origin`) and broker only declared NAP domains. The preview implementation validates `MessageEvent.source`, maps it to the manifest/hash, and never exposes direct signer, storage, relay, or network authority to the napplet.

For publication, the core generates a `publish_intent_id` binding the verified hash, d-tag/metadata, account pubkey, and expiry. The trusted client/runtime presents the exact manifest to the user and obtains the ownership signature locally. The server validates that signature against the authenticated account pubkey, then creates a CVM attestation for that exact intent/hash. The coordinator invokes `@napplet/cli` with a stable idempotency key and stores the request before side effects. A crash after dispatch is `PUBLISHING_UNKNOWN`: retry/reconcile with the CLI/deployment identifier; never issue a second independent publish. The session becomes `PUBLISHED` only when both manifest and deployment receipts are durably linked to the intent.

## Durable State and Idempotency Model

### Session State Machine

```
DRAFT
  → ADMISSION_PENDING → RUNNING
  → VALIDATING → VERIFIED → PREVIEW_READY → PUBLISH_INTENT_PENDING
  → PUBLISHING → PUBLISHED

RUNNING | VALIDATING
  → PAUSING → PAUSED_AWAITING_TOPUP
  → EXPLICIT_RESUME_REQUIRED → RESUMING → RUNNING
  → FAILED_RETRYABLE | FAILED_TERMINAL | CANCELLED

Any nonterminal state → EXPIRED (after retention expiry)
```

Only the orchestrator performs transitions, transactionally recording `from_state`, `to_state`, event hash, action sequence, actor, and correlation ID. Transitions require the current `state_version`, the active `lease_id`, and fencing token where a worker initiated the event. A late/duplicate worker cannot overwrite current state after a restart or failover.

Use four related but distinct keys:

| Scope | Key | Effect |
|---|---|---|
| Client command | `(account, command, client_idempotency_key)` | Same canonical command returns the persisted response; different payload is a conflict. |
| Session action | monotonic `action_id` plus `operation_sequence` | Stops an agent retry from issuing the same billed operation twice. |
| Ledger posting | `entry_reference` unique across all postings | Makes credits, holds, releases, and consumption immutable and replay-safe. |
| External side effect | provider request/deployment ID plus stable idempotency key | Enables reconcile-after-timeout rather than assuming a failed call did nothing. |

The transactional outbox publishes allocation, notification, and reconciliation work only after the database commit. Consumers are at-least-once but idempotent; exactly-once delivery is neither claimed nor required. The observable contract is exactly-once *business effect* under duplicate delivery.

### Ledger Correctness and Failure Semantics

Use a double-entry, append-only `ledger_entries` table with account, system escrow/hold, revenue/usage, and settlement-clearing accounts. Materialized balance projections are updated in the same transaction and periodically recomputed from entries. Never update a `balance` column as the financial record.

| Event/failure | Required behavior |
|---|---|
| Duplicate CEP-8 settlement | unique provider settlement reference returns original credit; no new posting. |
| Settlement unknown/late | retain `pending_top_up`; credit only after adapter verification; reconcile periodically. |
| Start admission DB conflict | retry serializable transaction; if it cannot commit, no worker is allowed to start. |
| Worker fails before usage receipt | release uncommitted operation reservation; keep checkpoint and session retryable. |
| Model provider timeout | query/retry with provider request ID if supported; retain `usage_unknown` reservation until reconciled, never blindly reissue billable call. |
| Actual usage exceeds reservation | model proxy denies it; the worker cannot create debt. |
| Session cancelled | revoke worker lease, checkpoint first, release all unused holds in one transaction; already consumed postings remain final. |
| Publish dispatch timeout | retain `PUBLISHING_UNKNOWN`; reconcile exact publish intent before any retry. |
| Region/worker failover | lease expiration plus fencing token admits one replacement worker from last committed checkpoint; no concurrent execution. |

The product can promise exact accounting for provider-confirmed usage, but should not promise a magical exactly-once distributed call. It must expose reconciliation-pending status when a provider outcome is unknown.

## Worker Isolation, Network, and Secret Controls

Use a per-session microVM or equivalent strongly isolated sandbox rather than a shared process/container. Keep a small pool of prebuilt, healthy, region-local images warm: OS/runtime, pinned napplet CLI/packages, scaffold, skills, browser/test dependencies, and approved package cache are already present. This is what makes five-second p95 startup plausible; image pulling, dependency installation, or on-demand VM provisioning is not on the accepted request path.

Required controls:

- Run as non-root with read-only base filesystem, writable ephemeral workspace, CPU/RAM/PID/disk/time quotas, no privileged mode, no Docker socket, no host namespaces/mounts, and distinct encryption keys per checkpoint object.
- Default-deny egress. Prefer no direct Internet at all: serve model calls via a metering proxy and dependencies from an immutable internal mirror. If a temporary exception is unavoidable, make it per-action, hostname/method scoped, audited, and incapable of reaching metadata/credential endpoints or control-plane/private networks.
- Give the worker no database credentials, Nostr keys, CEP-8 secrets, deployment credential, user key, or long-lived object-store token. Short-lived artifact/checkpoint URLs are scoped to the session/action and content type.
- Treat agent tools, command output, package scripts, generated code, source maps, and test/browser output as hostile. The harness offers a narrow allowlisted tool API; shell commands are logged and resource-limited. Static scans alone are not the sandbox.
- Run final builds/conformance in a fresh verifier sandbox, separate from the agent workspace. Produce an SBOM/package-lock policy result, forbidden-authority scan, deterministic build hash, and browser evidence before marking an artifact verified.

## Five-Second p95 and High Availability

No durable queue means admission control is part of the user-visible API. Maintain a warm capacity target per healthy region based on arrival rate and observed generation duration. The edge routes only to a healthy regional control-plane replica; the session/ledger write goes to the single strongly consistent primary (or managed multi-AZ database) before allocation. A regional allocator atomically leases an already-ready worker. If either the durable commit or ready lease cannot complete within the start SLO, reject with a signed `capacity_unavailable` response and a retry-after; do not accept latent work.

Use standby capacity and regional failover, but do not let multiple regions independently accept spending actions against asynchronously replicated balances. Money/session admission has one write authority at a time. Cross-region failover requires promoted durable storage plus allocator fencing; in-flight workers lose their lease and resume from checkpoint after the control plane confirms the prior fencing epoch is dead. That trades a rare restart for no double charge/double publish.

| Scale | Adjustment |
|---|---|
| 0–1k users | Modular monolith core, HA Postgres, object storage, one or two regional warm pools; preserve port boundaries from day one. |
| 1k–100k users | Split adapter ingress/relay connections and worker allocator from core; partition worker pools by region and policy image; read replicas only for status/discovery, never debit admission. |
| 100k+ users | Partition accounts by stable pubkey hash with single-writer shard routing, global artifact CDN, multi-region warm capacity/autoscaling; retain per-account serial ledger ownership and global unique external-settlement reconciliation. |

## Architectural Patterns

### Pattern 1: Ports-and-Adapters Core

**What:** Commands express product semantics such as `topUpSettled`, `startSession`, `authorizeUsage`, `resume`, and `publish`; adapters translate ContextVM/CEP-8 now, x402/L402 later.

**When to use:** Always for transport/payment integration. It protects the permanent user/session/ledger contracts from experimental protocol churn.

**Trade-off:** Requires explicit mapping DTOs and contract tests, but prevents protocol-specific types from leaking across the application.

```ts
// ports/transport.ts
export interface AuthenticatedTransport {
  readonly subjectPubkey: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface PaymentRail {
  createTopUp(input: TopUpIntent): Promise<SettlementInstructions>;
  verifySettlement(input: SettlementNotice): Promise<VerifiedSettlement>;
}
// adapters/contextvm implements both v1 interfaces; future x402/L402 are new adapters.
```

### Pattern 2: Fenced Lease plus Durable Checkpoint

**What:** A worker may act only with the current lease/fencing token. Checkpoints are committed before pausing/replacement; a new worker restores only the latest committed generation.

**When to use:** Every agent action that can survive worker/process/region failure.

**Trade-off:** Some work is replayed after failure and provider outcomes may need reconciliation, but concurrent stale workers cannot mutate session state or charge usage.

```ts
await db.transaction(async (tx) => {
  const session = await tx.sessions.lock(sessionId);
  assert(session.leaseId === input.leaseId && session.fence === input.fence);
  assert(session.stateVersion === input.stateVersion);
  await tx.checkpoints.insert(input.checkpoint);
  await tx.sessions.transition(sessionId, "PAUSING", "PAUSED_AWAITING_TOPUP");
});
```

### Pattern 3: Reserve-Then-Finalize Metering

**What:** The core reserves a session cap before dispatch and authorizes each billable operation from that hold. Actual confirmed provider usage converts reservation to consumption; unspent amount is released.

**When to use:** Variable-cost agent/model work where the user approves a maximum but is charged actual usage.

**Trade-off:** More ledger entries and reconciliation states than a fixed-price payment, but no worker can overspend account balance or user cap.

## Anti-Patterns

### Letting the ContextVM Adapter Own Business State

**What people do:** Keep balances/session state in Nostr-event handlers or bind the domain model to CEP-8 wire objects.

**Why it is wrong:** Relay delivery is duplicate/reordered and protocols are evolving; x402/L402 would force a rewrite.

**Do this instead:** Translate verified events into canonical core commands; persist domain state once in the transactional core.

### Trusting Agent Output or a Raw Browser Page

**What people do:** Treat a successful local build, agent report, or Vite preview as a valid napplet.

**Why it is wrong:** It can retain stale build metadata, bypass the shell, or use prohibited authority surfaces.

**Do this instead:** Verify an immutable snapshot independently, test in a compatible sandbox shell, bind preview/publication to its aggregate hash, and reject any failed evidence.

### Start-Then-Debit / Debit-Then-Checkpoint

**What people do:** Begin model work before a committed hold or charge before preserving recoverable state.

**Why it is wrong:** Retries can create debt, double charges, or lost expensive progress.

**Do this instead:** Reserve before dispatch; checkpoint before pause/cancel; then commit confirmed consumption through idempotent postings.

### Warm Workers with Broad Credentials

**What people do:** Put control-plane credentials, deployment keys, or permissive network access into reusable images for convenience.

**Why it is wrong:** Generated code and supply-chain scripts become a route to customer accounts and production.

**Do this instead:** Warm only immutable tools and caches. Inject per-action, least-privilege capability tokens after a worker is leased.

## Integration Points and Future Seams

| Integration | v1 approach | Future-compatible seam |
|---|---|---|
| ContextVM transport | Nostr public-key authentication, encrypted request/reply, ContextVM discovery/capability methods | `AuthenticatedTransport` maps any verified caller identity to core commands. x402/L402 adapters must preserve idempotency/correlation fields. |
| CEP-8 top-ups | Separate top-up capability negotiates Lightning/Cashu settlement; confirmed payment credits account | `PaymentRail` yields a normalized immutable `VerifiedSettlement`, never a direct balance mutation. |
| Model provider | Metering proxy issues action-scoped calls and receipts | `ModelGateway` exposes quote/authorize/invoke/reconcile; provider switching cannot alter ledger semantics. |
| Worker platform | warm microVM pool with scoped gateways | `WorkerPort` leases, fences, checkpoint/restores, and revokes independent of vendor. |
| napplet tooling | use maintained scaffold, `@napplet/skills`, verifier, compatible runtime, and `@napplet/cli` | `ArtifactVerifier` and `Publisher` bind only immutable hashes and receipts; update tool versions through image/policy rollout. |
| User ownership | client/runtime signs manifest locally after preview | `OwnershipSigner` is a verification port only; server has no signing implementation for user keys. |

Do not implement x402 or L402 endpoints in v1. Create port contract tests that replay the same canonical commands through the ContextVM adapter. A future adapter is acceptable only if it supplies a stable caller identity, idempotency key, correlation ID, maximum-spend consent, and independently verifiable settlement/receipt semantics; otherwise it cannot call the core mutation APIs.

## Dependency-Informed Build Order

1. **Domain foundation and test harness** — define canonical commands, state machine, idempotency envelopes, error taxonomy, Postgres schema/migrations, transactional outbox, and audit model. Every later integration depends on these invariants.
2. **Ledger and CEP-8 top-up adapter** — implement accounts, immutable postings, holds, settlement verification/reconciliation, spend-cap admission, and failure tests before agent execution. Never attach a costly worker to an unproven money path.
3. **ContextVM adapter and authenticated session API** — add discovery, verified pubkey association, replay/correlation handling, bounded text validation, and signed status replies; keep adapter contract tests against the core.
4. **Worker control plane and isolation** — ship warm-pool leasing, fencing, checkpoint storage, revocation, model proxy metering, capacity rejection, and failover/chaos tests. Prove p95 cold-path avoidance before enabling public generation.
5. **Constrained generation loop** — use the scaffold and skills in workers; support revisions, per-operation authorization, output/evidence upload, pause/top-up/resume, and 30-day retention.
6. **Independent verifier and exact preview** — implement forbidden-authority/dependency checks, reproducible build, conformance/browser suite, immutable artifact records, and compatible shell preview. Publication remains impossible before this gate.
7. **Two-signature publication** — add publish intent, user-side ownership-signature verification, CVM attestation, `@napplet/cli` integration, reconcile-after-timeout behavior, and double-publish tests.
8. **HA hardening and operational rollout** — regional warm-pool targets, single-writer failover runbooks, ledger reconciliation dashboards, worker escape drills, SLO/load tests, key rotation, and adapter contract suite for future x402/L402.

## Sources

- [ContextVM documentation](https://docs.contextvm.org/) — official project documentation; confirms ContextVM's Nostr/MCP model and CEP-8 payment documentation availability. Confidence: MEDIUM (verified web result; exact CEP-8 endpoint needs revalidation during adapter work).
- [ContextVM CEP-8 announcement](https://nostr.com/nevent1qqs0gp6dqkc0xctltl63mlrjn6nyrudtylgs79gjnsmlfy7569xug4qzyp4n0q8099eww0fhpwz28eg70256ud9lgy5n3h8mm8zlvwezzstvsptych2) — project announcement describing CEP-8's payment/correlation role. Confidence: MEDIUM.
- [NIP-5D explained](https://napplet.run/docs/guide/nip-5d.html) — official non-normative guide to NIP-5D sandbox, message, manifest, and shell boundary; defer normative fields to its linked NIP/NAP documents. Confidence: MEDIUM.
- [Build a napplet with an AI agent and `@napplet/skills`](https://napplet.run/docs/guide/build-note-drafts-napplet-with-ai-agent-and-skills.html) — official build/verification workflow including conformance and shell preview. Confidence: MEDIUM.
- [Interledger idempotent settlement guidance](https://interledger.org/developers/rfcs/settlement-engines/) — supports persisted idempotency and retry-safe settlement effects. Confidence: MEDIUM.
- [Cloudflare Sandbox security model](https://developers.cloudflare.com/sandbox/concepts/security/) — current example of per-sandbox VM, filesystem/process/network isolation and quotas; provider choice remains a phase-specific decision. Confidence: MEDIUM.

## Open Research Flags

- Confirm the current ContextVM SDK/CEP-8 method names, settlement receipts, correlation/replay rules, and Lightning/Cashu PMI behavior directly from the maintained specification before the adapter phase; the documented endpoint was not fetchable during this research.
- Pin current `@napplet/cli`, conformance, boilerplate, and `@napplet/skills` versions and test a real deployment/attestation transaction. Napplet is alpha and its protocol/tool contracts can drift.
- Benchmark at least two non-AWS microVM/container vendors against the actual prebuilt image, Chromium suite, local region, and sustained warm-pool cost. The five-second p95 is an SLO to prove, not an architecture guarantee.
- Obtain provider terms/API evidence for exact usage receipts and reconciliation. If a model provider cannot reconcile timed-out requests, expose conservative `usage_unknown` behavior rather than pretending charges are exact.

---
*Architecture research for: napplet-cvm*
*Researched: 2026-08-03*
