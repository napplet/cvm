---
phase: 02-trusted-core-isolated-agent-execution
verified: 2026-08-04T15:09:15Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 5/5
  gaps_closed:
    - "Pre-effect principal/session fencing now denies cross-principal worker and gateway effects."
    - "Completed worker results are ordered and limited to the policy turn ceiling."
    - "Completion requires a correlated, pass-only worker artifact before the Phase 1 output gate."
    - "Checkpoint archive, inventory, evidence, and checkpoint event bindings are validated before effects."
    - "The Modal candidate receives the canonical request through a coordinator-owned one-time file."
    - "Each design-evidence check is bound to its own source/test paths and the immutable provider record."
    - "A durable SQLite worker lease permits only one independently composed core to allocate worker or gateway effects for a session/version."
    - "Only a coordinator-side artifact verifier can provide content-addressed accepted-artifact identity; unverified worker assertions fail closed."
    - "An expired lease holder is fenced by its opaque token before verifier, gateway dispatch, and final durable commit; only a reclaimed successor may proceed."
    - "A trusted dispatcher recipient must atomically accept the opaque lease fence together with its synchronous effect, so a successor cannot replace a lease between a pre-check and acceptance."
    - "A durable per-call effect intent reserves one recipient operation; an ambiguous post-effect outcome remains uncertain and exact retries or successors cannot dispatch it again."
    - "Only the transaction that creates a durable effect intent may dispatch; an existing claimed intent is converted to uncertain before an exact retry can reach the recipient."
    - "Effect intents are bound to the opaque worker-lease attempt token, so a replacement attempt cannot reuse a completed or claimed operation from an expired owner."
  gaps_remaining: []
  regressions: []
---

# Phase 2: Trusted Core & Isolated Agent Execution Verification Report

**Phase Goal:** Untrusted text and agent activity are contained by a transport-neutral authority that serializes valid actions and never grants the worker control over money, session authority, or publication.

**Verified:** 2026-08-04T15:09:15Z

**Status:** passed

**Re-verification:** Yes — after the review remediation was extended through `fe54d02` to bind durable effect intents to their opaque execution-attempt token; the fix record remains `02-REVIEW-FIX.md`.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Text beyond configured character, token, encoding, or structural limits is rejected before billable execution or worker allocation. | ✓ VERIFIED | `evaluateAdmission` performs strict envelope/Unicode/NFC/byte/code-point/grapheme/token/line/structure checks before `TrustedCore` reaches risk, store, worker, gateway, artifact, or dispatcher paths. The tracer's hard-admission test proves zero worker/gateway effects and version `0`; admission boundary tests cover all limits and malformed input. |
| 2 | Prompt-injection and jailbreak signals are recorded without allowing classifier output to expand the deterministic policy. | ✓ VERIFIED | `evaluateRisk` runs after successful hard admission, canonically records signals, rejects configured signals and detector faults, and preserves only a subset of the fixed base grant. `tests/admission/risk-policy.test.ts` exercises clean, adversarial, duplicate/reordered, throw, unavailable, malformed, and timeout paths. |
| 3 | A worker has only typed, allowlisted, current-session tools and cannot alter billing, session authority, publish intent, or system policy. | ✓ VERIFIED | The sole WorkerPort schema authority is `src/phase-02/contracts.ts`; its closed `ToolRequestSchema` includes only workspace operations, approved commands, evidence capture, and checkpoint export. Completed worker events must be non-empty, strictly increasing, and within the fixed 16-turn ceiling before any dispatch. A coordinator-side `ArtifactVerifier` must return validated content-addressed artifact/report identities before the gateway runs; worker-supplied all-pass assertions alone fail closed. `ScopedToolGateway` binds requests to grant/session/action/version/policy/workspace data, durably claims an intent, and provides its opaque operation ID only to the trusted dispatcher recipient — never to the worker. |
| 4 | Worker boundaries prevent sibling-session/control-plane authority and use default-deny egress except through scoped gateways. | ✓ VERIFIED (design-stage contract) | The trusted core obtains a durable, expiring SQLite worker lease with an opaque token for the exact session/version before issuing a grant or allocating a worker. Before dispatch, `ScopedToolGateway` records an exact request/call intent under that token; only the transaction which receives `created` may call the recipient. The worker never receives the attempt token or resulting operation ID, while the trusted recipient does. A matching pre-existing `claimed` intent in the same attempt is atomically changed to durable `uncertain`, never redispatched; a row from any other attempt is blocked outright. Completed, uncertain, or conflicting state likewise fails closed. Cross-principal, independent-core, expiry/reclaim, replacement, forged-marker, effect-then-throw, exact-retry-after-expiry, and fresh-call-after-stale-commit tracer cases prove no unauthorized, stale-owner, or retried effect. `DeterministicFakeWorker` provides per-workspace isolation, no ambient credential/network surface, cancellation fencing, gateway-only effects, and checkpoint/event/archive bindings. `ModalWorkerAdapter` remains a separate default-deny candidate with a coordinator-owned request file. The design slice preserves `blocked:unselected`, never a provider selection/certification claim. |
| 5 | Duplicate or simultaneous actions produce one durable valid next state/artifact version rather than competing mutations. | ✓ VERIFIED | Replay lookup precedes work; the SQLite `worker_leases` primary key serializes allocation across independently composed cores, and a unique `(session, version, call)` effect intent is bound to the opaque attempt token. Multiple completed calls in one unchanged attempt remain valid, but a replacement attempt cannot reuse or add to a prior attempt's completed/claimed/uncertain intent state. Thus an expired final commit after an effect leaves both session version and artifact unpublished, while an exact retry—even with a fresh call ID—is blocked rather than dispatching twice. `SessionStore.apply` still repeats the ownership/version/token fence in its final transaction and atomically commits version, result, evidence, and accepted artifact identity. Close/reopen replay, competing-key, exact-duplicate, rollback, and `P02-R11`/`P02-R12` retain coverage. |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/policy/phase-02-policy.ts` | Immutable, versioned limits | ✓ VERIFIED | Deep-frozen `phase-02-policy-2026-08-04` fixture supplies text, tool, action, and sandbox ceilings. |
| `src/admission/admission-policy.ts` and `src/admission/risk-policy.ts` | Pre-allocation admission and restrictive-only risk boundary | ✓ VERIFIED | Substantive canonical text measurement, stable denials/redacted evidence, and bounded detector evaluation; exercised by focused tests. |
| `src/phase-02/contracts.ts` | Transport-neutral action/worker/tool schemas | ✓ VERIFIED | Strict Zod schemas, closed tool union, ordered/ceiling-bounded completed events, correlated pass-only worker artifact, and the only `WorkerPort` declaration; the authoritative-source test rejects a duplicate contract module. |
| `src/persistence/session-store.ts` and `src/persistence/sqlite-session-store.ts` | Replay-safe, principal-scoped, version-fenced state authority | ✓ VERIFIED | Test double is explicit-only; durable SQLite holds an expiring `(session_id, expected_version)` worker lease with opaque `lease_token` and a durable `effect_intents` record keyed by session/version/call plus `attempt_token`. Claim validates the active lease and returns `created` only to the insert transaction; matching claimed state in that attempt becomes `uncertain`, while any other attempt's row is blocked. Completion marks only the still-claimed operation; stale/replaced/expired owners cannot claim or final-commit. Close/reopen and rollback tests pass. |
| `src/capabilities/scoped-tool-gateway.ts` and `src/worker-port/fake-worker.ts` | Coordinator mediation and deterministic isolation harness | ✓ VERIFIED | Grant-bound validation precedes every effect; the gateway persists a request-fingerprinted, attempt-bound intent before dispatch, gives operation identity only to the trusted recipient, and dispatches only a `created` intent. It replays completed state without dispatch and fails closed for existing claimed/uncertain/conflicting or cross-attempt intent state. Fake-worker tests cover workspace, credential/network absence, interruption, turn limits, adjacent-session isolation, and checkpoint event/evidence/archive/inventory binding. |
| `src/worker-adapters/modal-worker.ts` and `scripts/probe-modal-worker.ts` | Replaceable, default-deny provider candidate and honest evidence | ✓ VERIFIED (candidate only) | Configuration is strict; the adapter validates and delivers a parsed request through a one-time coordinator-owned workspace file, then parses the correlated result and terminates on every outcome. Missing config/credentials write content-addressed blocked/unselected evidence. |
| `src/phase-02/trusted-core.ts` | Ordered final composition | ✓ VERIFIED | Explicit SQLite path is mandatory; replay and durable token-bound lease precede allocation. The core wires the gateway's created-versus-existing, attempt-bound effect-intent authority to the store, withholding both lease/attempt and operation identities from the worker; it then reasserts ownership before artifact verification and before the final `SessionService` commit. A coordinator-provided, validated artifact/report identity plus the Phase 1 output gate runs before effects or commit. The default verifier fails closed. |
| `tests/fixtures/phase-02-reference-set.json` and `src/verification/phase-02-design-evidence.ts` | Deterministic reference matrix and immutable design proof | ✓ VERIFIED | Exactly 16 executable cases plus content-addressed design evidence. `9a396d1` binds every named check to its scoped source/test paths, records aggregate full-suite/reference-eval digests separately, and validates the immutable provider record addressed by the mutable pointer. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `TrustedCore` | admission/risk policies | Admission → risk → state/worker ordering | ✓ WIRED | `TrustedCore.#executeBounded` returns on hard admission or risk denial before store/version, worker, gateway, artifact, or commit work; tracer tests prove the no-effect paths. |
| `TrustedCore` | `SessionStore` / `SessionService` | replay-before-effect, attempt-token-bound durable effect-intent authority, and final atomic apply | ✓ WIRED | `findRecordedResult` precedes all later boundaries; `claimWorkerLease` atomically admits only one session/version across SQLite store instances before a grant/worker/gateway effect. `ScopedToolGateway` calls `claimEffectIntent` with the exact lease/attempt token and request fingerprint, dispatches only `created`, passes its operation ID only in the trusted dispatcher context, calls `completeEffectIntent` only after a response, and persists `uncertain` on error or a matching claimed retry. Cross-attempt intent state cannot reach dispatch. Exact-token assertion still fences after worker completion and before finalization; exact-token release runs in `finally`; `SessionService.apply` forwards it into the final transaction. |
| `TrustedCore` / worker adapters | canonical contracts | strict parse on both WorkerPort sides | ✓ WIRED | Core parses action/request/result/events; fake and Modal adapters import and parse the same canonical schemas. |
| `TrustedCore` | `ArtifactVerifier` and Phase 1 artifact contract | trusted artifact verification before gateway/commit | ✓ WIRED | The worker proposal is only an input to the coordinator-side verifier. Without a verifier result containing valid content-addressed artifact/scanner/conformance identities, the core returns `ARTIFACT_CONTRACT_BLOCKED` before any effect. A verified contract input then passes through `evaluateArtifactContract` before the session action; committed evidence carries the accepted artifact identity. |
| Modal probe | provider/design evidence | immutable blocked/failed/passed observation separated from offline readiness | ✓ WIRED | The probe validates a hash-bound checkpoint manifest/inventory, writes a content-addressed provider record, and the design slice re-hashes that immutable record before embedding it. The validator rejects selection/certification overclaims. |

The generic plan-link checker could not find two stale lexical patterns: it expects the literal `Schema.(safeParse|parse)` string in `TrustedCore` and a direct admission-test import of `AdmissionDecision` from the contracts module. The actual code parses the named canonical schemas (`ActionEnvelopeSchema`, `WorkerRunRequestSchema`, `WorkerRunResultSchema`, `WorkerEventSchema`) and keeps `AdmissionDecision` correctly owned by the admission module. Runtime wiring and tests above establish the intended links; neither lexical miss is a product gap.

### Data-Flow Trace (Level 4)

Not applicable: Phase 2 has no UI/dynamic rendering artifact. Its relevant flow is the authority path traced above: untrusted envelope → admission/risk → serialized authority → typed WorkerPort → scoped gateway → Phase 1 gate → one SQLite commit.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Rebuilt Phase 2 design slice | `bun run test:phase-02-design-slice` | exit 0; 189 full-suite tests and 33 reference-oracle tests pass; evidence is `design-ready` with Modal `blocked`/`unselected` | ✓ PASS |
| Full runnable trusted-core and prior-regression suite | invoked by the design-slice command as `bun test` | 189 pass, 0 fail, 800 expectations | ✓ PASS |
| Sixteen security/state transition oracles | invoked by the design-slice command as `bun run eval:phase-02` | 33 pass, 0 fail, including replay, competing actions, cross-principal/cross-instance, expiry/reclaim, created-only attempt-token-bound intents, stale-final-commit fresh-call blocking, and ambiguous/exact-retry fencing, untrusted artifact rejection, malformed/over-limit worker output, checkpoint binding, and provider-boundary cases | ✓ PASS |

### Probe Execution

| Probe | Command | Result | Status |
| --- | --- | --- | --- |
| `scripts/verify-phase-02-design-slice.ts` | `bun run test:phase-02-design-slice` | exit 0; validates scoped check identities, immutable provider record, and outputs `design-ready` with Modal `blocked`/`unselected` | PASS |
| `scripts/probe-modal-worker.ts` | existing offline observation revalidated by the design slice | immutable observation remains `blocked` / `unselected` / `PROVIDER_UNSELECTED` | PASS |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| --- | --- | --- | --- |
| SESS-05 | 01, 03, 06 | Duplicate/concurrent actions serialize to one valid next mutation. | ✓ SATISFIED | Per-session core tail, replay-before-effect lookup, SQLite transaction/version fence, and close/reopen plus concurrent tests. |
| SAFE-01 | 01, 02, 06 | Reject over-limit/malformed input before allocation. | ✓ SATISFIED | Canonical admission checks and zero-effect tracer/boundary coverage. |
| SAFE-02 | 01, 02, 06 | Record injection/jailbreak signals without classifier authority. | ✓ SATISFIED | Restrictive-only risk decision, canonical evidence, and classifier-fault denials. |
| SAFE-03 | 01, 04, 06 | Allow only typed current-session tools; exclude durable authority. | ✓ SATISFIED | Closed schema, coordinator grant, complete mediation, and zero-effect denial matrix. |
| SAFE-04 | 01, 04, 05, 06 | Isolate workers and default-deny egress through scoped gateways. | ✓ SATISFIED (design-stage) | Deterministic isolation harness plus strict, unselected Modal candidate and honest blocked probe evidence. |

All five Phase 2 requirements appear in plan frontmatter; none is orphaned.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- |
| `scripts/probe-modal-worker.ts` | 43 | `console.log` | ℹ️ Info | Intended CLI status output, not a stub or authority path. |
| `scripts/verify-phase-02-design-slice.ts` | 56 | `console.log` | ℹ️ Info | Intended machine-readable verification output, not a stub or authority path. |

No `TBD`, `FIXME`, `XXX`, placeholder implementation, empty authority handler, or unreferenced Phase 2 debt marker was found in Phase 2 implementation files.

### Design-Stage Boundaries Preserved

- The Modal observation is deliberately `blocked` and `unselected`; no provider was selected, certified, or claimed to meet the readiness SLO.
- The Phase 1 native scaffold/Chromium limitation remains explicit blocked design evidence. It is not relabeled as a successful native artifact.
- Production provider certification, hostile-depth work, load/SLO proof, chaos/regional recovery, supply-chain promotion, and launch hardening remain Phase 7 responsibilities.

These are explicit later-phase validation gates, not missing Phase 2 trusted-core behavior.

### Completion Metadata Note

At verification time, source/artifact discovery reports Phase 2 as complete on disk (6 plans and 6 summaries), while the roadmap/requirements/state roll-ups still describe it as pending or ready to execute. That is completion-metadata drift for the orchestrator's phase-completion commit, not an implementation or requirement gap.

---

_Verified: 2026-08-04T15:09:15Z_

_Verifier: the agent (gsd-verifier)_
