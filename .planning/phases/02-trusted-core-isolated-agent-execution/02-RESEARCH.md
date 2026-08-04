# Phase 02: Trusted Core & Isolated Agent Execution - Research

**Researched:** 2026-08-04
**Domain:** Transport-neutral authoritative session state and untrusted-worker isolation
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Trusted Core and Serialization

- **D-20:** The coordinator owns a deterministic domain state machine. Every authoritative action binds principal, session, action kind, idempotency key, expected state version, and policy version before evaluation.
- **D-21:** A successful transition atomically advances one durable session version and records its result. Replaying the same idempotency key returns the recorded result; conflicting reuse fails closed; concurrent stale-version actions receive a deterministic conflict and may be retried from the new state.
- **D-22:** Workers emit typed proposals and evidence only. They cannot commit billing, balance, reservation, session, policy, artifact-version, signing, deployment, or publication state.
- **D-23:** The trusted core and its action/result schemas are transport-neutral. ContextVM, and later x402 or L402 adapters, authenticate a principal and translate protocol envelopes without changing state-machine semantics.

### Input and Prompt-Injection Guardrails

- **D-24:** Admission accepts one bounded plain-text napplet idea. Canonical encoding, character, byte, token, and structural limits are checked before worker allocation, model calls, or billable execution.
- **D-25:** Reject malformed Unicode, ambiguous encodings, oversized input, embedded files/binary payloads, repository or existing-code submissions, and inputs that attempt to introduce an alternate structured control channel. URL-shaped text may be described as content but never fetched or treated as authority during admission.
- **D-26:** Prompt-injection and jailbreak detection produces risk signals and audit evidence. Classifier output may reject or constrain work under a versioned deterministic rule, but it never expands permissions, alters system policy, or bypasses a hard validation rule.
- **D-27:** Boundary errors use stable machine-readable codes and safe summaries. Logs and metrics retain lengths, hashes, rule identifiers, and signals by default rather than raw user text.

### Worker Authority and Tool Surface

- **D-28:** The worker receives a fixed, typed allowlist of session-scoped tools derived from a versioned policy. Unknown tools, unknown fields, invalid state, expired grants, scope mismatch, and path escape all fail closed.
- **D-29:** Tools expose narrowly-scoped napplet authoring operations and evidence capture. Billing, account, session lifecycle, policy mutation, user signing, deployment, and publication are never worker tools.
- **D-30:** Every tool request and decision is correlated with the session, action, state version, policy version, and capability grant, producing append-only evidence suitable for later audit.
- **D-31:** Filesystem access is confined to the assigned session workspace. The worker must not see another session, host paths, control-plane secrets, database credentials, cloud credentials, Nostr private keys, or long-lived service credentials.

### Isolation and Gateway Contract

- **D-32:** Introduce a vendor-neutral `WorkerPort` with a deterministic test implementation and a Modal-backed candidate adapter. Provider selection remains replaceable and cannot leak into domain logic.
- **D-33:** Each accepted session receives a fresh or cryptographically clean isolated workspace with explicit CPU, memory, process, lifetime, and filesystem limits; no inbound ports; and network denied by default.
- **D-34:** Any required model, package, preview, or checkpoint interaction crosses a typed coordinator-owned gateway using short-lived, session-bound capability grants. The worker never receives upstream API keys or arbitrary outbound network access.
- **D-35:** Checkpoint export occurs only at validated action boundaries and returns a portable workspace archive plus versioned agent/session metadata and hashes. Phase 2 proves the interface; Phase 5 owns durable retention, the ten-minute live pause, 30-day expiry, and resume semantics.
- **D-36:** Worker loss or adapter uncertainty never implies success. The trusted core either records a complete validated result for the expected version or leaves the prior authoritative state intact and emits recoverable failure evidence.

### Design-Stage Validation Boundary

- **D-37:** Phase 2 must exercise representative isolation, default-deny egress, scoped gateway, workspace confinement, typed-tool denial, checkpoint export, duplicate delivery, and concurrent action behavior without claiming production platform certification.
- **D-38:** The production-like sandbox probe is a provider-selection gate, not a mandate to embed Modal. If Modal cannot satisfy the contract, retain the interface and substitute another isolated worker implementation.
- **D-39:** Preserve Phase 1's fail-closed evidence and artifact-contract patterns. Do not duplicate NIP-5D or napplet-package conformance logic inside the worker authority.

### the agent's Discretion

- Choose exact state names, action schemas, error codes, optimistic-concurrency representation, and evidence layout while preserving the decisions above.
- Choose conservative numeric input and worker resource defaults, provided all limits are versioned configuration and admission occurs before billable work.
- Choose the model/package gateway split and the smallest representative fake/adapter needed to prove the `WorkerPort` contract.
- Choose whether classifier risk constrains or rejects a request at each threshold, provided it can never grant authority or weaken deterministic hard rules.

### Deferred Ideas (OUT OF SCOPE)

- Phase 3: prepaid ledger, reservations, exact usage debits, CEP-8 top-ups, and financial transaction coupling.
- Phase 4: iterative generation/revision loop, preview UX, and full napplet authoring harness behavior.
- Phase 5: live ten-minute insufficient-balance pause, durable checkpoints, 30-day retention, explicit resume, lease recovery, and expiry.
- Phase 6: ContextVM/Nostr adapter, signed principal mapping, protocol replay behavior, and user-owned signing/publication flow.
- Phase 7: exhaustive hostile testing, production Modal or replacement certification, measured p95 readiness, chaos/regional testing, formal launch security evidence, and full supply-chain hardening.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SESS-05 | Concurrent or duplicated session actions are serialized so only one valid next action can mutate a session or artifact version. | Version-fenced `SessionStore.apply`, idempotency-result table, uniqueness constraints, deterministic fake-worker barrier tests. |
| SAFE-01 | Reject oversized/malformed prompt and revision input before billable execution. | Admission schema and canonical preflight sequence with stable denial codes and redacted evidence. |
| SAFE-02 | Detect and record injection/jailbreak signals without delegating policy to classifier output. | One-way risk signal → deterministic policy decision; classifier cannot add a grant or bypass a hard rule. |
| SAFE-03 | Agent can use only current-session typed allowlisted tools and cannot alter authority. | Strict envelopes, coordinator-derived grant, fixed tool enum, and gateway side-effect spies. |
| SAFE-04 | Each worker is isolated from other sessions, credentials, durable authority, and unrestricted egress. | `WorkerPort`, session workspace canaries, default-deny Modal candidate probe, and a coordinator-owned gateway. |
</phase_requirements>

## Summary

This phase should implement a small authoritative core before any realistic agent loop: admit one idea, create/apply a version-fenced action, issue a narrow grant, invoke `WorkerPort`, validate its untrusted events, and commit one correlated result/evidence record or a recoverable failure. The worker is a proposal source only; it cannot call a repository, ledger, signer, deployment, publication, or state-transition API. [VERIFIED: 02-CONTEXT.md]

Use a project-owned persistence port with a production-shaped SQLite implementation and an in-memory implementation for deterministic tests. SQLite is built into Bun and supports prepared statements and atomic transactions; its single-process implementation is adequate for this vertical slice but must stay behind `SessionStore` so Phase 3 can replace it with the planned PostgreSQL-wire transactional store without changing state-machine semantics. [CITED: https://bun.com/docs/runtime/sqlite] [VERIFIED: .planning/research/STACK.md]

The live provider proof should be deliberately narrow: a Modal adapter creates a fresh sandbox with `blockNetwork: true`, no ports, no secrets, no volumes/bucket mounts, and explicit CPU, memory, total-lifetime, and idle-time limits; it runs a probe image containing browser/build prerequisites and exports a checkpoint archive. Modal’s JavaScript API documents these controls, but this test is a provider-selection observation—not a security certification, readiness-SLO proof, or permission to place credentials in a worker. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox] [CITED: https://modal.com/docs/guide/sandbox-networking] [VERIFIED: 02-CONTEXT.md]

**Primary recommendation:** Plan a tracer slice around `admit → apply version-fenced action → issue grant → deterministic WorkerPort → strict proposal/tool gateway → commit evidence`, then add one separately invoked, credential-gated Modal contract probe that uses exactly the same port contract.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Input canonicalization, limits, risk signals | API / Backend | — | Untrusted input must be rejected before allocation or model/worker work. [VERIFIED: D-24–D-27] |
| Session transition, idempotency, version fencing | Database / Storage | API / Backend | The durable action/result record is the sole authority for mutation and replay. [VERIFIED: D-20–D-21] |
| Capability derivation and typed-tool authorization | API / Backend | Database / Storage | The coordinator owns policy and validates every use against persisted action/version facts. [VERIFIED: D-28–D-30] |
| Workspace execution and untrusted proposals | Isolated Worker | API / Backend | The worker proposes; the coordinator validates and commits. [VERIFIED: D-22, D-32–D-36] |
| Egress/model/package/checkpoint access | API / Backend | Isolated Worker | Gateway holds upstream authority; worker holds an opaque, expiring grant only. [VERIFIED: D-34] |
| Checkpoint archive bytes | Isolated Worker | Database / Storage | Worker creates portable bytes; coordinator validates metadata/hash and records a boundary. [VERIFIED: D-35] |
| Artifact contract/conformance | Existing Phase 1 runner/policy | API / Backend | Phase 2 composes the existing gate rather than reimplementing napplet semantics. [VERIFIED: D-39] |

## Project Constraints (from AGENTS.md)

- Prefer codebase-memory graph tools for code discovery; use text search only for literals/configuration or insufficient graph results.
- Do not directly edit implementation outside an authorized GSD workflow; this research artifact is produced by the phase-planning workflow.
- Preserve the product boundaries: transport-neutral core, no user Nostr private-key custody, bounded text input, no durable admission queue, and no worker access to money/credentials/publication. [VERIFIED: AGENTS.md]

## Standard Stack

### Core

| Library / built-in | Version | Purpose | Why Standard |
|--------------------|---------|---------|--------------|
| TypeScript + Bun | TypeScript 5.9.x; Bun 1.3.14 installed | Domain contracts, built-in test runner, `bun:sqlite` persistence. | Bun provides a TypeScript runner/tester and built-in SQLite transaction API; it avoids an extra database dependency for the deterministic phase slice. [CITED: https://bun.com/docs/test] [CITED: https://bun.com/docs/runtime/sqlite] |
| `zod` | 4.4.3, published 2026-05-04 | Strict runtime schemas at every untrusted boundary. | `z.strictObject` rejects unknown keys; `safeParse` makes denial data explicit. [CITED: https://zod.dev/api?id=property] [VERIFIED: npm registry] |
| `modal` | 0.9.0, published 2026-07-09 | Candidate-only `WorkerPort` adapter and optional live isolation probe. | The official JS Sandbox API supplies create/exec/terminate, hard resource ceilings, `blockNetwork`, and a filesystem interface, while the domain remains vendor-neutral. The automated release-age audit signal is informational for this reversible design pass; it does not imply provider selection. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox] |

### Supporting

| Library / tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `bun:sqlite` | Bun built-in | `sessions`, `action_results`, and append-only `evidence` tables in one transaction. | Phase-2 local durable slice and deterministic file/`:memory:` tests; never couple it to billing. [CITED: https://bun.com/docs/runtime/sqlite] |
| `tar` + `zstd` | Installed: bsdtar 3.5.3; zstd 1.5.7 | Portable workspace archive. | Adapter/probe checkpoint export only; metadata and SHA-256 are coordinator-validated. [VERIFIED: environment availability] |
| Existing Phase 1 evidence + artifact policy | repository current | Canonical evidence and downstream napplet acceptance gate. | Compose after worker output; do not copy manifest/conformance logic into Phase 2. [VERIFIED: src/evidence/bundle.ts; src/policy/artifact-contract.ts; D-39] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `WorkerPort` + deterministic fake + Modal candidate | Embed Modal SDK calls in domain services | Forbidden by D-32 because it would make transport-neutral authority vendor-shaped. [VERIFIED: D-32] |
| Bun SQLite behind `SessionStore` | In-memory maps only | Maps cannot demonstrate a durable atomic action/result boundary; retain maps only as the deterministic test double. [ASSUMED] |
| Coordinator gateway with `blockNetwork: true` worker | Modal domain allowlist | Modal documents domain allowlisting as Beta and runtime network updates as Alpha; neither should be Phase 2’s security foundation. [CITED: https://modal.com/docs/guide/sandbox-networking] |

**Installation:**

```bash
bun add zod@4.4.3
# optional reversible candidate adapter; exact official SDK pin:
bun add modal@0.9.0
```

**Version verification:** `npm view zod version` returned `4.4.3`; `npm view modal version` returned `0.9.0` on 2026-08-04. Both packages had no `postinstall` script returned by `npm view <package> scripts.postinstall`. [VERIFIED: npm registry]

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `zod@4.4.3` | npm | package 6y; release ~3mo | 251,112,541/wk | github.com/colinhacks/zod | OK | Approved; official Zod docs also confirm the package. [VERIFIED: npm registry] |
| `modal@0.9.0` | npm | package 13y; release 26d | 421,155/wk | github.com/modal-labs/modal-client | OK (official SDK; release-age signal informational) | Pin exact version/integrity, confine it to the reversible candidate adapter, and contract-test the accepted surface; no provider/account/image selection follows from installation. [VERIFIED: npm registry; package-legitimacy seam] |

**Packages removed due to [SLOP] verdict:** none. [VERIFIED: package-legitimacy seam]

**Packages flagged as suspicious [SUS]:** none. The automated release-age signal for official `modal@0.9.0` is retained as informational evidence for this reversible design-only adapter; exact pinning, import confinement, safe-surface tests, and honest blocked provider evidence remain mandatory. [VERIFIED: package-legitimacy seam] [VERIFIED: D-32, D-38]

## Architecture Patterns

### System Architecture Diagram

```text
transport adapter / test caller
  │ authenticated Principal + bounded idea + action envelope
  v
AdmissionPolicy ──deny(code, hash, ruleIds)──> append-only evidence
  │ accepted Admission
  v
TrustedSessionService ──atomic apply(expectedVersion, idempotencyKey)──> SessionStore
  │ issued grant (session/action/version/policy/expiry/tool set)
  v
WorkerPort (fake or Modal adapter) ──untrusted events/proposals──> ScopedToolGateway
  │                                                        │
  │ fresh workspace; no credentials; default-deny egress  ├─ allowlisted workspace/evidence/checkpoint only
  │                                                        └─ deny unknown/stale/path-escape/authority tools
  v
strict result/checkpoint validation ──> artifact contract (existing Phase 1) ──> atomic result + evidence commit
  │ failure/timeout/uncertainty
  └──────────────────────────────────────────────────────────────> prior state preserved + recoverable evidence
```

### Recommended Project Structure

```text
src/
├── admission/          # canonical bounded idea + risk signals + stable denials
├── domain/             # session action state machine and transport-neutral DTOs
├── persistence/        # SessionStore port, SQLite store, in-memory test store
├── capabilities/       # versioned policy, grant derivation, strict tool schemas
├── worker-port/        # request/event/checkpoint schemas and deterministic fake
├── worker-adapters/    # Modal candidate only; no domain/policy ownership
├── gateways/           # coordinator-owned tool/model/checkpoint adapters
└── evidence/           # action-correlated immutable evidence records
tests/
├── admission/ domain/ capabilities/ worker-port/ persistence/
└── integration/        # separately invoked Modal probe, skipped without credentials
```

### Pattern 1: Atomic, idempotent state-machine application

**What:** Implement `SessionStore.apply(request)` as the only durable mutation. In one transaction: load `session_id`; detect an existing `(session_id, idempotency_key)`; compare the complete action fingerprint; return its recorded result on exact replay; reject conflicting reuse; require `version = expectedVersion`; insert result/evidence; and update the session to `version + 1`. [VERIFIED: D-20–D-21] [CITED: https://bun.com/docs/runtime/sqlite]

**When to use:** Every coordinator action, including worker dispatch/result finalization. Never let event handlers or worker callbacks update a session directly. [VERIFIED: D-20–D-22]

**Example:**

```ts
// Source: https://bun.com/docs/runtime/sqlite
const apply = db.transaction((request: ActionRequest): ActionResult => {
  const replay = actionByKey.get(request.sessionId, request.idempotencyKey);
  if (replay) return sameFingerprint(replay, request)
    ? replay.result
    : deny("IDEMPOTENCY_KEY_CONFLICT");
  const session = sessionById.get(request.sessionId);
  if (!session || session.version !== request.expectedVersion) return deny("STALE_SESSION_VERSION");
  const result = evaluateTrustedTransition(session, request); // no worker authority
  actions.insert(request, result); evidence.insert(result.evidence);
  sessions.updateVersion(session.id, session.version + 1);
  return result;
});
```

### Pattern 2: Coordinator-issued capability grants, not bearer permissions

**What:** Derive an opaque grant after a successful action admission; keep grant claims as `{grantId, sessionId, actionId, expectedVersion, policyVersion, toolNames, workspaceId, expiresAt}`. The gateway looks up and revalidates every claim, does not trust worker-supplied copies, and consumes/revokes it when the action becomes terminal. [VERIFIED: D-28–D-30]

**When to use:** Each tool request and checkpoint export. A tool enum contains authoring/evidence operations only: workspace read/write, approved-command ID, evidence capture, and checkpoint export. It deliberately excludes money, lifecycle, policy, signing, deployment, and publication. [VERIFIED: D-29]

### Pattern 3: Strict untrusted envelopes

**What:** Use `z.strictObject`/strict nested schemas plus explicit size bounds to parse admissions, actions, grants, worker events, gateway calls, checkpoints, and evidence. Ordinary Zod objects strip unknown fields by default, so they are inappropriate for this authority boundary. [CITED: https://zod.dev/api?id=property]

```ts
// Source: https://zod.dev/api?id=property
const WorkerToolRequest = z.strictObject({
  sessionId: z.string().uuid(), actionId: z.string().uuid(),
  expectedVersion: z.int().nonnegative(), policyVersion: z.string().min(1).max(64),
  grantId: z.string().uuid(), tool: z.enum(["read_workspace_file", "write_workspace_file", "run_approved_command", "capture_evidence", "export_checkpoint"]),
  args: z.strictObject({ path: z.string().max(300) }).optional(),
});
```

### Pattern 4: Separate fake from demonstrated provider behavior

| Concern | Fake deterministically | Demonstrate live in one provider-gated probe |
|---------|-------------------------|-----------------------------------------------|
| State/idempotency/concurrency | Controlled barrier fake worker and SQLite/`:memory:` store. [VERIFIED: D-21] | Never rely on provider scheduling for deterministic semantics. [ASSUMED] |
| Grant/tool authorization | Gateway fake filesystem, side-effect spies, injected clock. [VERIFIED: D-28–D-30] | One real adapter request with a fresh grant and an approved gateway response. [VERIFIED: D-37] |
| Workspace isolation | Deterministic per-session temp directories/canaries. [VERIFIED: D-31] | Two actual sandboxes: own canary readable, sibling/host-secret canaries absent. [VERIFIED: D-37] |
| Egress/inbound | Unit-deny policy and fake gateway. [VERIFIED: D-33–D-34] | DNS/HTTPS/WebSocket/raw-TCP deny attempts under `blockNetwork: true`; no port option; approved gateway event still succeeds. [CITED: https://modal.com/docs/guide/sandbox-networking] |
| Browser/build support | Fake adapter reports a capability manifest only. [ASSUMED] | Probe image runs a minimal pinned `bun --version` plus Chromium/Playwright executable check and records versions. [VERIFIED: D-37] |
| Checkpoint export | Deterministic archive metadata/hash validator. [VERIFIED: D-35] | Export workspace tar.zst, verify hash/listing, reject out-of-workspace paths and record manifest. [VERIFIED: D-35, D-37] |

### Anti-Patterns to Avoid

- **A Bun `Worker` as an isolation boundary:** it is not the designated untrusted-code sandbox; preserve `WorkerPort` and use it only for benign local concurrency if ever needed. [VERIFIED: 02-AI-SPEC.md]
- **Worker `postMessage`/TypeScript types as validation:** structured data is still untrusted; parse and bind every event. [VERIFIED: D-28]
- **Shell command strings or model-selected URLs:** represent approved command IDs and gateway operations as enums, never passed-through strings. [VERIFIED: D-25, D-28–D-29]
- **Grant stored only in the worker:** this invites replay/cross-session confusion; the coordinator validates server-side state every time. [ASSUMED]
- **Success after worker timeout/termination:** preserve prior authoritative state and emit evidence. [VERIFIED: D-36]
- **Modal domain allowlists as the core control:** current domain allowlisting is Beta and runtime updates Alpha; `blockNetwork` plus coordinator mediation is the baseline. [CITED: https://modal.com/docs/guide/sandbox-networking]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Runtime boundary parsing | TypeScript casts/manual `typeof` chains | Zod strict schemas | Unknown-key rejection and structured failures must be consistent at every boundary. [CITED: https://zod.dev/api?id=property] |
| Provider isolation implementation | Docker/Bun-Worker imitation as proof of Modal behavior | `WorkerPort` fake for contracts plus the real Modal candidate probe | The phase needs separately observable semantic tests and provider evidence. [VERIFIED: D-32, D-37–D-38] |
| Atomic session application | Ad-hoc mutex + mutable map | transactional `SessionStore` operation | Replay/action/evidence/version must commit together. [VERIFIED: D-21] |
| Archive format | Custom checkpoint serialization | tar + zstd with a strict metadata/hash manifest | Portable archives and existing tools reduce format surface; resume/retention remains Phase 5. [VERIFIED: D-35] |
| Napplet validity | A second NIP/NAP parser | Existing Phase 1 artifact contract/conformance path | Phase 2 must compose, not duplicate, upstream-owned conformance. [VERIFIED: D-39] |

**Key insight:** The prompt classifier is an input signal, while least authority is enforced by an independently validated gateway. OWASP’s excessive-agency guidance favors eliminating excess functionality, permission, and autonomy; a classifier cannot substitute for those controls. [CITED: https://genai.owasp.org/llmrisk/llm062025-excessive-agency/]

## Common Pitfalls

### Pitfall 1: Advancing state before worker result validation
**What goes wrong:** A timeout, malformed proposal, or stale result creates a false completed session. [VERIFIED: D-36]

**How to avoid:** Split dispatch from finalization; only finalization calls the state transition after strict event/artifact/evidence validation. Store recoverable failure evidence without incrementing the authoritative completion version. [VERIFIED: D-21, D-36]

### Pitfall 2: Idempotency key reused for different intent
**What goes wrong:** Returning the first result for any duplicate key lets a caller silently substitute an action. [VERIFIED: D-21]

**How to avoid:** Persist and compare a canonical fingerprint of principal, session, kind, expected version, policy version, and normalized payload hash. Exact match replays; mismatch returns `IDEMPOTENCY_KEY_CONFLICT`. [VERIFIED: D-20–D-21]

### Pitfall 3: “Denied network” but open authority paths remain
**What goes wrong:** A sandbox can still receive injected secret/volume/identity, exposed tunnel/port, or a broad gateway. Modal’s API exposes these options; omission and explicit tests are required. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox]

**How to avoid:** Make the adapter’s accepted configuration a strict project schema that rejects `secrets`, volumes, bucket mounts, identity-token options, proxy, i6pn, and any port arrays; run explicit no-port/no-secret/egress canary tests. [VERIFIED: D-31–D-34] [ASSUMED]

### Pitfall 4: Logging prompt/tool content as evidence
**What goes wrong:** The audit trail itself becomes a prompt/secret retention channel. [VERIFIED: D-27]

**How to avoid:** Persist stable codes, lengths, hashes, classifier signal IDs, policy version, and correlation fields by default; require a separate future retention decision for raw content. [VERIFIED: D-27]

## Code Examples

### Capability-grant check before dispatch

```ts
// Source: project decision D-28 through D-30
function authorizeTool(request: WorkerToolRequest, grant: CapabilityGrant, now: number) {
  if (grant.sessionId !== request.sessionId || grant.actionId !== request.actionId) return deny("GRANT_SCOPE_MISMATCH");
  if (grant.expectedVersion !== request.expectedVersion || grant.policyVersion !== request.policyVersion) return deny("GRANT_VERSION_MISMATCH");
  if (grant.expiresAt <= now) return deny("GRANT_EXPIRED");
  if (!grant.tools.includes(request.tool)) return deny("TOOL_NOT_ALLOWED");
  return allow(); // dispatcher still constrains path and argument schema
}
```

### Admission order

```text
raw unknown input
  -> require one string / no alternate envelope
  -> reject invalid Unicode or non-canonical encoding
  -> compute bytes, code points, approximate token count, structural flags
  -> apply versioned hard limits (no classifier dependency)
  -> compute injection/jailbreak signals and deterministic risk decision
  -> record redacted decision evidence
  -> only then create an action or invoke WorkerPort
```

This order enforces the requirement that allocation, model calls, and billable execution are unreachable from invalid input. [VERIFIED: D-24–D-27]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Network allowlists/dynamic opening as baseline | Start `blockNetwork: true`; keep gateway authority out of the worker. | Modal docs currently mark domain allowlists Beta and runtime policy mutation Alpha. | Avoid making a beta/alpha network feature a security prerequisite. [CITED: https://modal.com/docs/guide/sandbox-networking] |
| Flexible agent tool plugins | Fixed least-authority tool schema + coordinator validation | OWASP LLM06:2025 guidance | Prevent classifier/model selection from becoming authority. [CITED: https://genai.owasp.org/llmrisk/llm062025-excessive-agency/] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Bun SQLite is sufficient for the Phase-2 single-process vertical slice when hidden behind `SessionStore`. | Summary / Standard Stack | Planner must instead provision a test database earlier. |
| A2 | A default adapter policy can reject all Modal secret/volume/port/identity options in project code. | Pitfall 3 | A provider option may need an additional probe or different adapter shape. |
| A3 | A fake browser capability manifest is enough until the live image probe. | Fake vs demonstrated table | The phase may need a local pinned image fixture. |

## Open Questions (RESOLVED)

1. **Modal account/region/image selection — resolved as unselected in Phase 2.**
   - Phase 2 selects no Modal account, region, or image. `ModalWorkerAdapter` remains a reversible candidate behind `WorkerPort`; installing its exact official SDK package does not select a provider configuration. [VERIFIED: D-32, D-38]
   - The probe is autonomous and opt-in through non-secret configuration plus host credentials. Missing account/region/image configuration or credentials produces canonical machine-recorded `status: blocked` and `selection: unselected` evidence without constructing the SDK or sandbox. [VERIFIED: D-37–D-38]
   - A complete live probe may record `status: passed` and `selection: eligible-not-selected` only. It is candidate eligibility evidence, not provider selection, production certification, or five-second readiness proof. Failed or uncertain observations remain `failed` and `unselected`. [VERIFIED: D-37–D-38]

2. **Initial versioned policy/resource limits — resolved in `PHASE_02_POLICY_INITIAL`.**
   - `src/policy/phase-02-policy.ts` owns one deeply immutable named fixture with `policyVersion: phase-02-policy-2026-08-04`. Consumers import its sections and define no local or implicit numeric defaults. [VERIFIED: D-24, D-28, D-33]
   - Idea ceilings: 4,000 Unicode code points; 16 KiB (16,384 bytes) UTF-8; 4,096 graphemes; 2,000 input tokens; 64 lines; 1,000 code points per line.
   - Tool/action ceilings: 300 characters per tool path; 30,000 characters per write contents value; 16 turns per action.
   - Sandbox ceilings: 1 CPU reservation and 2 CPU hard limit; 1 GiB memory reservation and 2 GiB hard limit; 20-minute lifetime; 2-minute idle timeout; 30-second exec timeout; 1 MiB combined output ceiling.
   - Tuning any value requires a new named/versioned immutable policy fixture and corresponding boundary/evidence tests; executors never alter values through hidden fallbacks or provider config. [VERIFIED: D-24, D-28, D-33]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Bun | domain, tests, SQLite | ✓ | 1.3.14 | — |
| Node/npm | registry/package verification | ✓ | v25.2.1 / 11.6.2 | — |
| Docker | existing Phase 1 sealed runner; optional local image checks | ✓ | 28.5.2 | deterministic fake + remote Modal probe |
| git/tar/zstd | source/version records and checkpoint archive | ✓ | git 2.50.1; bsdtar 3.5.3; zstd 1.5.7 | — |
| Modal account/token + approved SDK | live candidate probe | ✗ / unconfirmed | — | deterministic fake keeps core development unblocked |
| Chromium/Playwright executable | live browser/build probe | ✗ locally | — | run within approved provider image; record actual version |

**Missing dependencies with no fallback:** none for the design-stage core. Without explicit provider configuration/credentials, the probe records `blocked`/`unselected` evidence and offline deterministic work continues. [VERIFIED: D-37–D-38]

**Missing dependencies with fallback:** Modal credentials and local Chromium—use deterministic fake for semantic contracts and defer the credential-gated provider test rather than claiming it passed. [VERIFIED: D-37–D-38]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Bun test 1.3.14 installed; 57 current tests pass. [VERIFIED: environment test run] |
| Config file | `package.json` and `tsconfig.json`; no separate test config. [VERIFIED: repository inspection] |
| Quick run command | `bun test` |
| Full suite command | `bun test && bun run test:phase-02-design-slice` (add script in Wave 0) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SESS-05 | exact replay returns recorded result; conflict/stale/concurrent action cannot double-advance version | unit + persistence integration | `bun test tests/domain/session-service.test.ts tests/persistence/session-store.test.ts` | ❌ Wave 0 |
| SAFE-01 | malformed/oversized/alternate-channel input has no allocation or worker invocation | unit/table-driven | `bun test tests/admission/admission-policy.test.ts` | ❌ Wave 0 |
| SAFE-02 | classifier signal is recorded; hard rule remains decisive and never expands a grant | unit/table-driven | `bun test tests/admission/risk-policy.test.ts` | ❌ Wave 0 |
| SAFE-03 | strict tool/grant/session/version/path/expiry denials have zero side effects | unit + contract | `bun test tests/capabilities/scoped-tool-gateway.test.ts tests/worker-port/contracts.test.ts` | ❌ Wave 0 |
| SAFE-04 | fake proves semantic isolation; Modal probe proves representative workspace/egress/gateway/browser/checkpoint controls | unit + opt-in integration | `bun test tests/worker-port/fake-worker.test.ts && bun run test:modal-probe` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `bun test` plus affected new test file(s).
- **Per wave merge:** `bun test`.
- **Provider wave:** `bun run test:modal-probe` is autonomous; explicit valid configuration may attempt an observation, while missing configuration/credentials persists structured `blocked`/`unselected` evidence without implying selection.
- **Phase gate:** `bun test && bun run test:phase-02-design-slice`; the evidence must distinguish deterministic coverage from a missing/failed live provider probe. [VERIFIED: D-37–D-38]

### Wave 0 Gaps

- [ ] `tests/admission/admission-policy.test.ts` — SAFE-01/SAFE-02 hard-limit and classifier-independence matrix.
- [ ] `tests/domain/session-service.test.ts` and `tests/persistence/session-store.test.ts` — SESS-05 replay/conflict/concurrency matrix.
- [ ] `tests/capabilities/scoped-tool-gateway.test.ts` — SAFE-03 authority, strict schema, scope, expiry, and path-denial matrix.
- [ ] `tests/worker-port/fake-worker.test.ts` and `tests/integration/modal-probe.test.ts` — SAFE-04 semantic fake plus opt-in provider evidence.
- [ ] `tests/verification/phase-02-design-slice.test.ts` and `bun run test:phase-02-design-slice` — validates immutable design evidence and Phase 7 deferrals.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | Yes | Transport adapter supplies a principal; core binds it into every action but does not implement ContextVM auth yet. [VERIFIED: D-20, D-23] |
| V3 Session Management | Yes | Opaque session/action IDs, expected version, short-lived server-validated grants, terminal-grant revocation. [VERIFIED: D-20–D-21, D-28] |
| V4 Access Control | Yes | Fixed worker tools, coordinator gateway, deny-by-default grant and workspace checks. [VERIFIED: D-28–D-34] |
| V5 Input Validation | Yes | Canonical admission, Zod strict schemas, size bounds, stable denials. [VERIFIED: D-24–D-27] [CITED: https://zod.dev/api?id=property] |
| V6 Cryptography | Yes | Platform CSPRNG IDs and SHA-256 evidence/archive hashes; do not invent encryption/signing. [VERIFIED: D-30, D-35] |

### Known Threat Patterns for the Phase-2 Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt-injected proposal requests broader authority | Elevation of Privilege | Fixed tool schema, policy-derived grant, independent gateway check, no classifier-granted permission. [VERIFIED: D-26, D-28–D-29] |
| Cross-session replay/confused deputy | Spoofing / Elevation of Privilege | Bind grant/action/version/policy/workspace, short expiry, exact idempotency fingerprint. [VERIFIED: D-20–D-21, D-28] |
| Worker egress or credential exfiltration | Information Disclosure | `blockNetwork: true`, no secrets/ports/volumes, coordinator gateway only, denial probes. [CITED: https://modal.com/docs/guide/sandbox-networking] [VERIFIED: D-31–D-34] |
| Two action writers or lost worker success | Tampering / Repudiation | Atomic version-fenced result/evidence transaction; uncertainty leaves state intact. [VERIFIED: D-21, D-30, D-36] |
| Malformed worker output promoted | Tampering | Strict schema + artifact/evidence validation before finalization. [VERIFIED: D-22, D-39] |

## Sources

### Primary (HIGH confidence)

- [Bun SQLite](https://bun.com/docs/runtime/sqlite) — built-in SQLite, strict bindings, prepared statements, and transaction behavior.
- [Modal JavaScript Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox) — concrete sandbox option surface and resource/lifetime controls.
- [Modal networking and security](https://modal.com/docs/guide/sandbox-networking) — `blockNetwork`, allowlist incompatibilities, beta/alpha feature status.
- [Zod API](https://zod.dev/api?id=property) — unknown-key behavior and strict object schemas.
- [Bun test runner](https://bun.com/docs/test) — TypeScript test runner and `bun test` command.

### Secondary (MEDIUM confidence)

- [OWASP LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) — least functionality/permission/autonomy rationale.
- npm registry and package-legitimacy seam — current package versions, publishing metadata, scripts, and the informational release-age signal retained in evidence.
- Existing Phase 1 contracts: `src/runner/sealed-toolchain.ts`, `src/evidence/bundle.ts`, and `src/policy/artifact-contract.ts` — project-established fail-closed patterns.

### Tertiary (LOW confidence)

- Assumptions A1–A3, explicitly listed above for planner confirmation.

## Metadata

**Confidence breakdown:**

- Standard stack: MEDIUM — Bun/Zod/Modal docs and registry facts were checked; the exact SDK is pinned and confined to a reversible candidate adapter, while account/region/image remain explicitly unselected and no-config execution records blocked evidence.
- Architecture: HIGH — locked Phase 2 decisions directly prescribe coordinator ownership, isolation, and transport neutrality.
- Pitfalls: MEDIUM — provider API constraints and OWASP guidance were checked; exhaustive adversarial/vendor certification is correctly deferred to Phase 7.

**Research date:** 2026-08-04
**Valid until:** 2026-08-11 for Modal/Zod package and provider details; locked project decisions remain current until changed.
