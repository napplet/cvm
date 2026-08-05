# Phase 5: Funding Interruption & Durable Resume - Context

**Gathered:** 2026-08-05
**Status:** Ready for planning
**Mode:** Autonomous smart discuss; prior user decisions and milestone requirements resolved all material grey areas

<domain>
## Phase Boundary

This phase preserves a funded generation session when the next bounded action cannot be afforded. It owns the visible `needs_top_up` state, the ten-minute same-worker grace window, durable encrypted checkpoint creation, explicit post-window resume, single-worker fencing, and secure 30-day expiry. It does not add preview/publication (Phase 6), select/certify production providers or SLOs (Phase 7), change payment rails, or broaden the napplet/agent authority boundary.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets

- `CheckpointProposalSchema` and `DeterministicFakeWorker.checkpoint` already produce a portable archive, inventory, and cryptographic digests at the worker boundary.
- `TransactionalMemorySessionStore` and `SqliteSessionStore` already claim, assert, and release version-bound worker leases; Phase 5 should extend this fencing pattern rather than invent a second lock model.
- `FundedAdmissionService.authorizeActionBudget` and Phase 4 metered-action records provide the pre-dispatch affordability and exact replay seams.
- Phase 3 Lightning/Cashu coordinators already normalize verified credits and reconciliation without granting payment notifications financial authority.
- Phase 4 owner-safe `session_status`, immutable line items, operation IDs, and artifact/checkpoint lineage provide the public projection and audit foundations.

### Established Patterns

- Persist intent before external I/O; exact replay returns the durable canonical result and conflicting reuse fails closed.
- Workers propose typed bounded facts; the coordinator owns money, session state, leases, checkpoint acceptance, and all public results.
- Provider/platform evidence is separated from design readiness. Deterministic adapters prove semantics without claiming live-provider selection.
- Public schemas are strict allowlists with safe summaries and protected evidence references rather than raw sensitive payloads.

### Integration Points

- Extend the transport-neutral metered session coordinator at the action-budget boundary to create a pending-action/pause intent before any new effects.
- Extend the durable funding/session store interfaces and PostgreSQL migration with pause generation, grace deadline, checkpoint metadata, claim/release/expiry, and resume idempotency authority.
- Extend `WorkerPort`/Modal adapter composition with validated checkpoint export, restore, and termination/release operations behind the existing lease token.
- Extend `readSessionStatus` and the ContextVM adapter with owner-safe pause/checkpoint fields and `resume_session` only.
- Add deterministic deadline/top-up/restart race fixtures and content-addressed Phase 5 design evidence, retaining live object-store/worker certification for Phase 7.

</code_context>

<specifics>
## Specific Ideas

- The user explicitly wants an exhausted balance to pause and ask for a top-up, not fail the session.
- The live worker waits for ten minutes; if funding does not arrive, progress and agent context must be saved so the same session can be resumed later.
- Within the live window the experience should feel fluid; after the window a deposit alone must never cause surprise spending.
- ContextVM remains one v1 interface/transport, with CEP-8 funding and future x402/L402 adapters kept outside this phase.

</specifics>

<deferred>
## Deferred Ideas

- Live Modal/GCS provider selection, production credentialing, measured restore latency, multi-region failover, and chaos/SLO certification — Phase 7.
- Preview, user signing, publication, deployment, and attestation — Phase 6.
- Public x402/L402 transports — v2.

</deferred>
