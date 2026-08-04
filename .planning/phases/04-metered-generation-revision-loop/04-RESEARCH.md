# Phase 04: Metered Generation & Revision Loop - Research

**Researched:** 2026-08-04  
**Domain:** Exact-usage model metering, serialized napplet-generation sessions, and provider-ambiguity reconciliation  
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-59:** Authorize every generation, revision, and repair action against an immutable disclosed sat-denominated price-card/model-profile version and a computed action ceiling. Finalization charges only receipt-derived actual usage, never the reserved maximum or the current price card.
- **D-60:** Settlement atomically consumes the actual charge from both the funded account and the session's remaining held cap, releases the unused action reservation, writes balanced immutable ledger postings and one durable result, and returns the new balance/cap projection. A hold remains authorization, not revenue.
- **D-61:** One action may contain multiple bounded model operations, but each operation receives its own server-generated operation ID and sub-reservation under the action ceiling. The sum of open and settled operations cannot exceed the action budget; the action's unused remainder is released only at a durable terminal boundary.
- **D-62:** A versioned price card fixes the allowlisted provider/model profile, supported token/usage dimensions, integer rate numerators and denominators, currency-conversion snapshot if required, rounding rule, request/output ceilings, and validity window. All arithmetic is integer/rational; no financial calculation uses IEEE-754.
- **D-63:** If an authoritative receipt would exceed the reserved ceiling or cannot be priced by the pinned card, the user is never charged beyond authorization. The action enters `billing_invariant_failed`, the model profile is blocked from new work, and reconciliation is required.
- **D-64:** The only billable model path is a coordinator-owned, transport-neutral `ModelGateway`. The worker receives no provider credential, arbitrary model selector, raw price table, billing mutation method, or unrestricted model-network access.
- **D-65:** Persist the action-bound provider-operation intent before dispatch. Bind account, session, action, expected session version, action-budget reference, model profile, price-card version, request fingerprint, maximum usage, and a server operation ID before external I/O.
- **D-66:** A normalized authoritative usage receipt must bind the server operation ID and provider request ID plus provider/model identity, measured input/output/cached/reasoning or other priced units, completion status, timestamps, and receipt provenance. Provider-native payloads remain protected adapter evidence; public status exposes only safe normalized fields.
- **D-67:** A timeout, lost response, malformed receipt, or uncertain provider result becomes visible `usage_unknown` and blocks later billable actions for that session. Reconciliation queries the original operation/request when supported; the service never repeats it as a fresh billable request. A provider without reconcilable correlation remains blocked/unselected rather than receiving an exact-usage claim.
- **D-68:** A definitively zero-usage pre-dispatch failure releases the reservation. A failed model/build action with a valid nonzero receipt is charged exactly for that confirmed usage while the action remains failed. No artifact or success claim is needed to make an authoritative usage receipt billable.
- **D-69:** Supported public commands are `start_session`, `revise_session`, `session_status`, and the coordinator-owned validation-triggered `repair`. Start and revision accept one bounded plain-text field only. Phase 2 canonical input/risk gates run before action-budget authorization, worker allocation, or model dispatch.
- **D-70:** One durable session has a stable ID, one account/principal owner, approved cap/hold reference, current session version, current verified artifact version, workspace-lineage/checkpoint identity, actual spend, pending/active action, and next required action. Only one action may be active; exact duplicates replay and conflicting or stale actions fail closed.
- **D-71:** Successful actions advance the durable session and verified artifact version exactly once. Failed, incomplete, blocked, and `usage_unknown` actions retain the prior verified artifact version while recording a replayable diagnostic, usage, state, and evidence outcome. Workspace continuation uses a validated session-bound snapshot/checkpoint reference, never a live worker as the sole source of truth.
- **D-72:** A validation failure may trigger at most one automatic repair action for the originating generation/revision. Repair is a distinct serialized action with its own budget authorization, provider operations, receipts, evidence, and expected version, and it must cite the failed artifact and validation report. Any further repair requires a new signed bounded revision request. The numeric default is versioned policy and can only become more restrictive without a new policy version.
- **D-73:** The worker harness remains frameworkless/project-owned unless research proves a framework adds value without crossing authority boundaries. It must use the installed `@napplet/skills` make/design/build/test flows and the promoted `@napplet/cli`/boilerplate compatibility set; package text guides the worker but never replaces coordinator policy.
- **D-74:** New sessions scaffold through the promoted napplet workflow. Revisions and repairs operate only on the same session workspace lineage and approved application surfaces. The worker cannot modify billing, session authority, price policy, verification policy, publication state, package pins, or control-plane configuration.
- **D-75:** Every candidate artifact passes the existing Phase 1 server-owned artifact contract, maintained build/verification commands, forbidden-authority checks, and real-browser conformance evidence before becoming the session's verified artifact version. A failed or incomplete build returns safe diagnostics and validation evidence only; Phase 4 never labels anything previewable or publishable.
- **D-76:** ContextVM remains the sole public v1 transport. The thin adapter exposes owner-scoped generation/session commands and status, while the generation, metering, session, and reconciliation core stays transport-neutral for later x402/L402 adapters.
- **D-77:** Session status is server-derived and includes session/action state, safe progress, approved cap, action reservations, confirmed actual spend, remaining balance/cap, price/model profile versions, reconciliation state, latest verified artifact identity, safe diagnostics/evidence references, and the next required action. It excludes prompts, chain-of-thought, generated source, provider credentials, bearer material, and raw provider payloads.
- **D-78:** Phase 4 design proof uses a deterministic `ModelGateway`, authoritative receipt fixtures, failure injection, and provider-separated evidence. A live provider/proxy is only `eligible-not-selected` if it proves request correlation, exact normalized usage, pinned pricing compatibility, and post-timeout lookup; production selection and SLO/chaos certification remain Phase 7.

### the agent's Discretion

- Choose exact state/error names, SQL schema layout, operation/line-item identifiers, and status pagination while preserving the decisions above.
- Choose conservative initial action/model ceilings and the exact integer price-card representation, provided ceilings and rounding are versioned and disclosed.
- Choose the smallest frameworkless harness and deterministic provider fake that proves the complete loop.
- Choose safe diagnostic summaries and evidence structure; raw user text, chain-of-thought, generated source, credentials, and provider-native receipts remain outside ordinary status/logs.

### Deferred Ideas (OUT OF SCOPE)

- Phase 5: `needs_top_up`, ten-minute live-worker waiting, durable checkpoint retention, explicit resume, and 30-day expiry.
- Phase 6: compatible preview, capability consent, user-owned manifest signing, deployment, and CVM attestation.
- Phase 7: live model/provider/proxy promotion, production load/SLO, multi-region/chaos evidence, exhaustive hostile testing, and launch certification.
- v2: public x402 and L402 adapters and richer input types.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BILL-03 | Debit authoritative measured API usage exactly once at authorization-time pricing. | Versioned rational price-card, protected receipt, serializable receipt-first settlement, unique operation/receipt keys. |
| BILL-04 | Expose immutable hold/release/debit/credit/reconciliation line items and remaining funds. | Append-only ledger/evidence/outbox schema plus owner-scoped safe status projection. |
| BILL-05 | Make a timed-out/ambiguous request reconcile rather than retry/double-charge. | Intent-before-I/O, `usage_unknown` fence, provider lookup contract, no redispatch rule. |
| SESS-01 | Start a bounded text-only generation session. | Existing Phase 2 admission gate followed by fenced session/action creation. |
| SESS-03 | Show stable session ID, state/progress/cap/spend/next action. | Redacted server-derived session-status projection. |
| SESS-04 | Submit a separately authorized/metered bounded revision. | Same lineage and expected-version command path; new action and operation IDs. |
| GEN-05 | Repair only within funds, cap, and napplet policy. | One-repair policy counter, separate budget/operation/receipt, validation-report binding. |
| GEN-06 | Return failed/incomplete work only with diagnostics and evidence. | Preserve previous verified artifact and return safe validation/evidence references. |
</phase_requirements>

## Summary

Implement Phase 4 as a coordinator-owned, receipt-first extension of the completed Phase 2/3 seams. `FundedAdmissionService.authorizeActionBudget` already provides an action reservation under the approved cap, and the funded composition deliberately exposes no worker/model handle. Extend that authority with an immutable action lifecycle, operation sub-reservations, versioned price cards, normalized receipts, and one atomic finalization transaction; do not replace the existing cap-hold or serializable funding authority. [VERIFIED: codebase `src/funding/funded-admission.ts`, `src/persistence/funding-store.ts`, `src/phase-03/funded-core.ts`]

The live-provider boundary must remain unselected. OpenAI’s current documents show distinct server request IDs, caller-provided client request IDs, response IDs, receipt usage dimensions, and background lifecycle events; this is enough to define a candidate reconciliation test, not enough to claim a production-exact billing provider without fixture evidence for the selected model/profile, price card, and lookup flow. The accessible Anthropic Messages reference did not yield a usable receipt/lookup contract in this research, so it is not eligible for Phase 4 selection. [CITED: https://platform.openai.com/docs/guides/production-best-practices] [CITED: https://platform.openai.com/docs/api-reference/responses-streaming/response/file_search_call] [CITED: https://platform.claude.com/docs/en/api/messages]

**Primary recommendation:** Build the complete deterministic, provider-separated loop first: one session/action fence, persisted operation intent, authoritative receipt fixture, integer settlement, napplet worker/validation result, immutable evidence, and safe ContextVM status. Leave every real provider/proxy `unselected` unless the Phase 4 validation gate proves correlation, pinned pricing, and post-timeout reconciliation.

## Project Constraints (from AGENTS.md)

- Prefer the codebase-memory graph tools for code discovery; graph support is disabled in this workspace, so this research used the permitted source fallback. [VERIFIED: `AGENTS.md`, `gsd-tools graphify status`]
- Keep v1 public generation/session transport to ContextVM; the core remains transport-neutral, and the CVM must never receive/store a user Nostr private key. [VERIFIED: `AGENTS.md`]
- Preserve the permanent bounded, text-only, single-purpose sandboxed napplet boundary; use `@napplet/cli` and the promoted napplet toolchain instead of hand-writing protocol/publication logic. [VERIFIED: `AGENTS.md`]
- Treat prompts, generated code, tool output, dependencies, and runtime messages as untrusted; maintain layered capability, filesystem/network, output, and publication controls. [VERIFIED: `AGENTS.md`]
- Do not introduce a durable generation queue, preview/publication authority, Phase 5 continuation behavior, or Phase 7 production certification in this phase. [VERIFIED: `04-CONTEXT.md`]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Session command/replay/fence | API / Backend | Database / Storage | The coordinator authenticates/validates commands; serializable persistence supplies the single writer. [VERIFIED: codebase] |
| Cap/action/operation authorization and settlement | Database / Storage | API / Backend | Accounting mutations and uniqueness must commit atomically; the coordinator chooses policy and builds the transaction. [VERIFIED: codebase] |
| Model request, abort, and receipt normalization | API / Backend | External provider | Only the coordinator may hold credentials, choose a profile, and correlate provider evidence. [VERIFIED: `04-CONTEXT.md`] |
| Workspace edit/build/napplet validation | Isolated Worker | API / Backend | The worker performs bounded work; the coordinator supplies grants and verifies typed results/evidence. [VERIFIED: codebase] |
| Session status / ContextVM response | API / Backend | Database / Storage | A thin adapter projects only owner-scoped, redacted persisted state. [VERIFIED: codebase] |

## Standard Stack

### Core

| Library / component | Version | Purpose | Why standard here |
|---|---:|---|---|
| Project-owned TypeScript `ModelGateway` + `WorkerPort` | Versioned project schema | Model isolation and worker execution boundary | The AI spec locks a frameworkless boundary so billing, policy, sessions, and evidence never move into a third-party agent framework. [VERIFIED: `04-AI-SPEC.md`] |
| `zod` | 4.4.3, published 2026-05-04 | Strict external command, receipt, and status schemas | Already installed and used at trust boundaries; all unknown input must be parsed before effects. [VERIFIED: npm registry; codebase] |
| Kysely + `pg` | 0.29.4 / 8.22.0, published 2026-07-17 / 2026-06-19 | PostgreSQL-wire serializable monetary/session persistence | Existing Phase 3 authority is explicitly PostgreSQL-backed in production and exposes the action-budget seam Phase 4 must consume. [VERIFIED: npm registry; codebase] |
| Promoted napplet CLI/skills/conformance image | Existing pinned compatibility set | Scaffold, fixed build/verify, real-browser conformance | Phase 1 owns toolchain promotion; a metered action must not resolve or upgrade packages. [VERIFIED: `04-CONTEXT.md`, `04-AI-SPEC.md`] |

### Supporting

| Library / component | Version | Purpose | When to use |
|---|---:|---|---|
| `modal` Sandbox adapter | 0.9.0, published 2026-07-09 | Candidate WorkerPort implementation | Keep behind existing worker port only; sandbox lifecycle/timeouts are not financial or artifact-success evidence. [VERIFIED: npm registry] [CITED: https://modal.com/docs/sdk/js/latest/Sandbox] |
| ContextVM SDK adapter | 0.13.10, published 2026-07-22 | Signed v1 request/status transport | Extend only the thin adapter command allowlist and response projection; do not import its types into domain/billing contracts. [VERIFIED: npm registry; codebase] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| Project-owned model loop | Agent framework | Not selected: the locked core needs durable financial/session ownership no generic framework provides. [VERIFIED: `04-AI-SPEC.md`] |
| Deterministic gateway fixture | Live model provider/proxy | Not selected: live choice lacks the required complete correlation, pinned-price, and post-timeout proof. [VERIFIED: `04-CONTEXT.md`] |

**Installation:** No external package installation is required for Phase 4. Use the already-locked dependencies and promoted worker image. [VERIFIED: `package.json`, `04-AI-SPEC.md`]

## Package Legitimacy Audit

No packages are newly installed in this phase, so the package-legitimacy gate is not applicable. Existing packages above were registry-verified only to document the present stack; Phase 4 must not update them. [VERIFIED: npm registry]

## Architecture Patterns

### System Architecture Diagram

```text
signed ContextVM command
  -> thin adapter (owner + schema only)
  -> Phase-2 input/risk gate -> session/action replay + expected-version fence
  -> resolve immutable profile + price card -> authorize action budget
  -> persist operation intent + sub-reservation
  -> ModelGateway (credential/correlation boundary)
       -> deterministic fixture OR eligible-not-selected provider adapter
  -> normalized protected receipt? ---- no/timeout/mismatch ---> usage_unknown
  -> price receipt with integer/rational math                  -> reconciliation lookup original operation only
  -> serializable settle: debit actual + release remainder + line items/evidence/outbox
  -> WorkerPort -> fixed napplet scaffold/build/verify/conformance gates
  -> verified artifact commit OR failed diagnostic/evidence (prior artifact remains)
  -> safe owner-scoped session_status
```

### Recommended Project Structure

```text
src/
├── phase-04/
│   ├── metered-generation-service.ts # command orchestration and lifecycle
│   ├── session-status.ts             # redacted status projection
│   └── repair-policy.ts              # versioned one-repair decision
├── model/
│   ├── model-gateway.ts              # provider-neutral port and strict schemas
│   ├── deterministic-model-gateway.ts# offline authoritative-fixture fake
│   └── price-card.ts                 # integer/rational pricing and validation
├── persistence/
│   └── funding-store.ts              # extended single action/operation/receipt/finalization authority
└── verification/
    └── phase-04-design-evidence.ts   # immutable, redacted deterministic evidence
tests/
├── phase-04/                         # tracer and ContextVM/session/status tests
├── billing/                          # rational price and exact-finalization tests
├── model/                            # receipt/timeout/reconciliation tests
└── evals/                            # deterministic reference set
```

Modify `src/funding/funded-admission.ts` and the `FundingStore`/Postgres implementations to reserve/finalize operation budgets without bypassing the existing cap hold; modify `src/contextvm/adapter.ts` and Phase 3 composition only to mount the new owner-scoped core. Reuse `src/phase-02/trusted-core.ts`, `src/worker-port/`, `src/policy/artifact-contract.ts`, and `src/verification/` rather than recreating worker or artifact policy. [VERIFIED: codebase]

### Pattern 1: Receipt-first operation state machine

**What:** Durable action and operation intent precede any provider call. A terminal receipt is immutable and can finalize once; ambiguous delivery becomes an explicit non-terminal financial state.

**When to use:** Every generation, revision, model schema correction, and automatic repair operation.

```ts
// Project pattern; provider-native SDK objects never leave the adapter.
type OperationState =
  | "prepared" | "dispatched" | "receipt_recorded"
  | "settled" | "failed" | "usage_unknown" | "billing_invariant_failed";

await store.transact(accountId, tx => tx.createOperationIntent(intent));
const received = await gateway.invoke(intent, abortSignal).catch(() => undefined);
if (!received) return store.markUsageUnknown(intent.operationId);
const receipt = UsageReceiptSchema.parse(received.receipt);
return store.finalizeReceipt({ intent, receipt }); // unique operation+receipt; serializable
```

The `Promise` deadline only bounds waiting. It must invoke an `AbortSignal` where supported but must still write `usage_unknown` if provider acceptance/usage is uncertain; a caller-side abort cannot prove remote cancellation. [CITED: https://modal.com/docs/sdk/js/latest/Sandbox] [CITED: https://platform.openai.com/docs/guides/production-best-practices]

### Pattern 2: Integer/rational sat price card

**What:** Represent each supported usage dimension as `{ numeratorSat, denominatorUnits, rounding: "ceil" }`, calculate each line with `bigint`, and persist input units, rate version, quotient/remainder, and rounded sat charge.

**When to use:** Price validation before dispatch and receipt finalization.

```ts
function ceilDiv(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error("INVALID_PRICE_OPERAND");
  return (n + d - 1n) / d;
}
function charge(units: bigint, rate: { numeratorSat: bigint; denominatorUnits: bigint }) {
  return ceilDiv(units * rate.numeratorSat, rate.denominatorUnits);
}
```

Reject unsupported dimensions, negative/non-integral usage, invalid denominators, a receipt/profile/card mismatch, and a computed charge above its sub-reservation before any debit. Never convert `bigint` to `number` or aggregate rounded dimensions under a different documented policy. [VERIFIED: `04-CONTEXT.md`]

### Pattern 3: One writer, one action, one verified advancement

**What:** Persist a canonical command fingerprint and expected session version; exact duplicate returns its stored result, conflict/stale fails before work, and the final transaction advances `current_verified_artifact_version` only when the action succeeded and artifact gates passed.

**When to use:** `start_session`, revision, repair, status-triggered replay, and reconciliation finalization.

**Anti-patterns to avoid**

- **Retrying a model operation after a timeout:** Look up the same persisted provider operation; never turn an uncertainty into a fresh billable request. [VERIFIED: `04-CONTEXT.md`]
- **Charging a maximum/estimate/current rate:** Price only normalized receipt units against the authorization-time card. [VERIFIED: `04-CONTEXT.md`]
- **Using worker completion as artifact success:** Require the pre-existing artifact, fixed-command, and browser-conformance gates. [VERIFIED: `04-CONTEXT.md`]
- **Exposing status via object spread:** Use an explicit response allowlist as the existing ContextVM adapter does. [VERIFIED: codebase `src/contextvm/adapter.ts`]

## Provider / Proxy Eligibility Research

| Candidate | Correlation / receipt evidence | Timeout / lookup evidence | Phase 4 disposition |
|---|---|---|---|
| Deterministic `ModelGateway` fixture | Server operation ID, fixture provider request ID, complete normalized dimensions, signed/hashed raw-fixture evidence are all controlled by the test harness. [VERIFIED: `04-CONTEXT.md`] | Failure injection deterministically returns lost/late/malformed/over-ceiling receipts and lookup outcomes. [VERIFIED: `04-AI-SPEC.md`] | **Use for Phase 4 validation.** It proves service semantics, not external billing truth. |
| OpenAI Responses candidate | Docs expose `x-request-id`, optional caller `X-Client-Request-Id`, response IDs, and usage including input/output/cached/reasoning dimensions. [CITED: https://platform.openai.com/docs/guides/production-best-practices] [CITED: https://platform.openai.com/docs/api-reference/responses-streaming/response/file_search_call] | Docs say caller IDs can assist support lookup after network loss and document background completion/failure/cancellation events; the selected model/profile still needs a testable normal retrieval/receipt contract. [CITED: https://platform.openai.com/docs/guides/production-best-practices] [CITED: https://platform.openai.com/docs/api-reference/webhook-events] | **Eligible-not-selected.** Build an adapter contract test only; no live receipt/cost claim. |
| Anthropic Messages candidate | The current official reference was accessible but dynamically rendered without a usable receipt/correlation contract in this research. [CITED: https://platform.claude.com/docs/en/api/messages] | Post-timeout lookup/reconciliation was not proven from an authoritative extract in this session. [CITED: https://platform.claude.com/docs/en/api/messages] | **Unselected.** Do not infer capability from common SDK behavior. |
| Proxy/aggregator | No provider-neutral proxy evidence was researched that proves every required correlation, receipt, pinned-price, and post-timeout lookup capability. [ASSUMED] | No selection. [ASSUMED] | **Do not add or select one in Phase 4.** |

**Required `ModelGateway` contract:** `dispatch(intent, signal)` must use the persisted server operation ID as caller correlation where the provider supports it; it returns either a strict authoritative receipt or an explicit ambiguous observation. `lookup(intent)` is the only post-timeout path and must correlate the original operation/request, never construct a new model request. The adapter must retain protected native payload evidence separately from the normalized receipt. [VERIFIED: `04-CONTEXT.md`]

## Don't Hand-Roll

| Problem | Do not build | Use instead | Why |
|---|---|---|---|
| NIP-5D scaffold/manifest/conformance | Custom manifest, browser harness, or CLI substitute | Promoted napplet CLI/boilerplate/skills/conformance commands | The package compatibility set and Phase 1 evidence are the protocol authority. [VERIFIED: `04-CONTEXT.md`] |
| Worker isolation/tool routing | Provider-key-bearing agent loop or arbitrary shell executor | Existing `WorkerPort` + `ScopedToolGateway` | It already fences typed grants, paths, commands, workspace, and evidence. [VERIFIED: codebase] |
| Floating-point pricing | Decimal JS arithmetic or provider cost estimate | `bigint` rational price-card module | Money and ceilings must be reproducible/auditable. [VERIFIED: `04-CONTEXT.md`] |
| Retry/queue behavior | Durable model request queue or automatic reissue | Intent-first direct dispatch + reconciliation outbox | Accepted work may not become durable queued work; ambiguous effects require lookup. [VERIFIED: `AGENTS.md`, `04-CONTEXT.md`] |
| Public status serialization | Raw DTO/provider object passthrough | Explicit Zod response allowlist | Prevents secret, prompt, source, receipt, and grant leakage. [VERIFIED: codebase] |

**Key insight:** The difficult part is not invoking a model; it is ensuring every model side effect and every financial result has one durable, correlated story. A provider SDK is an adapter, never billing/session authority. [VERIFIED: `04-CONTEXT.md`]

## Common Pitfalls

### Pitfall 1: A timeout is mistaken for zero usage

**What goes wrong:** A local timeout can happen after the provider has accepted/billed the request; release or redispatch produces a hidden liability or duplicate charge.

**How to avoid:** Commit intent before I/O, record `usage_unknown` on every uncertain observation, freeze further billable work, and reconcile only the same operation/request identity. [VERIFIED: `04-CONTEXT.md`]

### Pitfall 2: Price-card drift or per-action rounding ambiguity

**What goes wrong:** Settling with current prices or JavaScript numbers makes the same receipt non-reproducible.

**How to avoid:** Persist immutable card/profile IDs, dimension units, rational rates, rounding mode, intermediate values, and final charge alongside the receipt. [VERIFIED: `04-CONTEXT.md`]

### Pitfall 3: Separate session and ledger commits

**What goes wrong:** An action advances after a debit failure, or a debit commits without a replayable terminal outcome.

**How to avoid:** One serializable transaction writes terminal action outcome, receipt dedupe, debit/release postings, balance/cap projections, immutable evidence record, stored response, and outbox event. Retry only the local SQL transaction; never rerun provider dispatch. [VERIFIED: codebase; `04-CONTEXT.md`]

### Pitfall 4: Repair becomes an autonomous spending loop

**What goes wrong:** Schema correction and validation repair use an inherited reservation or silently recur.

**How to avoid:** Every operation gets a sub-reservation; repair gets a separate action budget and an originating validation-report reference; a policy counter limits automatic repair to one. [VERIFIED: `04-CONTEXT.md`]

### Pitfall 5: Model output gains authority

**What goes wrong:** Instructions in a prompt, build log, skill text, package metadata, or model response alter policy, commands, money, or status data.

**How to avoid:** Keep strict schemas, fixed command IDs, explicit allowlists, untrusted-data fields, and coordinator-owned grants. OWASP lists prompt injection, insecure output handling, supply-chain risk, and excessive agency as LLM application risks. [CITED: https://owasp.org/www-project-top-10-for-large-language-model-applications/]

## Code Examples

### Safe terminal finalization shape

```ts
// Pseudocode for the new persistence port; all amounts are bigint in-process.
await fundingStore.transact(accountId, async (tx) => {
  const op = await tx.lockOperation(operationId);
  if (op.terminal) return tx.replayOperationResult(operationId);
  const priced = priceReceiptAgainstPinnedCard(receipt, op.priceCard);
  if (priced.totalSat > op.reservedSat) return tx.failBillingInvariant(op, receipt);
  return tx.settleOperation({
    operationId, receipt, priced,
    debitSat: priced.totalSat,
    releaseSat: op.reservedSat - priced.totalSat,
    actionOutcome, // success/failed; not "artifact success" by default
    artifactAdvance: artifactGatePassed ? candidateArtifact : undefined,
  });
});
```

The transaction must enforce unique operation ID, unique provider receipt identity in its provider/model scope, and unique finalization/ledger references. If the terminal result already exists, replay it without a second ledger effect. [VERIFIED: codebase; `04-CONTEXT.md`]

### Safe public session status

```ts
const SessionStatusSchema = z.object({
  sessionId: z.string().min(1), state: z.enum(["ready", "running", "failed", "usage_unknown", "billing_invariant_failed"]),
  version: z.number().int().nonnegative(), approvedCapSat: z.string().regex(/^\d+$/),
  confirmedSpendSat: z.string().regex(/^\d+$/), remainingCapSat: z.string().regex(/^\d+$/),
  action: z.object({ id: z.string(), state: z.string(), reservationSat: z.string().regex(/^\d+$/) }).optional(),
  profileVersion: z.string(), priceCardVersion: z.string(), reconciliationState: z.string(),
  verifiedArtifact: z.object({ id: z.string(), version: z.number().int().nonnegative() }).optional(),
  diagnostic: z.object({ code: z.string(), evidenceId: z.string() }).optional(), nextRequiredAction: z.string(),
}).strict();
```

Build this object field-by-field from persisted projections. Do not include raw prompts, raw model/provider payloads, source, credentials, grants, or chain-of-thought. [VERIFIED: `04-CONTEXT.md`, codebase]

## State of the Art

| Old approach | Current approach | Impact |
|---|---|---|
| Treat a model request as a synchronous RPC and use returned output as truth | Persist intent first; normalize correlated receipt/evidence; reconcile an ambiguous result | A network timeout can be handled without silently charging, freeing, or duplicating work. [CITED: https://platform.openai.com/docs/guides/production-best-practices] |
| Let an agent framework own loop state/tools | Keep financial/session/policy authority in project-owned ports | Provider and worker adapters remain replaceable and cannot acquire monetary authority. [VERIFIED: `04-AI-SPEC.md`] |

**Deprecated/outdated:** A global mutable current-price lookup at settlement is incompatible with D-59; use the immutable authorization-time price-card version. [VERIFIED: `04-CONTEXT.md`]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | No proxy/aggregator has yet been shown to meet every Phase 4 receipt/reconciliation requirement. | Provider / Proxy Eligibility Research | An implementer might introduce an unproven paid path; keep it unselected until a formal contract test passes. |
| A2 | Anthropic’s accessible dynamic reference did not prove the needed lookup contract. | Provider / Proxy Eligibility Research | This is absence of evidence, not a claim of lack of capability; require official proof before use. |

## Open Questions (RESOLVED)

1. **Which live provider/proxy passes the complete gate? — RESOLVED by approved deferral.**
   - Phase 4 selects and certifies no live provider or proxy. Every Phase 4 provider/model observation remains explicitly `unselected`; the deterministic gateway proves only project-owned lifecycle, accounting, ambiguity, and evidence semantics.
   - Phase 7 owns live provider integration and certification after an integration fixture proves normal receipt retrieval, immutable pricing, authoritative usage correlation, and post-timeout lookup for the exact selected profile.
2. **What is the chosen exact status pagination/retention policy? — RESOLVED.**
   - Billing history accepts a page limit from 1 through 50 inclusive and defaults to 50. Ordering is immutable ascending commit sequence plus stable item ID.
   - The cursor is opaque, versioned, integrity-protected, bound to owner/session/query, and resumes strictly after the last sequence/item. An invalid or foreign cursor returns one generic `invalid_cursor` result without data.
   - Phase 4 never deletes or mutates financial line items and can traverse all committed line items. Public status exposes only normalized items and evidence identifiers.
   - Retention or deletion of protected provider-native payloads is not a status feature. It remains governed by later operational/legal policy and such payloads are never copied into public billing history.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---:|---|---|
| Bun | Coordinator/tests | Yes | 1.3.14 | — |
| Node/npm | registry metadata / tooling | Yes | Node 25.2.1 / npm 11.6.2 | — |
| pnpm | promoted napplet fixed commands | Yes | 10.24.0 | — |
| PostgreSQL CLI | SQL inspection/integration setup | Yes | 18.1 | Deterministic in-memory stores only for offline tests; never production monetary authority. |
| Docker | worker-image test setup | Yes | 28.5.2 | Existing promoted-image fixtures; no live worker claim. |
| Live model credentials/provider | live provider validation | No configured credential observed | — | Deterministic `ModelGateway` and receipt fixtures; no provider selection. |

**Missing dependencies with no fallback:** None for Phase 4 deterministic design validation.  
**Missing dependencies with fallback:** Live provider credentials/contract environment; retain the provider-separated deterministic proof.

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework | Bun test, Bun 1.3.14 [VERIFIED: `package.json`, environment] |
| Config file | none; package script delegates to `bun test` [VERIFIED: `package.json`] |
| Quick run command | `bun test tests/phase-04 tests/billing tests/model --timeout 10000` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| BILL-03 | Authorization-time card produces one receipt-derived debit/release; duplicate terminal receipt replays. | unit + integration | `bun test tests/billing/price-card.test.ts tests/billing/operation-finalization.test.ts` | Wave 0 |
| BILL-04 | Immutable correlated line-item/evidence/status projection contains every monetary/reconciliation event and redacts secrets. | integration | `bun test tests/billing/line-items.test.ts tests/phase-04/session-status.test.ts` | Wave 0 |
| BILL-05 | Timeout/lost/malformed receipt produces `usage_unknown`, no redispatch, and only lookup can resolve. | fault-injection | `bun test tests/model/reconciliation.test.ts` | Wave 0 |
| SESS-01 | Bounded text start executes Phase 2 gates before budget/worker/model work and produces stable session. | tracer | `bun test tests/phase-04/tracer.test.ts` | Wave 0 |
| SESS-03 | Owner-only safe status returns progress/cap/actual spend/next action/verified artifact. | contract | `bun test tests/phase-04/session-status.test.ts` | Wave 0 |
| SESS-04 | Revision uses same workspace lineage and a new independently authorized action; duplicate replay/stale conflict have no effect. | integration | `bun test tests/phase-04/revision.test.ts` | Wave 0 |
| GEN-05 | One validation failure authorizes at most one separate repair; second automatic repair is blocked. | integration | `bun test tests/phase-04/repair.test.ts` | Wave 0 |
| GEN-06 | Build/conformance failure preserves old artifact and returns only safe diagnostic/evidence fields. | integration | `bun test tests/phase-04/artifact-outcome.test.ts` | Wave 0 |

### Required adversarial/reference cases

- Price fixture: every priced dimension, zero/nonzero receipt, cached/reasoning dimension handling, ceil-boundary, overflow, unsupported dimension, card/profile mismatch, and over-reservation invariant failure.
- Idempotency/concurrency fixture: duplicate command and receipt, conflicting same idempotency key, stale session version, simultaneous revisions, crash after provider success before finalization, and serializable retry.
- Ambiguity fixture: timeout before dispatch, timeout after accepted dispatch, lost response, malformed receipt, lookup pending/found/not-found, and no fresh invocation while blocked.
- Artifact fixture: worker/model failure with valid nonzero receipt, build/verify/conformance failure, failed repair, successful repair, and prior verified artifact preservation.
- Status fixture: foreign-owner access, field leakage regex, cardinality/pagination limit, replayed result, and safe evidence identifiers only.

### Sampling Rate

- **Per task commit:** Targeted Bun files named in the task plus `bun test tests/phase-03/tracer.test.ts` for funding seam regression.
- **Per wave merge:** `bun test` and the deterministic Phase 4 reference-set command.
- **Phase gate:** Full suite green; deterministic reference evidence separates fake-provider proof from every live-provider claim.

### Wave 0 Gaps

- [ ] `tests/billing/price-card.test.ts` and `tests/billing/operation-finalization.test.ts` — BILL-03 rational/exact settlement.
- [ ] `tests/billing/line-items.test.ts` — BILL-04 ledger/evidence projection.
- [ ] `tests/model/reconciliation.test.ts` — BILL-05 timeout/lookup/no-retry behavior.
- [ ] `tests/phase-04/{tracer,session-status,revision,repair,artifact-outcome}.test.ts` — session and napplet-loop requirements.
- [ ] `tests/evals/phase-04-reference-set.test.ts` and a redacted fixture — provider-separated deterministic acceptance gate.
- [ ] `scripts/verify-phase-04-design-slice.ts` and `src/verification/phase-04-design-evidence.ts` — immutable evidence emission consistent with Phases 2/3.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | Yes | ContextVM verified-pubkey-to-principal edge; no user private-key custody. [VERIFIED: codebase, `AGENTS.md`] |
| V3 Session Management | Yes | Stable owner-scoped session, expected-version fence, action replay records, and opaque IDs. [VERIFIED: `04-CONTEXT.md`] |
| V4 Access Control | Yes | Worker has no provider/billing/policy/publication authority; status is owner-scoped. [VERIFIED: `04-CONTEXT.md`] |
| V5 Input Validation | Yes | Strict Zod command, operation, receipt, worker-result, and response schemas plus Phase 2 input gate. [VERIFIED: codebase] |
| V6 Cryptography | Yes | Reuse existing hashing/protected-evidence mechanisms; never hand-roll cryptography for receipt proof. [VERIFIED: codebase] |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Prompt/model/tool-output instruction alters a privileged action | Elevation of privilege | Treat all content as data; fixed command/tool/status allowlists and coordinator schemas. [CITED: https://owasp.org/www-project-top-10-for-large-language-model-applications/] |
| Timeout causes duplicate paid provider operation | Tampering / repudiation | Intent-first operation fence, no redispatch, immutable receipt and lookup reconciliation. [VERIFIED: `04-CONTEXT.md`] |
| Receipt/card mismatch charges an unauthorized amount | Tampering | Pinned profile/card, bigint rational pricing, reservation ceiling, invariant-failed block. [VERIFIED: `04-CONTEXT.md`] |
| Sensitive prompt/provider evidence leaks in status/logs | Information disclosure | Protected native evidence and explicit redacted response projection. [VERIFIED: `04-CONTEXT.md`] |
| Worker/agent gains credentials or uncontrolled egress | Elevation of privilege | Model gateway owns credentials; WorkerPort grants and default-deny network remain mandatory. [VERIFIED: `04-CONTEXT.md`] |

## Sources

### Primary / authoritative project evidence

- `04-CONTEXT.md`, `04-AI-SPEC.md` — locked lifecycle, authority, design-stage and provider-selection boundaries. [VERIFIED: codebase]
- `src/funding/funded-admission.ts`, `src/persistence/funding-store.ts`, `src/phase-03/funded-core.ts`, `src/contextvm/adapter.ts` — existing authorization, funding, composition, and explicit response-allowlist seams. [VERIFIED: codebase]
- npm registry metadata — installed dependency versions and publication dates. [VERIFIED: npm registry]

### Official technical sources

- [OpenAI production best practices](https://platform.openai.com/docs/guides/production-best-practices) — request IDs and caller correlation for timeouts/network issues. [CITED]
- [OpenAI Responses streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/file_search_call) and [webhook events](https://platform.openai.com/docs/api-reference/webhook-events) — response IDs, usage dimensions, completion/failure/cancellation event shapes. [CITED]
- [Modal JavaScript Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox) — lifecycle limits, network block, termination, readiness, and timeout semantics. [CITED]
- [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — prompt injection, output handling, plugin, supply-chain, and excessive-agency threats. [CITED]
- [Anthropic Messages reference](https://platform.claude.com/docs/en/api/messages) — reachable primary source but insufficiently extractable evidence for selection. [CITED]

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — follows existing installed/version-pinned project composition. [VERIFIED: codebase; npm registry]
- Architecture: HIGH — directly constrained by Phase 2/3 executable seams and locked decisions. [VERIFIED: codebase]
- Provider capabilities: MEDIUM — OpenAI primary docs establish correlation primitives, but no selected live-provider fixture was run; Anthropic/proxy capabilities remain unproven. [CITED: https://platform.openai.com/docs/guides/production-best-practices]
- Pitfalls: HIGH — locked product decisions plus official LLM-security guidance. [VERIFIED: `04-CONTEXT.md`] [CITED: https://owasp.org/www-project-top-10-for-large-language-model-applications/]

**Research date:** 2026-08-04  
**Valid until:** 2026-08-11 for provider documentation; project/codebase findings remain valid until the relevant contracts change.
