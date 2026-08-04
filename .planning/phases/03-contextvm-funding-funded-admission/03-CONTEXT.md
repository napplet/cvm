# Phase 3: ContextVM Funding & Funded Admission - Context

**Gathered:** 2026-08-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 3 connects signed ContextVM identity and CEP-8 top-ups to a transport-neutral prepaid-account authority. It lets one Nostr public key discover the v1 capabilities, obtain one stable account, fund it through verified Lightning or trusted-mint Cashu settlement, inspect durable account/top-up state, approve a disclosed session cap, and obtain an atomic funded-admission decision without duplicate credit, overspend, or a hidden queue.

This phase establishes financial and admission contracts. It does not implement exact provider-usage debits or the generation loop (Phase 4), insufficient-balance pause/checkpoint/resume behavior (Phase 5), preview/publication signing (Phase 6), or measured five-second/multi-region production certification (Phase 7).

</domain>

<decisions>
## Implementation Decisions

### Signed Identity and Transport Boundary

- **D-40:** ContextVM is the only public v1 transport. A thin adapter verifies the signed event with the pinned SDK contract, derives the principal only from the verified sender public key, and maps it to one stable account. Payload-claimed identity is never authoritative.
- **D-41:** ContextVM announcement, request/reply, replay, and CEP-8/PMI types stop at the adapter boundary. Core account, top-up, ledger, cap, and admission commands remain transport-neutral for future x402/L402 adapters. — **Reversibility:** costly — leaking living protocol types into the financial core would require migrations and broad call-site rewrites.
- **D-42:** The signed v1 announcement advertises generation, account/status, top-up, session, preview, and publication capabilities. It does not expose working x402/L402 endpoints or claim unavailable later-phase operations are already implemented.

### Account and Ledger Authority

- **D-43:** The normalized Nostr public key is the stable account identity; no password, delegated user secret, or Nostr private key is held by the service.
- **D-44:** Monetary truth is a serializable, append-only relational ledger behind a transport-neutral port. Credits, holds/reservations, releases, settlement adjustments, idempotency records, and outbox records commit transactionally. Balance is a derived/maintained projection, never the sole source of truth. — **Reversibility:** one-way — changing ledger identity or posting semantics after value exists requires a financial-data migration and reconciliation.
- **D-45:** Every mutating core command binds account, command kind, client idempotency key, canonical payload fingerprint, and policy/version data. Exact replay returns the durable result; conflicting key reuse fails closed. Settlement and ledger posting references also have independent uniqueness constraints.

### CEP-8 Top-Up Lifecycle

- **D-46:** CEP-8 exposes a separate top-up capability and negotiates only the mutually supported v1 rails: Lightning BOLT11 and Cashu. CEP-8 funds the prepaid account; it is not the generation-call charging mechanism.
- **D-47:** Both rails normalize into one explicit lifecycle: `pending → verifying → settled → credited`, or `failed`; ambiguous external outcomes enter `reconciliation_pending`. A top-up becomes spendable only after independently verified settlement and one atomic ledger credit.
- **D-48:** Lightning credit requires an authoritative settled receipt matched to the service-created top-up, expected amount, unit, invoice identity, expiry/finality policy, and stable settlement reference. Invoice creation, submission, or notification alone never credits value.
- **D-49:** Ordinary status responses show top-up ID, state, amount, unit, rail, timestamps, and a safe settlement reference. Raw Cashu tokens, proofs, Lightning preimages, provider secrets, and other bearer material never enter logs, general evidence, or public status payloads.

### Cashu Mint Policy and Treasury Reconciliation

- **D-50:** Cashu acceptance requires a versioned active allowlist containing multiple trusted mints plus unit/keyset policy. A top-up pins the policy version used for its decision; rotating the active allowlist never rewrites historical settlement records.
- **D-51:** Cashu credit requires verified mint, unit, amount, keyset/proof structure, proof commitment, spendability/redeem outcome, and a unique settlement/proof commitment. Parsed or syntactically valid bearer tokens are not settled value.
- **D-52:** Treasury reconciliation is a separate idempotent state transition tied to the original credited top-up. It may record later mint/treasury movement or an explicit unknown state, but it cannot post a second user credit.

### Funded Admission and Session Cap

- **D-53:** Before the first billable action, the user explicitly approves a maximum in one disclosed integer currency unit. Admission atomically places a session-cap hold equal to the lesser of the requested cap and currently available settled balance. A hold is not a fee or debit; unused balance and cap remain the user's.
- **D-54:** Per-action authorization consumes availability under both the account hold and remaining approved cap, but exact provider-usage finalization, debit, line-item detail, and ambiguous provider reconciliation are implemented in Phase 4.
- **D-55:** Admission is commit-or-reject: the authenticated/idempotent command, funding reservation, and immediately usable capacity decision must agree in one coordinated flow. If capacity is unavailable, return a durable retryable refusal and leave no accepted queued work or stranded hold. Phase 7 measures the five-second p95 and certifies the provider.

### Replay, Ambiguity, and Reconciliation

- **D-56:** Duplicate relay delivery, client retry, payment notification, and settlement callback are normal at-least-once inputs. Exactly-once business effects come from durable command records, canonical fingerprints, unique external references, ledger constraints, and replay-before-effect lookup—not from assuming exactly-once delivery.
- **D-57:** Persist external settlement intent before I/O. Record a verified outcome or explicit `reconciliation_pending`; safe status queries may repeat, but an opaque/unknown payment creation, redemption, or credit effect is never blindly reissued.
- **D-58:** Account/status queries expose current available/held balance, approved caps, active or resumable session references, pending actions, and top-up/settlement states through ContextVM while preserving the redacted/hash-based evidence pattern established in Phase 2.

### the agent's Discretion

- Choose stable command/state/error names and exact schema layout while preserving the transitions and fail-closed semantics above.
- Choose the SQL query builder/migration layout and conservative serializable retry policy consistent with the project stack.
- Choose provider adapter interfaces for Lightning and Cashu after official contract research, provided no adapter can post ledger value directly.
- Choose safe display-reference formatting and retention/encryption details for protected rail-specific records.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Phase Scope

- `.planning/PROJECT.md` — Active milestone, ContextVM-only v1 boundary, prepaid/cap/no-queue constraints, key custody, and later-phase exclusions.
- `.planning/REQUIREMENTS.md` — Phase 3 requirements `CTX-01`–`CTX-04`, `PAY-01`–`PAY-07`, `BILL-01`, `BILL-02`, and `BILL-06`.
- `.planning/ROADMAP.md` — Phase 3 goal, success criteria, dependencies, and ContextVM/CEP-8 fixture validation gate.

### Architecture and Protocol Research

- `.planning/research/ARCHITECTURE.md` — Recommended adapter boundary, serializable ledger, idempotency scopes, settlement/outbox, reservation, and admission flow.
- `.planning/research/STACK.md` — Current ContextVM SDK/CEP-8, Bun, SQL/Kysely, and deployment recommendations; mutable versions must be re-verified.
- `.planning/research/PITFALLS.md` — Duplicate credit, Cashu proof, ambiguous settlement, queue, custody, and retry hazards.
- `.planning/research/SUMMARY.md` — Cross-cutting recommendation for top-up-versus-usage separation and transactional accounting.

### Established Executable Contracts

- `.planning/phases/02-trusted-core-isolated-agent-execution/02-CONTEXT.md` — D-20–D-23 action serialization and transport-neutral authority; D-27 safe evidence; D-29 exclusion of billing tools.
- `.planning/phases/02-trusted-core-isolated-agent-execution/02-VERIFICATION.md` — Verified replay, fencing, effect-intent, artifact, and provider-separation behavior Phase 3 must preserve.
- `.planning/phases/02-trusted-core-isolated-agent-execution/02-SECURITY.md` — Security boundary and open evidence-completeness items relevant to financial evidence.
- `src/phase-02/contracts.ts` — Existing strict principal/action/worker boundary schemas.
- `src/domain/session-action.ts` — Canonical action/request/evidence fingerprint pattern.
- `src/persistence/session-store.ts` — Transport-neutral durable authority seam and explicit memory test double.
- `src/persistence/sqlite-session-store.ts` — Reference replay/version/lease/effect-intent implementation; not the production monetary source of truth.
- `src/capabilities/scoped-tool-gateway.ts` — Durable intent-before-effect and explicit-unknown pattern for external effects.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `fingerprintSessionRequest`, `fingerprintSessionAction`, and `fingerprintEvidence` in `src/domain/session-action.ts` provide canonical hashing patterns for financial commands and safe evidence.
- `SessionStore` plus its SQLite/memory implementations establish replay-before-effect, exact/conflicting idempotency, version fencing, and explicit production-versus-test persistence seams.
- The durable worker lease and effect-intent flow demonstrates how to persist authority before external I/O and fence ambiguous outcomes rather than retrying blindly.
- Strict Zod schemas and immutable evidence writers provide boundary-validation and content-addressed record patterns.

### Established Patterns

- Parse all external data into strict normalized domain commands before acting.
- Keep transport/provider adapters unable to mutate durable authority directly.
- Treat duplicate delivery as normal; make exact replay durable and conflicting reuse fail closed.
- Persist intent before an external effect, and represent ambiguity explicitly.
- Store hashes, identifiers, and safe summaries instead of secrets or raw user/payment material.

### Integration Points

- A new ContextVM adapter authenticates and translates into the transport-neutral account/funding service; it must not call Phase 2 workers directly.
- Funded admission wraps the Phase 2 trusted-core entry seam with an account/cap reservation and capacity decision, while the worker remains financially powerless.
- Phase 4 consumes reservation and price-version identities to finalize exact usage; Phase 5 consumes top-up/account state for pause/resume; Phase 6 exposes status and user-owned publication through the same authenticated principal.

</code_context>

<specifics>
## Specific Ideas

- The user wants ContextVM to remain one interface/transport in v1 while the core stays ready for future x402 and L402 adapters.
- CEP-8 is the v1 top-up protocol; Lightning and Cashu fund one Nostr-linked prepaid account.
- Reaching the end of funds later pauses rather than fails, but the ten-minute live window and durable resume belong to Phase 5.
- Financial correctness must be fluid for users: duplicate network events quietly replay durable results, while ambiguous outcomes remain visible and safe instead of producing ceremonies or silent credits.

</specifics>

<deferred>
## Deferred Ideas

- Phase 4: exact API usage measurement, price-versioned debits, detailed usage ledger line items, and generation/revision actions.
- Phase 5: `needs_top_up`, the ten-minute live-worker window, checkpoint persistence, 30-day retention, and explicit resume.
- Phase 6: preview, user signing, manifest publication, and CVM attestation.
- Phase 7: production ContextVM/provider certification, measured five-second p95, multi-region failure/chaos proof, and launch hardening.
- v2: public x402 and L402 adapters over the same core.

</deferred>

---

*Phase: 3-ContextVM Funding & Funded Admission*
*Context gathered: 2026-08-04*
