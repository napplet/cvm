# Phase 4: Metered Generation & Revision Loop - Context

**Gathered:** 2026-08-04
**Status:** Ready for research and AI specification

<domain>
## Phase Boundary

Phase 4 turns Phase 3 funded admission into a serialized, exact-usage creation loop. A funded ContextVM user can start one session from a bounded plain-text idea, receive durable progress and spend state, submit bounded text-only revisions, and receive either a newly verified napplet artifact or honest diagnostics. Every generation, revision, model operation, validation-triggered repair, receipt, debit, release, and reconciliation outcome is correlated to one account, session, action, state version, action budget, provider operation, price-card version, and immutable evidence identity.

This phase owns the metered generation loop and the transport-neutral core behind its ContextVM routes. It does not implement the ten-minute insufficient-funds live-worker window, durable 30-day resume/expiry, preview shell, user manifest signing, publication, production provider selection, five-second p95 certification, or multi-region launch proof. Phase 4 may expose the exact states and ports those later phases consume, but it must not claim their behavior.

</domain>

<decisions>
## Implementation Decisions

### Price-Versioned Authorization and Settlement

- **D-59:** Authorize every generation, revision, and repair action against an immutable disclosed sat-denominated price-card/model-profile version and a computed action ceiling. Finalization charges only receipt-derived actual usage, never the reserved maximum or the current price card.
- **D-60:** Settlement atomically consumes the actual charge from both the funded account and the session's remaining held cap, releases the unused action reservation, writes balanced immutable ledger postings and one durable result, and returns the new balance/cap projection. A hold remains authorization, not revenue.
- **D-61:** One action may contain multiple bounded model operations, but each operation receives its own server-generated operation ID and sub-reservation under the action ceiling. The sum of open and settled operations cannot exceed the action budget; the action's unused remainder is released only at a durable terminal boundary.
- **D-62:** A versioned price card fixes the allowlisted provider/model profile, supported token/usage dimensions, integer rate numerators and denominators, currency-conversion snapshot if required, rounding rule, request/output ceilings, and validity window. All arithmetic is integer/rational; no financial calculation uses IEEE-754.
- **D-63:** If an authoritative receipt would exceed the reserved ceiling or cannot be priced by the pinned card, the user is never charged beyond authorization. The action enters `billing_invariant_failed`, the model profile is blocked from new work, and reconciliation is required.

### Provider Operation and Ambiguity

- **D-64:** The only billable model path is a coordinator-owned, transport-neutral `ModelGateway`. The worker receives no provider credential, arbitrary model selector, raw price table, billing mutation method, or unrestricted model-network access.
- **D-65:** Persist the action-bound provider-operation intent before dispatch. Bind account, session, action, expected session version, action-budget reference, model profile, price-card version, request fingerprint, maximum usage, and a server operation ID before external I/O.
- **D-66:** A normalized authoritative usage receipt must bind the server operation ID and provider request ID plus provider/model identity, measured input/output/cached/reasoning or other priced units, completion status, timestamps, and receipt provenance. Provider-native payloads remain protected adapter evidence; public status exposes only safe normalized fields.
- **D-67:** A timeout, lost response, malformed receipt, or uncertain provider result becomes visible `usage_unknown` and blocks later billable actions for that session. Reconciliation queries the original operation/request when supported; the service never repeats it as a fresh billable request. A provider without reconcilable correlation remains blocked/unselected rather than receiving an exact-usage claim.
- **D-68:** A definitively zero-usage pre-dispatch failure releases the reservation. A failed model/build action with a valid nonzero receipt is charged exactly for that confirmed usage while the action remains failed. No artifact or success claim is needed to make an authoritative usage receipt billable.

### Session, Revision, and Repair Lifecycle

- **D-69:** Supported public commands are `start_session`, `revise_session`, `session_status`, and the coordinator-owned validation-triggered `repair`. Start and revision accept one bounded plain-text field only. Phase 2 canonical input/risk gates run before action-budget authorization, worker allocation, or model dispatch.
- **D-70:** One durable session has a stable ID, one account/principal owner, approved cap/hold reference, current session version, current verified artifact version, workspace-lineage/checkpoint identity, actual spend, pending/active action, and next required action. Only one action may be active; exact duplicates replay and conflicting or stale actions fail closed.
- **D-71:** Successful actions advance the durable session and verified artifact version exactly once. Failed, incomplete, blocked, and `usage_unknown` actions retain the prior verified artifact version while recording a replayable diagnostic, usage, state, and evidence outcome. Workspace continuation uses a validated session-bound snapshot/checkpoint reference, never a live worker as the sole source of truth.
- **D-72:** A validation failure may trigger at most one automatic repair action for the originating generation/revision. Repair is a distinct serialized action with its own budget authorization, provider operations, receipts, evidence, and expected version, and it must cite the failed artifact and validation report. Any further repair requires a new signed bounded revision request. The numeric default is versioned policy and can only become more restrictive without a new policy version.

### Napplet Harness, Validation, and Artifact Honesty

- **D-73:** The worker harness remains frameworkless/project-owned unless research proves a framework adds value without crossing authority boundaries. It must use the installed `@napplet/skills` make/design/build/test flows and the promoted `@napplet/cli`/boilerplate compatibility set; package text guides the worker but never replaces coordinator policy.
- **D-74:** New sessions scaffold through the promoted napplet workflow. Revisions and repairs operate only on the same session workspace lineage and approved application surfaces. The worker cannot modify billing, session authority, price policy, verification policy, publication state, package pins, or control-plane configuration.
- **D-75:** Every candidate artifact passes the existing Phase 1 server-owned artifact contract, maintained build/verification commands, forbidden-authority checks, and real-browser conformance evidence before becoming the session's verified artifact version. A failed or incomplete build returns safe diagnostics and validation evidence only; Phase 4 never labels anything previewable or publishable.

### Status, Evidence, and Design-Stage Boundary

- **D-76:** ContextVM remains the sole public v1 transport. The thin adapter exposes owner-scoped generation/session commands and status, while the generation, metering, session, and reconciliation core stays transport-neutral for later x402/L402 adapters.
- **D-77:** Session status is server-derived and includes session/action state, safe progress, approved cap, action reservations, confirmed actual spend, remaining balance/cap, price/model profile versions, reconciliation state, latest verified artifact identity, safe diagnostics/evidence references, and the next required action. It excludes prompts, chain-of-thought, generated source, provider credentials, bearer material, and raw provider payloads.
- **D-78:** Phase 4 design proof uses a deterministic `ModelGateway`, authoritative receipt fixtures, failure injection, and provider-separated evidence. A live provider/proxy is only `eligible-not-selected` if it proves request correlation, exact normalized usage, pinned pricing compatibility, and post-timeout lookup; production selection and SLO/chaos certification remain Phase 7.

### the agent's Discretion

- Choose exact state/error names, SQL schema layout, operation/line-item identifiers, and status pagination while preserving the decisions above.
- Choose conservative initial action/model ceilings and the exact integer price-card representation, provided ceilings and rounding are versioned and disclosed.
- Choose the smallest frameworkless harness and deterministic provider fake that proves the complete loop.
- Choose safe diagnostic summaries and evidence structure; raw user text, chain-of-thought, generated source, credentials, and provider-native receipts remain outside ordinary status/logs.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Phase Scope

- `.planning/PROJECT.md` — Active v1.0 milestone, bounded napplet boundary, ContextVM-only v1 surface, cap/no-queue constraints, and later-phase exclusions.
- `.planning/REQUIREMENTS.md` — Phase 4 requirements `BILL-03`–`BILL-05`, `SESS-01`, `SESS-03`–`SESS-04`, and `GEN-05`–`GEN-06`.
- `.planning/ROADMAP.md` — Phase 4 goal, success criteria, dependency position, and provider-receipt validation gate.
- `.planning/research/ARCHITECTURE.md`, `FEATURES.md`, `PITFALLS.md`, and `SUMMARY.md` — Metering proxy, reserve/finalize, exact usage, revision, repair, and ambiguity recommendations.

### Established Executable Contracts

- `.planning/phases/02-trusted-core-isolated-agent-execution/02-CONTEXT.md` — D-20–D-39 trusted authority, action serialization, worker, checkpoint, and artifact boundaries.
- `.planning/phases/02-trusted-core-isolated-agent-execution/02-AI-SPEC.md` — Frameworkless `WorkerPort`/`ModelGateway` recommendation and bounded model profile/evaluation guidance.
- `.planning/phases/02-trusted-core-isolated-agent-execution/02-VERIFICATION.md` — Verified session replay, lease, effect-intent, artifact-verification, and provider-separation behavior.
- `.planning/phases/03-contextvm-funding-funded-admission/03-CONTEXT.md` — D-40–D-58 identity, ledger, funded admission, action-budget, and ambiguity contracts.
- `.planning/phases/03-contextvm-funding-funded-admission/03-VERIFICATION.md` — Verified funded authority and explicit Phase 4 handoff.
- `.planning/phases/03-contextvm-funding-funded-admission/03-SECURITY.md` — Financial boundary and two non-blocking evidence-correlation deferrals Phase 4 must not worsen.
- `src/phase-02/trusted-core.ts`, `src/domain/session-action.ts`, and `src/persistence/sqlite-session-store.ts` — Existing trusted execution and single-writer session seams.
- `src/funding/funded-admission.ts`, `src/persistence/funding-store.ts`, and `src/persistence/postgres-sql-funding-store.ts` — Existing cap/action reservations and serializable monetary authority.
- `src/policy/artifact-contract.ts` and `src/verification/` — Existing napplet-only artifact and immutable evidence contracts.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `TrustedCore` already orders replay, input/risk admission, worker lease, typed worker parsing, server-owned artifact verification, mediated tools, and one durable session commit.
- `SessionStore` implementations already prove request/action fingerprints, exact replay, expected-version fencing, worker leases, and intent-before-effect semantics.
- `FundedAdmissionService.authorizeActionBudget` already creates an account/admission-scoped action reservation beneath the approved cap; Phase 4 must extend it into operation reservations and finalization rather than bypass it.
- `PostgresSqlFundingStore` already provides bounded serializable transactions, balanced credit/hold primitives, and durable capacity/action records.
- Phase 1 artifact verification and Phase 2 provider-separated evidence are authoritative reusable gates.

### Required Extensions

- Add a durable action lifecycle that records failed/unknown outcomes without falsely advancing the verified artifact version.
- Add price-card/model-profile, provider-operation, normalized usage-receipt, debit/release/reconciliation, and immutable line-item authority to the PostgreSQL composition.
- Compose session/action and financial finalization so one exact receipt cannot debit without the matching action, nor advance an artifact without a settled action result.
- Add thin ContextVM session/generation routes without introducing ContextVM types into the core.

### Integration Constraints

- The worker remains financially powerless and cannot select price/model/provider or finalize usage.
- External provider intent must be durable before I/O, and an ambiguous operation blocks the session rather than being blindly retried.
- Revisions preserve workspace lineage and prior immutable artifacts/evidence.
- No durable request queue, preview/publication authority, automatic post-grace resume, or live-provider certification enters Phase 4.

</code_context>

<specifics>
## Specific Ideas

- The user experience stays fluid: exact duplicates quietly replay, current spend and next action remain visible, and provider ambiguity becomes a clear state instead of a billing ceremony.
- One bounded automatic repair gives the generation loop a real chance to recover without allowing the agent to consume the entire cap through an unbounded self-directed loop.
- Napplet packages remain authoritative for NIP-5D behavior; when the contract changes, update the trusted package compatibility set instead of reimplementing the protocol locally.

</specifics>

<deferred>
## Deferred Ideas

- Phase 5: `needs_top_up`, ten-minute live-worker waiting, durable checkpoint retention, explicit resume, and 30-day expiry.
- Phase 6: compatible preview, capability consent, user-owned manifest signing, deployment, and CVM attestation.
- Phase 7: live model/provider/proxy promotion, production load/SLO, multi-region/chaos evidence, exhaustive hostile testing, and launch certification.
- v2: public x402 and L402 adapters and richer input types.

</deferred>

---

*Phase: 4-Metered Generation & Revision Loop*
*Context gathered: 2026-08-04*
