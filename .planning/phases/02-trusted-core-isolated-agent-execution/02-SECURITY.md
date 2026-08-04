---
phase: 02-trusted-core-isolated-agent-execution
audited: 2026-08-04T15:09:39Z
status: secured
asvs_level: 1
block_on: high
threats_closed: 22/24
threats_open_blocking: 0
threats_open_non_blocking: 2
reviewed_through: fe54d02
---

# Phase 02 Security Audit

## Verdict

**SECURED** — every high-severity Phase 2 threat is mitigated at the design-stage boundary. Two medium evidence-completeness items remain explicit and non-blocking; launch certification and exhaustive hostile, load, chaos, and supply-chain validation remain Phase 7 work.

## Threat Verification

| Threat | Severity | Status | Implemented evidence |
|---|---:|---|---|
| T-02-01 | high | Closed | Strict WorkerPort contracts, coordinator grants, pre-effect ownership checks, durable worker leases, and gateway mediation. |
| T-02-02 | high | Closed | Canonical request/action fingerprints, replay lookup, version fences, and transactional state. |
| T-02-03 | medium | Open — non-blocking | Durable session evidence indirectly binds principal/policy through the fingerprint, but does not yet carry direct principal, policy, and capability-grant fields. |
| T-02-01-SC | high | Closed | Exact `zod@4.4.3` dependency and lock integrity. |
| T-02-04 | high | Closed | Bounded admission and detector execution precede allocation and effects. |
| T-02-05 | high | Closed | Classifier/risk output is restrictive-only and cannot expand grants. |
| T-02-06 | medium | Closed | Admission and risk evidence stores hashes, counts, rule IDs, and safe summaries rather than raw input. |
| T-02-07 | high | Closed | Transactional session/version leases and durable effect intents provide at-most-once dispatch. Intents bind to the originating lease token; replacement attempts cannot reuse an old call or create a fresh call after any prior intent. |
| T-02-08 | high | Closed | Exact principal/session/version checks occur during lease claim and final commit. |
| T-02-09 | medium | Closed | Immutable result and evidence identities are persisted and replayed. |
| T-02-10 | medium | Closed | SQLite busy handling and write serialization are bounded. |
| T-02-11 | high | Closed | Closed tool union, server-owned grants, authorize-before-dispatch, and coordinator-owned effect-intent claims. |
| T-02-12 | high | Closed | Exact session, action, version, policy, workspace, and grant correlation. |
| T-02-13 | high | Closed | The deterministic worker surface exposes no host environment, credentials, network client, or cross-workspace authority. |
| T-02-14 | high | Closed | Checkpoint archive, inventory, export event, checkpoint event, and evidence hashes are cross-bound. |
| T-02-15 | high | Closed | Modal candidate configuration is strict, default-deny network, and excludes secret, mount, port, and proxy authority. |
| T-02-16 | high | Closed | Provider configuration is policy-owned and the worker receives only the bounded canonical request. |
| T-02-17 | high | Closed | Provider probe validates exact hash-bound inventory and checkpoint evidence. |
| T-02-18 | medium | Open — non-blocking | Provider evidence does not yet durably bind SDK version, complete config/resource ceilings, and termination outcome. |
| T-02-05-SC | high | Closed | Exact `modal@0.9.0` dependency and lock integrity; import remains adapter-confined. |
| T-02-19 | high | Closed | Coordinator-owned artifact verification is mandatory and fail-closed; accepted artifact and report digests enter durable action identity and evidence. |
| T-02-20 | high | Closed | The design verifier locates, re-hashes, and validates the immutable provider record rather than trusting its pointer. |
| T-02-21 | medium | Closed | Deterministic requirement/decision mappings and provider-separated evidence are present. |
| T-02-22 | high | Closed | Recursive evidence validation rejects prompts, secrets, tokens, grants, and generated source. |

## Concurrency and Effect Integrity

The review/fix loop closed CR-01 through CR-09. The final authority path has these properties:

- A SQLite `(session, expected_version)` lease admits one worker attempt and assigns an opaque token.
- The gateway persists an effect intent before external dispatch and dispatches only when that transaction created the intent.
- Claimed or ambiguous intents become/remain `uncertain`; exact retries do not redispatch.
- Every intent is bound to its originating lease token. A replacement attempt is denied by any prior claimed, completed, or uncertain intent for that action/version, regardless of worker-selected call ID.
- Multiple tool calls remain valid only within the same live attempt.
- Artifact verification is coordinator-owned and content-addressed; worker assertions alone cannot authorize effects or commit.

Focused regressions cover cross-principal access, two-core contention, lease expiry/reclaim, forged acceptance, effect-then-throw, claimed-intent reclaim, stale-final-commit fresh-call replay, same-attempt multi-tool behavior, and fail-closed legacy rows.

## Validation

- `bun test` — 189 pass, 0 fail.
- `bun run eval:phase-02` — 33 pass across 16 deterministic reference cases.
- `bun run test:phase-02-design-slice` — design-ready; Modal remains `blocked` / `unselected`.
- Code review — clean through `fe54d02`.
- Nyquist validation — compliant; no gaps.

## Explicit Deferrals

- T-02-03 and T-02-18 remain medium, non-blocking evidence-completeness work.
- Modal is a candidate only; no provider selection, production certification, or readiness-SLO claim is made.
- Native scaffold/Chromium closure and exhaustive hostile, chaos, load, regional, supply-chain, and launch evidence remain Phase 7 gates.

**Blocking threats open:** 0

