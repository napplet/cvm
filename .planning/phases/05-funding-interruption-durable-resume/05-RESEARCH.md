# Phase 5: Funding Interruption & Durable Resume - Research

**Researched:** 2026-08-05  
**Domain:** Durable continuation state machine, encrypted checkpoint persistence, and resume fencing  
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Insufficient-Funds Boundary and Status

- **D-79:** Affordability is decided before a new action budget, provider operation, worker mutation, or ledger debit. If the requested bounded action cannot fit both settled availability and remaining session cap, persist one replayable pending-action intent and move the session to `needs_top_up` at its latest durable safe boundary.
- **D-80:** `needs_top_up` status exposes the pending action kind and safe fingerprint/reference, exact additional funding required, current settled/available balance, remaining approved cap, grace deadline, checkpoint state, and next required action. It excludes prompts, generated source, agent reasoning, credentials, bearer payment material, and native provider payloads.
- **D-81:** A top-up may increase account availability but never silently increases the user-approved session cap. If the pending action also exceeds remaining cap, status requires a separate signed cap approval under the existing funded-admission rules before work can resume.
- **D-82:** Repeated funding interruptions remain safe pauses rather than terminal session failures. Each pending action is uniquely identified and exact duplicate pause/status/resume inputs replay the durable result.

### Ten-Minute Live-Worker Grace

- **D-83:** The first persisted `needs_top_up` transition fixes one server-authoritative absolute grace deadline ten minutes later. Duplicate events, reconnects, clock skew, or additional pending top-ups do not extend it.
- **D-84:** During the grace window, a verified Lightning or Cashu credit may wake the coordinator, but the coordinator resumes only the same fenced live worker and only after atomically rechecking ownership, pending-action identity, expected session version, remaining cap, available balance, worker lease, and a fresh action authorization.
- **D-85:** A payment notification is never resume authority. The verified ledger credit plus the still-valid grace/lease/pending-action predicates authorize the coordinator transition; concurrent or duplicate settlement signals converge on one re-authorization and one continued action.
- **D-86:** The waiting worker performs no model, tool, build, network, or billable work. It may retain only the already-fenced workspace during the grace period and must reject stale commands or lease tokens.

### Durable Checkpoint and Worker Release

- **D-87:** Checkpoint material is captured only at validated action boundaries through the existing `WorkerPort` proposal contract. The coordinator validates and binds it to account, session, session/artifact versions, workspace lineage, pending action, action/operation/ledger references, policy/toolchain compatibility identity, inventory, and evidence hashes.
- **D-88:** The durable checkpoint is a canonical manifest plus encrypted immutable workspace/agent-state archive in object storage. The database commits the checkpoint identity, object generation/checksum, retention timestamps, and resume state; ordinary status carries safe references only. No user Nostr private key or long-lived worker/cloud credential enters the archive.
- **D-89:** At the grace deadline the coordinator fences further worker effects, durably records/promotes the complete checkpoint, releases the live-worker lease and capacity, and records the replayable release outcome. Crash/retry ordering must never permit both an active worker and a resumable claim for the same session generation.
- **D-90:** Checkpoint content includes conversation state needed by the harness, bounded agent state, workspace files, verified artifact lineage, validation evidence, financial/action identifiers, the exact pending action, and pinned compatible napplet/model/policy/toolchain metadata. Raw chain-of-thought is neither required nor retained.

### Explicit Resume and Retention

- **D-91:** After the grace deadline, a later deposit changes balance only. Work resumes only from a new signed ContextVM `resume_session` command that names the session/checkpoint, presents the pending action for explicit approval, and supplies the expected checkpoint/session version plus an idempotency key.
- **D-92:** Resume claims the checkpoint and a new isolated-worker lease atomically before restore. Only one restore may become active; exact duplicates replay, stale/foreign/conflicting commands fail before worker allocation or billing, and previously settled operations are never dispatched or charged again.
- **D-93:** Restored work must match the checkpoint's pinned compatibility identities or pass an explicit server-owned compatibility migration gate. A restore never asks generated code or package text to decide whether the checkpoint is trustworthy.
- **D-94:** The retention deadline is exactly 30 days from durable checkpoint commitment. Resume claims made before expiry may finish their fenced transition; after expiry the checkpoint is tombstoned, cryptographic/object deletion is scheduled and auditable, status reports `expired`, and no payment or command can revive it.
- **D-95:** ContextVM remains the sole v1 transport. Phase 5 adds only the owner-scoped `resume_session` command and related status fields to the thin adapter; x402/L402, preview, signing, deployment, and publication remain absent.

### the agent's Discretion

- Choose exact schema/table names, checkpoint envelope format, encryption-provider port, object-store port, deadline scheduler/reconciler layout, and stable error codes while preserving D-79–D-95.
- Choose conservative retry/deadline values for checkpoint/object operations and restore, provided no retry can create a second worker or repeat a billable provider operation.
- Choose the smallest deterministic storage and worker doubles needed for design evidence; live GCS/Modal operational certification remains Phase 7.

### Deferred Ideas (OUT OF SCOPE)

- Live Modal/GCS provider selection, production credentialing, measured restore latency, multi-region failover, and chaos/SLO certification — Phase 7.
- Preview, user signing, publication, deployment, and attestation — Phase 6.
- Public x402/L402 transports — v2.
</user_constraints>

## Project Constraints (from AGENTS.md)

- Use the existing ContextVM-only v1 boundary; keep generation/billing/session logic transport-neutral so later x402/L402 adapters do not require a rewrite. [VERIFIED: AGENTS.md]
- Preserve the permanent napplet-only, text-only, bounded-input product boundary; the continuation flow cannot add browser, signer, relay, storage, or deployment authority to generated code. [VERIFIED: AGENTS.md]
- Treat prompts, worker output, generated files, dependency material, checkpoint proposals, and runtime messages as untrusted data; coordinator-owned validation and policy remain authoritative. [VERIFIED: AGENTS.md]
- Enforce prepaid-ledger spend safety: no session may exceed its approved cap or settled funds, and the CVM never receives a user's Nostr private key. [VERIFIED: AGENTS.md]
- Preserve immediate-or-rejected admission; this phase must not introduce a durable generation queue. [VERIFIED: AGENTS.md]
- Use the promoted `@napplet/cli` contract rather than hand-written deployment/publication behavior; publication itself is out of scope. [VERIFIED: AGENTS.md]
- Prefer graph discovery for code definitions and relationships; implementation planning should extend the existing `WorkerPort`, lease, metered-action, funding, persistence, and thin ContextVM seams. [VERIFIED: AGENTS.md]

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CONT-01 | Before an action that the remaining balance or cap cannot cover, the service reaches a durable safe boundary instead of starting the action or failing the session. | Pending-action intent and pause transition occur before any budget reservation, provider intent, worker mutation, or debit. |
| CONT-02 | A paused user sees a `needs_top_up` state containing the pending action, required additional funding, current balance/cap, and ten-minute live-worker deadline. | Strict owner-safe status projection and fixed server-clock deadline. |
| CONT-03 | A verified top-up completed within ten minutes resumes the same fenced live worker only after the pending action is re-authorized. | Verified-credit wake path rechecks state, owner, cap/funds, action fingerprint, and unchanged lease before new authorization. |
| CONT-04 | At the ten-minute deadline the service writes a complete durable checkpoint and releases the live worker without continuing to spend. | Validated proposal → encrypt/write immutable object → serializable checkpoint commit that revokes lease/capacity. |
| CONT-05 | A checkpoint preserves the conversation, agent state, workspace, artifact versions, validation evidence, ledger/action identifiers, pending action, and compatible toolchain metadata in encrypted immutable storage. | Canonical manifest, authenticated archive envelope, immutable object generation/checksum, and no-secret inventory. |
| CONT-06 | After the live window, a later top-up does not restart work automatically; the user must send an explicit signed resume command and approve the displayed pending action. | New owner-scoped ContextVM `resume_session` command with checkpoint/version/action-fingerprint approval; credit is never command authority. |
| CONT-07 | A checkpoint is resumable for 30 days, cannot create two active workers or duplicate prior charges on resume, and is securely expired after the retention window. | Atomic resume claim + fresh lease, operation-history fence, exact 30-day tombstone, and idempotent deletion/audit workflow. |
</phase_requirements>

## Summary

Phase 5 should be an extension of the existing coordinator-owned action/lease model, not a second workflow engine. The codebase already has exact request fingerprints, replay results, expiring version-bound worker leases, effect intents that become uncertain instead of being retried, an authenticated checkpoint proposal, a serializable PostgreSQL-wire metered authority, and owner-safe ContextVM dispatch. The phase should add one durable continuation aggregate which composes those seams. [VERIFIED: codebase `src/persistence/session-store.ts`, `src/worker-port/fake-worker.ts`, `src/persistence/postgres-sql-funding-store.ts`, `src/contextvm/adapter.ts`]

The decisive invariant is: a session generation has either a live valid lease or a committed resumable checkpoint claim, never both. An unaffordable action first records a replayable pending action and fixed grace deadline. A verified top-up may wake only the same still-valid lease and must obtain a fresh budget authorization; after the deadline, the coordinator writes/validates/encrypts the checkpoint object and commits its identity while revoking the lease. A later credit changes funds only; a signed `resume_session` claims the checkpoint and a new lease before restore. [VERIFIED: 05-CONTEXT.md D-79–D-94]

Use deterministic clock, worker, encryption, and object-store doubles for this phase's reference evidence. Do not select, credential, or certify Modal, GCS, KMS, readiness/restore latency, or multi-region behavior here. [VERIFIED: 05-CONTEXT.md]

**Primary recommendation:** Add a transactional `ContinuationStore`/coordinator over the existing metered session authority, using immutable encrypted checkpoint objects, a single fixed grace deadline, and atomic lease/checkpoint claim transitions. [VERIFIED: codebase; 05-CONTEXT.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Affordability decision and `needs_top_up` transition | API / Backend | Database / Storage | Money, cap, session state, and replay are coordinator-owned serializable state; no worker effect may precede the transition. [VERIFIED: 05-CONTEXT.md D-79; codebase] |
| Grace-clock reconciliation | API / Backend | Database / Storage | A server-authoritative clock and persisted deadline decide whether the worker is still eligible. [VERIFIED: 05-CONTEXT.md D-83] |
| Same-worker wake after verified credit | API / Backend | Isolated Worker | The coordinator validates credit/state/lease and sends a fenced command; the worker only retains its fenced workspace. [VERIFIED: 05-CONTEXT.md D-84–D-86] |
| Checkpoint capture and validation | Isolated Worker | API / Backend | The worker proposes bounded archive facts; the coordinator validates and binds them to durable state. [VERIFIED: 05-CONTEXT.md D-87; codebase `validateCheckpointProposal`] |
| Encryption and immutable archive persistence | API / Backend | Database / Storage | The coordinator seals the archive and records object generation/checksum; the worker never receives cloud credentials. [VERIFIED: 05-CONTEXT.md D-88; AGENTS.md] |
| Explicit signed resume | Frontend Server (ContextVM adapter) | API / Backend | The thin adapter authenticates owner input; core transaction claims checkpoint/lease and decides restoration. [VERIFIED: 05-CONTEXT.md D-91–D-95; codebase `ContextVmFundingAdapter`] |
| Expiry/tombstone/deletion scheduling | API / Backend | Database / Storage | A durable reaper records the terminal state/audit and names the exact immutable object generation for deletion. [VERIFIED: 05-CONTEXT.md D-94] |

## Standard Stack

### Core

| Library / component | Version | Purpose | Why Standard |
|---|---:|---|---|
| Bun + built-in Web Crypto | Bun 1.3.14 | Use existing `crypto.subtle` AES-GCM capability behind a checkpoint encryption port. | Existing protected-material code already creates a fresh 12-byte nonce and binds metadata as authenticated additional data; reuse its envelope discipline, not its rail-specific schema. [VERIFIED: environment; codebase `src/funding/protected-rail-material.ts`] |
| Zod | 4.4.3 | Strict input, manifest, status, resume-command, and worker-proposal schemas. | The existing authority boundaries use parsed schemas; strict allowlists are required for untrusted checkpoint and ContextVM data. [VERIFIED: package.json; codebase] |
| Existing PostgreSQL-wire metered store | project-owned | Single serializable authority for continuation claims, action budgets, and ledger facts. | `PostgresSqlFundingStore` already begins `SERIALIZABLE` transactions and retries serialization conflicts; Phase 5 must extend this transaction boundary instead of coordinating independent stores. [VERIFIED: codebase `src/persistence/postgres-sql-funding-store.ts`] |

### Supporting

| Component | Version | Purpose | When to Use |
|---|---:|---|---|
| `WorkerPort` + `CheckpointProposalSchema` | project-owned | Validated bounded checkpoint proposal and deterministic worker double. | Capture only at a safe action boundary and revalidate all request/action/workspace/hash bindings before persistence. [VERIFIED: codebase `src/phase-02/contracts.ts`, `src/worker-port/fake-worker.ts`] |
| Version-bound worker leases / effect intents | project-owned | Fence stale workers and uncertain recipient calls. | Reuse for grace wake, deadline release, and post-window restore; do not create a parallel lock. [VERIFIED: codebase `src/persistence/session-store.ts`] |
| `ObjectStorePort` (new project port) | project-owned | Create immutable ciphertext, return object identity/generation/checksum, read a pinned generation, and schedule exact-version deletion. | Implement a deterministic in-memory adapter for Phase 5; map to live storage only in Phase 7. [VERIFIED: 05-CONTEXT.md; CITED: https://docs.cloud.google.com/storage/docs/request-preconditions] |
| `ClockPort` and deadline reconciler | project-owned | Server-authoritative grace/retention evaluation. | Use injected time for ten-minute and 30-day races; never derive deadlines from client/payment-event timestamps. [VERIFIED: 05-CONTEXT.md D-83, D-94] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| Existing lease + serializable continuation claim | Redis/distributed lock | A second lock has no connection to session version, replay result, or metered operation state and would split the authority boundary. [VERIFIED: codebase; 05-CONTEXT.md D-89, D-92] |
| Explicit `resume_session` after grace | Automatic resume after a top-up | Automatic resume violates the locked consent boundary and risks surprise spending. [VERIFIED: 05-CONTEXT.md D-91] |
| Deterministic storage/worker adapters | Live Modal/GCS/KMS integration | Live selection and operational certification are deferred to Phase 7. [VERIFIED: 05-CONTEXT.md] |

**Installation:** No package installation. Reuse existing Bun, Zod, worker, funding, and persistence dependencies. [VERIFIED: package.json; 05-CONTEXT.md]

## Package Legitimacy Audit

Not applicable: Phase 5 introduces no external package installation. New crypto/object-store abstractions are project-owned ports with deterministic adapters. [VERIFIED: package.json; 05-CONTEXT.md]

## Architecture Patterns

### System Architecture Diagram

```text
signed revise / repair request
            |
            v
  coordinator computes bounded action maximum
            |
     serializable affordability check
       | affordable                         | cannot fit balance or cap
       v                                    v
 Phase 4 action path              persist pending-action intent + fixed deadline
                                           |
                                           v
                              needs_top_up (same live lease; worker idle)
                               |                         |
                 verified credit before deadline          | deadline reaper
                               |                         v
                  atomic predicates + fresh auth    WorkerPort checkpoint proposal
                               |                         |
                               v                         v
                     same fenced worker          validate -> AES-GCM seal -> immutable put
                               |                         |
                               +-----------+-------------+
                                           v
                        serializable commit: checkpoint generation/checksum,
                        resume-required state, lease/capacity revoked, audit event
                                           |
                    top-up alone changes balance only
                                           |
             signed owner resume_session (checkpoint/version/action approval)
                                           |
                                           v
                  atomic checkpoint claim + new worker lease + fresh authorization
                                           |
                                           v
                  pinned-generation restore -> normal metered action path

retention reaper: committed_at + 30 days -> tombstone -> schedule exact object/key deletion -> expired
```

The object write occurs before the database's irreversible commit because an object store cannot share the SQL transaction. If the write succeeds but the database transaction loses a race or crashes, it is an unreferenced encrypted orphan for an auditable reaper; it is never resumable. Once the database commit succeeds, the old lease is revoked in that same transaction before any external worker termination call. [VERIFIED: 05-CONTEXT.md D-88–D-89; CITED: https://docs.cloud.google.com/storage/docs/request-preconditions]

### Recommended Project Structure

```text
src/
├── continuity/
│   ├── contracts.ts              # strict continuation, checkpoint, and safe-status schemas
│   ├── continuation-service.ts   # pause, grace wake, expiry, and resume orchestration
│   ├── checkpoint-envelope.ts    # coordinator-owned encryption port/types
│   ├── object-store.ts           # immutable object-store port and deterministic adapter
│   └── deadline-reconciler.ts    # injected-clock grace/retention scans
├── persistence/
│   └── postgres-sql-funding-store.ts # continuation rows/claims inside existing SERIALIZABLE transaction
├── worker-port/
│   └── fake-worker.ts            # expanded restore/checkpoint deterministic behavior
└── contextvm/
    └── adapter.ts                # one owner-scoped resume_session dispatch branch
tests/
├── phase-05/                     # continuation behavior/race/status contract tests
├── persistence/                  # SQL and replay/claim parity tests
└── evals/                        # deterministic Phase 5 reference set
```

### Pattern 1: Pending action is an intent, not an action budget

**What:** Calculate the action's bounded maximum and persist a request-fingerprint-bound pending action when it cannot fit. Do not reserve an action budget, invoke a model, mutate the worker, or debit until a later fresh authorization succeeds. [VERIFIED: 05-CONTEXT.md D-79]

**When to use:** Start, revision, repair, or any future bounded action that reaches the existing action-budget seam.

**Example:**

```ts
// Project pattern derived from funded-action idempotency and Phase 5 D-79.
await continuationStore.transact(accountId, async (tx) => {
  const replay = await tx.findContinuationResult(command);
  if (replay) return replay;
  const affordability = await tx.quotePendingAction(command);
  if (affordability.canAuthorize) return { kind: "continue_phase4_path" };

  return tx.pauseForFunding({
    command,
    pendingAction: affordability.pendingAction, // kind + canonical fingerprint + maximum
    additionalFundingSat: affordability.shortfallSat,
    graceDeadlineMs: clock.nowMs() + 10 * 60 * 1000,
    // no action_budget / provider_operation / worker effect is created here
  });
});
```

### Pattern 2: Upload before commit; commit revokes the lease

**What:** Validate the worker proposal, create the immutable encrypted archive, then perform one serializable commit that records the exact object identity and revokes the active lease/capacity claim. [VERIFIED: 05-CONTEXT.md D-87–D-89]

**When to use:** The deadline reconciler or an equivalent fenced server-side release attempt. It is idempotent by `checkpointId` and pause generation.

**Example:**

```ts
// No external I/O runs inside the serializable finalization transaction.
const proposal = await worker.exportCheckpoint(fencedRequest);
const checkpoint = await validateCheckpointProposal(proposal, fencedRequest, proposal.events);
if (!checkpoint) throw new Error("CHECKPOINT_PROPOSAL_INVALID");

const sealed = await checkpointCrypto.seal(checkpoint.manifest, checkpoint.archive);
const object = await objectStore.createImmutable({
  key: checkpointObjectKey(checkpoint.checkpointId),
  bytes: sealed.ciphertext,
  digest: sealed.ciphertextSha256,
}); // create-if-absent; returns the immutable generation/checksum

await continuationStore.transact(accountId, (tx) =>
  tx.commitDeadlineCheckpoint({ checkpoint, sealed, object, expectedPauseGeneration }),
); // records checkpoint and revokes the exact live lease in the same commit
```

### Pattern 3: Explicit resume is a fenced claim before allocation

**What:** Treat `resume_session` as a new signed command with a new idempotency key. In one serializable transaction, authenticate owner, replay/compare fingerprint, verify expiry/compatibility/pending-action approval, reserve the fresh bounded action if affordable, and create the new checkpoint/lease claim. Allocate and restore the worker only after that commit. [VERIFIED: 05-CONTEXT.md D-91–D-93]

**When to use:** Only for a `resume_required` checkpoint. A top-up listener may schedule a harmless status refresh, never this operation. [VERIFIED: 05-CONTEXT.md D-85, D-91]

### Anti-Patterns to Avoid

- **A top-up webhook calls the worker:** A payment notification is not consent or lease authority; it may be duplicated and must only lead to a reconciler recheck. [VERIFIED: 05-CONTEXT.md D-85]
- **Store object URI without generation/checksum:** A mutable name cannot prove which archive is restored or deleted. Persist and use the returned immutable generation/checksum. [CITED: https://docs.cloud.google.com/storage/docs/request-preconditions]
- **Terminate worker before checkpoint commit:** A crash loses paid progress; fence/revoke the lease in the checkpoint-commit transaction, then terminate/release capacity idempotently. [VERIFIED: 05-CONTEXT.md D-89]
- **Use checkpoint metadata supplied by the worker as trusted:** Validate its request/action/version/workspace/hash bindings and bind coordinator-owned ledger/toolchain values separately. [VERIFIED: 05-CONTEXT.md D-87; codebase `validateCheckpointProposal`]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| AES-GCM mechanics | Ad-hoc encryption, nonce creation, or unauthenticated archive hash | Existing project AES-GCM vault pattern behind a checkpoint-specific port | It already uses a fresh 12-byte nonce, authenticated additional data, and generic decryption failure; checkpoint metadata must be similarly bound. [VERIFIED: codebase `src/funding/protected-rail-material.ts`; CITED: https://www.w3.org/TR/WebCryptoAPI/] |
| Distributed mutual exclusion | New Redis/global lock | Existing session version + worker lease + serializable continuation claim | Lock correctness must include replay, session version, pending action, and billing/operation state. [VERIFIED: codebase `src/persistence/session-store.ts`; 05-CONTEXT.md D-92] |
| Checkpoint serialization protocol | New worker-controlled bespoke transport | Existing `CheckpointProposalSchema` and `validateCheckpointProposal` | It verifies archive, inventory, evidence, session/action/version/policy/grant/workspace bindings. [VERIFIED: codebase `src/worker-port/fake-worker.ts`] |
| Object overwrite/retry logic | Blind upload/delete retry | Immutable create-if-absent and exact-generation operations in `ObjectStorePort` | Conditional requests turn duplicate/reordered operations into explicit replay/conflict outcomes rather than overwrite. [CITED: https://docs.cloud.google.com/storage/docs/request-preconditions] |
| Resume authorization | Credit-driven automatic restart | Signed owner `resume_session` with explicit pending-action approval | Funding changes balance, while resume creates a new consented work transition. [VERIFIED: 05-CONTEXT.md D-91] |

**Key insight:** The checkpoint object is not the authority to resume. The authoritative SQL claim binds that immutable object to the owner, pending action, compatibility tuple, expiry, and new lease; the archive is only restored after that claim succeeds. [VERIFIED: 05-CONTEXT.md D-87–D-94]

## Common Pitfalls

### Pitfall 1: Reserving or dispatching before the pause

**What goes wrong:** An unaffordable action gets a provider operation, worker mutation, or hold before the session is durable, creating an unresumable charge/side effect. [VERIFIED: 05-CONTEXT.md D-79]

**How to avoid:** Quote first, persist the pending intent/replay result and `needs_top_up` state in the authoritative transaction, then return status. Fresh authorization happens only after an eligible wake/resume transition. [VERIFIED: 05-CONTEXT.md D-79, D-84]

### Pitfall 2: Extending grace on every duplicate payment event

**What goes wrong:** Reconnects, duplicate relay events, or delayed rail notifications produce an unbounded expensive live worker. [VERIFIED: 05-CONTEXT.md D-83]

**How to avoid:** Write `grace_deadline_ms` exactly on the first pause; every later path compares server time to that immutable value and never updates it. [VERIFIED: 05-CONTEXT.md D-83]

### Pitfall 3: Treating successful upload as a committed checkpoint

**What goes wrong:** An object exists without a SQL binding, or SQL says resumable while the worker lease can still execute. [VERIFIED: 05-CONTEXT.md D-88–D-89]

**How to avoid:** Upload first to an immutable generation, then atomically commit its generation/checksum with the session state and lease revocation. Reap unbound objects; never restore them. [VERIFIED: 05-CONTEXT.md D-88–D-89; CITED: https://docs.cloud.google.com/storage/docs/request-preconditions]

### Pitfall 4: Resuming an old operation

**What goes wrong:** A restore repeats a settled/uncertain provider operation or reuses an old action budget, double-charging the user. [VERIFIED: 05-CONTEXT.md D-92]

**How to avoid:** The checkpoint records prior operation identifiers for audit only. The resume claim rejects already-settled pending operations and creates a fresh action authorization only for the explicitly approved not-yet-started pending action. [VERIFIED: 05-CONTEXT.md D-79, D-92]

### Pitfall 5: Retaining raw reasoning or credentials in the archive

**What goes wrong:** Continuity storage becomes a durable prompt, secret, or chain-of-thought sink. [VERIFIED: 05-CONTEXT.md D-80, D-88, D-90]

**How to avoid:** Schema-enumerate archive entries; retain harness conversation state only when needed, bounded agent state, workspace, evidence references, and compatibility metadata. Reject raw chain-of-thought, Nostr keys, long-lived cloud/worker credentials, and bearer material before encryption. [VERIFIED: 05-CONTEXT.md D-88, D-90]

## Code Examples

### Safe owner-scoped resume claim

```ts
// Source: project lease/funding transaction pattern + D-91–D-94.
await continuationStore.transact(accountId, async (tx) => {
  const replay = await tx.findResumeResult(command);
  if (replay) return replay;

  const checkpoint = await tx.lockCheckpoint(command.checkpointId);
  tx.assertOwner(checkpoint, command.principal);
  tx.assertExpectedVersion(checkpoint, command.expectedCheckpointVersion);
  tx.assertPendingActionApproval(checkpoint, command.pendingActionFingerprint);
  tx.assertNotExpiredOrClaimedBeforeDeadline(checkpoint, clock.nowMs());
  tx.assertCompatibilityOrMigration(checkpoint, coordinatorCompatibility);
  tx.assertNoPriorOperationCanBeRedispatched(checkpoint);

  const budget = await tx.reserveFreshActionBudget(command.freshAuthorization);
  return tx.claimResumeAndLease({ checkpoint, command, budget, nowMs: clock.nowMs() });
});
// Only the returned claim holder may allocate/restore the worker.
```

### Safe authenticated checkpoint envelope

```ts
// Source: existing ProtectedRailMaterialVault shape; checkpoint-specific types required.
const aad = canonicalJson({
  checkpointId, accountId, sessionId, pauseGeneration,
  archiveSha256, policyVersion, toolchainCompatibilityId,
});
const nonce = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(aad) },
  encryptionKey,
  archiveBytes,
);
// Persist algorithm/key-reference/nonce/AAD digest/ciphertext digest in manifest;
// any authentication failure is a generic restore denial.
```

The W3C API specifies AES-GCM as authenticated encryption with a required IV; the project already demonstrates a 12-byte nonce plus authenticated metadata pattern. This is a Phase 5 deterministic design contract, not a production KMS selection. [CITED: https://www.w3.org/TR/WebCryptoAPI/] [VERIFIED: codebase `src/funding/protected-rail-material.ts`]

## State of the Art

| Old approach | Current approach | Impact |
|---|---|---|
| Hold a live worker as the only continuation state | Validated checkpoint proposal + immutable encrypted archive + SQL claim | Worker loss/restart can recover from a durable boundary without granting the archive authority. [VERIFIED: 05-CONTEXT.md D-87–D-92] |
| Payment event means “continue work” | Payment credit changes funds; coordinator predicates or signed resume decide work | Duplicate/out-of-order notifications cannot silently spend or allocate a second worker. [VERIFIED: 05-CONTEXT.md D-84–D-85, D-91] |
| Mutable object name is a checkpoint reference | Name plus exact immutable generation/checksum | Restore/delete operations identify one exact ciphertext version and race failures are explicit. [CITED: https://docs.cloud.google.com/storage/docs/request-preconditions] |

**Deprecated/outdated:** Any automatic post-grace continuation triggered solely by a Lightning/Cashu notification is incompatible with D-91 and must not be added. [VERIFIED: 05-CONTEXT.md D-91]

## Assumptions Log

All material continuation decisions are locked in `05-CONTEXT.md`; no unverified design assumption is required for Phase 5 planning.

## Open Questions

None blocking planning. Exact table/field names, deterministic object/encryption envelope representation, scheduler cadence, and stable error strings are explicitly delegated to implementation while preserving D-79–D-95. [VERIFIED: 05-CONTEXT.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---:|---|---|
| Bun/Web Crypto | deterministic encryption/checkpoint tests | Yes | Bun 1.3.14 | — |
| SQLite | durable deterministic-store tests | Yes | 3.43.2 | in-memory double only for narrowly scoped unit tests |
| tar + zstd | portable archive fixture generation | Yes | bsdtar 3.5.3 / zstd 1.5.7 | existing deterministic archive fixture where shell archive is unnecessary |
| Docker | existing worker/image fixture environment | Yes | 28.5.2 | deterministic fake worker; no live worker certification |
| Modal, GCS, KMS credentials/CLI | live worker/object/key validation | Not evaluated by design | — | deterministic `WorkerPort`, `ObjectStorePort`, and encryption double; certify in Phase 7 |

**Missing dependencies with no fallback:** None for deterministic Phase 5 design validation. [VERIFIED: environment; 05-CONTEXT.md]  
**Missing dependencies with fallback:** Live Modal/GCS/KMS integration is deliberately deferred to Phase 7. [VERIFIED: 05-CONTEXT.md]

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework | Bun test, Bun 1.3.14 [VERIFIED: package.json; environment] |
| Config file | none; `test` delegates to `bun test` [VERIFIED: package.json] |
| Quick run command | `bun test tests/phase-05 tests/persistence/continuation-store.test.ts tests/contextvm/adapter.test.ts --timeout 10000` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| CONT-01 | Unaffordable bounded action persists exactly one pending intent/`needs_top_up` result before budget, operation, worker, or debit. | unit + transaction | `bun test tests/phase-05/pause-for-funding.test.ts` | ❌ Wave 0 |
| CONT-02 | Owner status exposes exact safe funding/cap/deadline/checkpoint fields and redacts source, prompts, credentials, raw provider data, and reasoning. | contract + leakage | `bun test tests/phase-05/continuation-status.test.ts` | ❌ Wave 0 |
| CONT-03 | Duplicate/concurrent verified-credit observations resume only one unchanged lease after fresh authorization; stale/expired lease is denied. | race + integration | `bun test tests/phase-05/grace-wake.test.ts` | ❌ Wave 0 |
| CONT-04 | Deadline writes validated complete checkpoint, commits object identity, fences effects, releases capacity, and safely recovers all injected crash points. | fault injection | `bun test tests/phase-05/deadline-checkpoint.test.ts` | ❌ Wave 0 |
| CONT-05 | Archive manifest/envelope binds all required lineage, detects tampering, uses immutable generation/checksum, and rejects forbidden archive fields. | unit + security | `bun test tests/phase-05/checkpoint-envelope.test.ts` | ❌ Wave 0 |
| CONT-06 | Credit alone never resumes post-window work; exact signed `resume_session` replays, and foreign/stale/conflicting input fails before allocation/billing. | ContextVM + integration | `bun test tests/phase-05/resume-session.test.ts tests/contextvm/adapter.test.ts` | ❌ Wave 0 |
| CONT-07 | One pre-expiry claim may finish, concurrent claims yield one worker, prior operations never redispatch, and post-expiry tombstone/deletion is irreversible. | time/race + integration | `bun test tests/phase-05/retention-expiry.test.ts` | ❌ Wave 0 |

### Required adversarial/reference cases

- Affordability: zero/partial balance, cap-only shortfall, both shortfalls, duplicate pause, conflicting idempotency key, and repeated interruption.
- Grace: credit immediately before/at/after deadline; duplicate or reordered Lightning/Cashu settlement wake; reconnect; stale lease token; separate cap approval still required.
- Checkpoint: invalid proposal, mismatched request/version/workspace/evidence digest, wrong archive digest, AAD/ciphertext tamper, duplicate immutable put, object write success then SQL rollback, and SQL commit then worker termination loss.
- Resume: foreign owner, wrong checkpoint/session version, altered pending fingerprint, mismatch compatibility, migration denied, exact replay, simultaneous commands, allocation failure after claim, and no dispatch of prior settled/uncertain operation.
- Expiry: claim at `deadline - 1ms`, claim at `deadline`, claim after deadline, duplicate reaper, deletion retry, safe `expired` status, and no resurrection after later credit.

### Sampling Rate

- **Per task commit:** Relevant Phase 5 test file plus `bun test tests/persistence/session-store.test.ts tests/persistence/postgres-sql-funding-store.test.ts tests/worker-port/fake-worker.test.ts --timeout 10000`.
- **Per wave merge:** `bun test` and the deterministic Phase 5 reference-set command.
- **Phase gate:** Full suite green plus content-addressed Phase 5 design evidence that explicitly labels Modal/GCS/KMS as unselected/unprobed.

### Wave 0 Gaps

- [ ] `src/continuity/{contracts,continuation-service,checkpoint-envelope,object-store,deadline-reconciler}.ts` — continuation core and deterministic ports.
- [ ] `tests/phase-05/{pause-for-funding,continuation-status,grace-wake,deadline-checkpoint,checkpoint-envelope,resume-session,retention-expiry}.test.ts` — CONT-01 through CONT-07.
- [ ] `tests/persistence/continuation-store.test.ts` plus PostgreSQL parity coverage — atomic pause/checkpoint/claim/tombstone persistence behavior.
- [ ] `tests/evals/phase-05-reference-set.test.ts` and redacted fixture — deterministic end-to-end acceptance set.
- [ ] `scripts/verify-phase-05-design-slice.ts` and `src/verification/phase-05-design-evidence.ts` — immutable evidence emission.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | Yes | ContextVM verified pubkey is converted to the domain principal; resume/status must recheck checkpoint ownership. [VERIFIED: codebase `src/contextvm/adapter.ts`; 05-CONTEXT.md D-91] |
| V3 Session Management | Yes | Expected session/checkpoint versions, idempotency fingerprint, expiring lease token, and fixed server deadlines fence stale/replayed commands. [VERIFIED: codebase `src/persistence/session-store.ts`; 05-CONTEXT.md] |
| V4 Access Control | Yes | Owner-scoped safe status and resume claim; generic denial before archive read/worker allocation for foreign input. [VERIFIED: 05-CONTEXT.md D-80, D-92] |
| V5 Input Validation | Yes | Strict Zod schemas for resume payload, manifests, object metadata, and worker proposal; reject unknown fields and oversized archives/inventories. [VERIFIED: package.json; codebase; 05-CONTEXT.md] |
| V6 Cryptography | Yes | Coordinator-owned AES-GCM envelope with fresh nonce and canonical authenticated metadata; no user private key or long-lived credential in archive. [VERIFIED: codebase `src/funding/protected-rail-material.ts`; 05-CONTEXT.md D-88] |

### Known Threat Patterns for continuation state

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Duplicate/forged credit wake | Spoofing / Elevation | Only ledger-verified credit is considered, then serializable owner/pending/version/lease/cap/funds rechecks decide same-worker wake. [VERIFIED: 05-CONTEXT.md D-84–D-85] |
| Stale worker after deadline or failover | Tampering | Lease token plus session/pause generation are checked at every coordinator effect; deadline commit revokes the token before external termination. [VERIFIED: 05-CONTEXT.md D-86, D-89; codebase] |
| Checkpoint substitution/tamper | Tampering | Canonical manifest binds owner/session/action/version/policy/toolchain/object generation and digests; AES-GCM authenticates archive/AAD; restore fails closed. [VERIFIED: 05-CONTEXT.md D-87–D-93; CITED: https://www.w3.org/TR/WebCryptoAPI/] |
| Resume replay or duplicate allocation | Repudiation / Denial | Canonical command fingerprint and result replay; atomic checkpoint claim plus fresh lease before allocation. [VERIFIED: 05-CONTEXT.md D-82, D-92] |
| Archive disclosure through status or storage | Information Disclosure | Public schema exports references/safe facts only; archive contains no private key, bearer credential, raw reasoning, or native provider payload. [VERIFIED: 05-CONTEXT.md D-80, D-88, D-90] |
| Top-up revives expired work | Elevation | Expiry tombstone is terminal and independent of balance; later credit cannot transition it. [VERIFIED: 05-CONTEXT.md D-94] |

## Sources

### Primary (HIGH confidence)

- Project code graph and source: `src/persistence/session-store.ts`, `src/persistence/postgres-sql-funding-store.ts`, `src/worker-port/fake-worker.ts`, `src/funding/protected-rail-material.ts`, and `src/contextvm/adapter.ts` — existing lease, replay, serializable, checkpoint, encryption, and adapter seams. [VERIFIED: codebase]
- `05-CONTEXT.md` — locked D-79–D-95 behavior and deferrals. [VERIFIED: 05-CONTEXT.md]
- `package.json`, environment probes, and passing targeted regression command — test/runtime baseline. [VERIFIED: package.json; environment]

### Secondary (MEDIUM confidence)

- [Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/) — AES-GCM authenticated-encryption/IV API basis. [CITED: https://www.w3.org/TR/WebCryptoAPI/]
- [Cloud Storage request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions) — generation/metageneration conditional operation semantics. [CITED: https://docs.cloud.google.com/storage/docs/request-preconditions]

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — it reuses project-pinned dependencies and explicitly avoids a new provider/package decision. [VERIFIED: package.json; 05-CONTEXT.md]
- Architecture: HIGH — pause, grace, checkpoint, resume, fencing, and retention behavior are locked and map to codebase seams. [VERIFIED: 05-CONTEXT.md; codebase]
- Pitfalls: HIGH — each follows an explicit locked invariant or existing effect/lease behavior; cloud object conditional-write detail is MEDIUM official documentation. [VERIFIED: 05-CONTEXT.md; codebase] [CITED: https://docs.cloud.google.com/storage/docs/request-preconditions]

**Research date:** 2026-08-05  
**Valid until:** 2026-09-04 for deterministic design; provider certification remains deferred to Phase 7. [VERIFIED: 05-CONTEXT.md]
