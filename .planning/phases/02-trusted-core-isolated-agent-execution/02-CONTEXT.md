# Phase 2: Trusted Core & Isolated Agent Execution - Context

**Gathered:** 2026-08-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 creates the transport-neutral authority and isolated worker contract used by all later generation sessions. It validates bounded text before billable work, serializes authoritative state changes, gives an untrusted agent only typed session-scoped capabilities, and proves the worker cannot directly control money, session authority, publication, credentials, or unrestricted network access.

This is a design-stage vertical slice. It must establish executable fail-closed boundaries and representative isolation evidence, while exhaustive hostile campaigns, vendor production certification, and launch-grade operational proof remain Phase 7 work. The worker platform stays behind a portable interface; Modal is the first deployment candidate, not part of the domain contract.

This phase does not implement the prepaid ledger, CEP-8, the full generation loop, the ten-minute top-up window, durable 30-day resume, ContextVM protocol handling, user signing, or production publication. It may define the typed seams those phases consume.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope and Requirements

- `.planning/PROJECT.md` — Product boundary, transport neutrality, security model, continuity, and design-stage validation posture.
- `.planning/REQUIREMENTS.md` — Phase 2 requirements `SESS-05` and `SAFE-01` through `SAFE-04`.
- `.planning/ROADMAP.md` — Phase 2 goal, success criteria, dependency position, and worker-selection validation gate.
- `.planning/research/ARCHITECTURE.md` — Recommended trusted-core, worker-plane, lease, gateway, and evidence boundaries.
- `.planning/research/STACK.md` — Candidate worker platform and runtime recommendations; treat current vendor/package versions as research inputs to re-verify.

### Established Executable Contracts

- `src/policy/artifact-contract.ts` — Existing pure, fail-closed policy-evaluation pattern.
- `src/runner/sealed-toolchain.ts` — Existing sealed execution, environment scrubbing, and denial-probe pattern.
- `src/evidence/bundle.ts` — Existing evidence validation and canonical record pattern.
- `.planning/phases/01-napplet-contract-artifact-verification/01-VERIFICATION.md` — Phase 1 design-stage proof boundary and accepted native-toolchain deferral.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/policy/artifact-contract.ts` already demonstrates deterministic policy evaluation separated from execution.
- `src/runner/sealed-toolchain.ts` already provides strict policy parsing, scrubbed process execution, network denial, workspace mounting, and explicit denial evidence.
- `src/evidence/bundle.ts` and Phase 1 verification code establish canonical, machine-readable evidence and fail-closed validation conventions.
- Phase 1 fixtures provide conformant/hostile artifacts for representative worker outputs without requiring Phase 2 to recreate napplet conformance.

### Established Patterns

- Parse and validate untrusted data into narrow internal types before acting.
- Bind policy/candidate identity into evidence and reject mismatches rather than inferring intent.
- Represent blocked or deferred checks explicitly; absence is not success.
- Keep package-native napplet verification authoritative below NIP-5D and compose it through thin CVM-owned boundaries.

### Integration Points

- The new trusted core should return typed actions/results that Phase 3 billing can transact around and Phase 6 ContextVM can transport without either layer owning policy semantics.
- `WorkerPort` should accept only a coordinator-issued session specification and return correlated events, evidence, and checkpoints.
- Generated workspace output must flow into the Phase 1 artifact contract before it can become a preview or publication candidate.

</code_context>

<specifics>
## Specific Ideas

- The CVM is the authority; the agent is an untrusted proposal engine inside a disposable workspace.
- Injection detection is useful observability and a conservative reject signal, never a source of new permissions.
- Duplicate Nostr delivery and concurrent agent activity are normal operating conditions, so idempotency and version fencing are domain behavior rather than transport patches.
- Provider adapters should make isolation evidence observable enough to compare Modal with a future alternative without rewriting session logic.

</specifics>

<deferred>
## Deferred Ideas

- Phase 3: prepaid ledger, reservations, exact usage debits, CEP-8 top-ups, and financial transaction coupling.
- Phase 4: iterative generation/revision loop, preview UX, and full napplet authoring harness behavior.
- Phase 5: live ten-minute insufficient-balance pause, durable checkpoints, 30-day retention, explicit resume, lease recovery, and expiry.
- Phase 6: ContextVM/Nostr adapter, signed principal mapping, protocol replay behavior, and user-owned signing/publication flow.
- Phase 7: exhaustive hostile testing, production Modal or replacement certification, measured p95 readiness, chaos/regional testing, formal launch security evidence, and full supply-chain hardening.

</deferred>

---

*Phase: 2-Trusted Core & Isolated Agent Execution*
*Context gathered: 2026-08-04*
