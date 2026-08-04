# Phase 3: ContextVM Funding & Funded Admission - Research

**Researched:** 2026-08-04
**Domain:** ContextVM/CEP-8 transport adapter, prepaid ledger, Lightning and trusted-mint Cashu settlement, funded admission
**Confidence:** MEDIUM — ledger and transaction patterns are established; ContextVM CEP-8 is draft/living and its Cashu direct-payment path is not implemented by the pinned SDK.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-40:** ContextVM is the only public v1 transport. A thin adapter verifies the signed event with the pinned SDK contract, derives the principal only from the verified sender public key, and maps it to one stable account. Payload-claimed identity is never authoritative.
- **D-41:** ContextVM announcement, request/reply, replay, and CEP-8/PMI types stop at the adapter boundary. Core account, top-up, ledger, cap, and admission commands remain transport-neutral for future x402/L402 adapters. — **Reversibility:** costly — leaking living protocol types into the financial core would require migrations and broad call-site rewrites.
- **D-42:** The signed v1 announcement advertises generation, account/status, top-up, session, preview, and publication capabilities. It does not expose working x402/L402 endpoints or claim unavailable later-phase operations are already implemented.
- **D-43:** The normalized Nostr public key is the stable account identity; no password, delegated user secret, or Nostr private key is held by the service.
- **D-44:** Monetary truth is a serializable, append-only relational ledger behind a transport-neutral port. Credits, holds/reservations, releases, settlement adjustments, idempotency records, and outbox records commit transactionally. Balance is a derived/maintained projection, never the sole source of truth. — **Reversibility:** one-way — changing ledger identity or posting semantics after value exists requires a financial-data migration and reconciliation.
- **D-45:** Every mutating core command binds account, command kind, client idempotency key, canonical payload fingerprint, and policy/version data. Exact replay returns the durable result; conflicting key reuse fails closed. Settlement and ledger posting references also have independent uniqueness constraints.
- **D-46:** CEP-8 exposes a separate top-up capability and negotiates only the mutually supported v1 rails: Lightning BOLT11 and Cashu. CEP-8 funds the prepaid account; it is not the generation-call charging mechanism.
- **D-47:** Both rails normalize into one explicit lifecycle: `pending → verifying → settled → credited`, or `failed`; ambiguous external outcomes enter `reconciliation_pending`. A top-up becomes spendable only after independently verified settlement and one atomic ledger credit.
- **D-48:** Lightning credit requires an authoritative settled receipt matched to the service-created top-up, expected amount, unit, invoice identity, expiry/finality policy, and stable settlement reference. Invoice creation, submission, or notification alone never credits value.
- **D-49:** Ordinary status responses show top-up ID, state, amount, unit, rail, timestamps, and a safe settlement reference. Raw Cashu tokens, proofs, Lightning preimages, provider secrets, and other bearer material never enter logs, general evidence, or public status payloads.
- **D-50:** Cashu acceptance requires a versioned active allowlist containing multiple trusted mints plus unit/keyset policy. A top-up pins the policy version used for its decision; rotating the active allowlist never rewrites historical settlement records.
- **D-51:** Cashu credit requires verified mint, unit, amount, keyset/proof structure, proof commitment, spendability/redeem outcome, and a unique settlement/proof commitment. Parsed or syntactically valid bearer tokens are not settled value.
- **D-52:** Treasury reconciliation is a separate idempotent state transition tied to the original credited top-up. It may record later mint/treasury movement or an explicit unknown state, but it cannot post a second user credit.
- **D-53:** Before the first billable action, the user explicitly approves a maximum in one disclosed integer currency unit. Admission atomically places a session-cap hold equal to the lesser of the requested cap and currently available settled balance. A hold is not a fee or debit; unused balance and cap remain the user's.
- **D-54:** Per-action authorization consumes availability under both the account hold and remaining approved cap, but exact provider-usage finalization, debit, line-item detail, and ambiguous provider reconciliation are implemented in Phase 4.
- **D-55:** Admission is commit-or-reject: the authenticated/idempotent command, funding reservation, and immediately usable capacity decision must agree in one coordinated flow. If capacity is unavailable, return a durable retryable refusal and leave no accepted queued work or stranded hold. Phase 7 measures the five-second p95 and certifies the provider.
- **D-56:** Duplicate relay delivery, client retry, payment notification, and settlement callback are normal at-least-once inputs. Exactly-once business effects come from durable command records, canonical fingerprints, unique external references, ledger constraints, and replay-before-effect lookup—not from assuming exactly-once delivery.
- **D-57:** Persist external settlement intent before I/O. Record a verified outcome or explicit `reconciliation_pending`; safe status queries may repeat, but an opaque/unknown payment creation, redemption, or credit effect is never blindly reissued.
- **D-58:** Account/status queries expose current available/held balance, approved caps, active or resumable session references, pending actions, and top-up/settlement states through ContextVM while preserving the redacted/hash-based evidence pattern established in Phase 2.

### the agent's Discretion

- Choose stable command/state/error names and exact schema layout while preserving the transitions and fail-closed semantics above.
- Choose the SQL query builder/migration layout and conservative serializable retry policy consistent with the project stack.
- Choose provider adapter interfaces for Lightning and Cashu after official contract research, provided no adapter can post ledger value directly.
- Choose safe display-reference formatting and retention/encryption details for protected rail-specific records.

### Deferred Ideas (OUT OF SCOPE)

- Phase 4: exact API usage measurement, price-versioned debits, detailed usage ledger line items, and generation/revision actions.
- Phase 5: `needs_top_up`, the ten-minute live-worker window, checkpoint persistence, 30-day retention, and explicit resume.
- Phase 6: preview, user signing, manifest publication, and CVM attestation.
- Phase 7: production ContextVM/provider certification, measured five-second p95, multi-region failure/chaos proof, and launch hardening.
- v2: public x402 and L402 adapters over the same core.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research support |
|---|---|---|
| CTX-01 | Signed announcement discovers v1 capabilities. | CEP-6 replaceable announcement and `cap`/`pmi` inventory below. |
| CTX-02 | Verified signed request maps pubkey to one account. | `NostrServerTransport` verified context plus normalized principal/account schema. |
| CTX-03 | Redelivery/replay returns durable result without repeated effects. | Command fingerprints, event identity, unique ledger/external references, replay-before-effect. |
| CTX-04 | Account/session/top-up status through ContextVM. | Redacted status projection and query contract. |
| PAY-01 | Separate CEP-8 top-up + mutually supported rail. | Explicit-gating/transparent protocol mapping and PMI compatibility rules. |
| PAY-02 | Settled BOLT11 top-up credits once. | Service-created invoice, authoritative receiver receipt, serializable credit transaction. |
| PAY-03 | Trusted-mint Cashu credits only after proof value/spendability verification. | Policy-version-pinned mint/keyset/unit checks, online receive/swap, proof commitment. |
| PAY-04 | Explicit top-up states visible. | Normalized lifecycle/state machine. |
| PAY-05 | Duplicate payments/messages credit once. | Independent command, settlement, proof, and ledger uniqueness constraints. |
| PAY-06 | Versioned multi-mint allowlist rotation. | Immutable policy versions referenced by each top-up. |
| PAY-07 | Cashu treasury reconciliation cannot double-credit. | Separate reconciliation event keyed to credited top-up. |
| BILL-01 | User approves a displayed maximum spend. | Integer-unit cap command and held-balance projection. |
| BILL-02 | Billable work cannot exceed balance/cap. | Funded-admission hold and Phase-4 authorization seam; no model action is admitted unfunded. |
| BILL-06 | Unused balance/cap remains user value. | Holds/release postings are not fees; exact debit is deferred. |
</phase_requirements>

## Summary

Implement Phase 3 as a transport-neutral `FundingService` backed by a PostgreSQL-wire serializable ledger. The ContextVM adapter is solely responsible for verified Nostr/CEP-8 wire translation and response correlation; it never owns an account balance, credits a top-up, or starts a worker. The pinned SDK's `NostrServerTransport` provides verified `clientPubkey`, request-event correlation, CEP-6 announcements, and CEP-8 message types, but its `AuthorizationStore` is explicitly in-memory/single-process. It is therefore a compatibility layer only, not a financial or replay authority. [CITED: https://docs.contextvm.org/reference/ts-sdk/transports/nostr-server-transport/] [CITED: https://docs.contextvm.org/reference/ceps/cep-8/]

Use one separate `top_up` tool whose CEP-8 payment request only funds prepaid value. Advertise `bitcoin-lightning-bolt11` and an implementation-versioned Cashu direct PMI (the current CEP-21 example is `bitcoin-cashu-v4-direct`, but it is illustrative rather than a normative registry), and select only a client-advertised supported rail. CEP-8 permits a server-side payment waiver for prepaid/internal accounting; generation calls must use that waiver only after the durable funded-admission reservation succeeds. Do not put actual-generation price or usage debits in CEP-8. [CITED: https://docs.contextvm.org/reference/ceps/cep-8/] [CITED: https://docs.contextvm.org/reference/ceps/informational/cep-21/]

**Primary recommendation:** Introduce one durable relational `FundingStore`/ledger port, one `FundingService`, Lightning and Cashu *verification* ports that return normalized settlement outcomes, and a thin ContextVM adapter. Persist an intent before every external rail operation; only the service's serializable credit transaction can make value spendable.

## Project Constraints (from AGENTS.md)

- Prefer the codebase-memory graph tools for code discovery; use literal/config search only when graph coverage is insufficient.
- Preserve the existing Phase 2 transport-neutral authority, strict Zod boundaries, replay-before-effect, durable fencing, and redacted/hash-based evidence pattern.
- Do not introduce ContextVM, CEP-8, Cashu, Lightning, worker-vendor, or database types into Phase 2 domain contracts.
- Use a GSD execution workflow for changes; this research performs no implementation change.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| ContextVM discovery, signed request/reply correlation | Nostr transport adapter | API/backend | SDK owns event validation/transport; adapter translates verified facts only. |
| Pubkey-to-account mapping and idempotent commands | API/backend | Database | Stable principal and replay results are business authority. |
| Ledger, balance projection, holds, settlement uniqueness | Database | API/backend | Serializable SQL is the money source of truth. |
| Lightning/Cashu verification and treasury movement | External payment adapter | API/backend | Rail adapters return evidence; service decides state/credit. |
| Immediate capacity decision/funded admission | API/backend | Worker allocator | Admission commits only an available-now capacity lease; never a queued task. |
| Status/read models and safe replies | API/backend | Nostr transport adapter | Queries expose projections, never bearer material. |

## Standard Stack

### Core

| Library | Version | Purpose | Why standard |
|---|---:|---|---|
| Bun | 1.3.14 locally | Runtime | Meets the SDK's declared `bun >=1.2.0` engine. [VERIFIED: npm registry/package metadata] |
| `@contextvm/sdk` | 0.13.10 | Signed ContextVM transport, announcement and CEP-8 types | Official SDK package/source, but its payment state is process-local; keep it at the edge. [WARNING: flagged as suspicious — verify frozen package/source before installing.] |
| `zod` | 4.4.3 | Strict adapter/domain/provider/persistence boundaries | Already installed and used by Phase 2. [VERIFIED: npm registry] |
| `kysely` + `pg` | 0.29.4 + 8.22.0 | Explicit typed PostgreSQL/Cockroach SQL transactions | Preserve visible isolation, constraints, and retry behavior. `kysely` is [WARNING: flagged as suspicious — verify frozen package/source before installing.] |
| `@cashu/cashu-ts` | 4.7.2 | Trusted-mint keyset/proof parsing and online receive/swap | Use only in the Cashu rail adapter; syntax/cryptographic parsing alone is insufficient. [WARNING: flagged as suspicious — verify frozen package/source before installing.] |

### Supporting

| Component | Use | Rule |
|---|---|---|
| Service-owned Lightning receiver/provider adapter | Create invoice, query its authoritative receiving settlement record | Provider receipt must bind top-up ID/invoice identity/amount/unit/finality/reference. No client-provided receipt is accepted. |
| `@contextvm/sdk` custom `PaymentProcessor` | CEP-8 wire request/verification compatibility | Invoke durable service `beginTopUp`/`observeSettlement`; never use SDK memory as idempotency or credit state. |
| Database transactional outbox | Dispatch invoice creation, settlement polling, Cashu receive/swap, and treasury reconciliation after intent commit | Consumers are at-least-once and must be idempotent. It is not a generation request queue. |

### Package Legitimacy Audit

| Package | Registry/source evidence | Verdict | Disposition |
|---|---|---|---|
| `@contextvm/sdk@0.13.10` | Official ContextVM docs/repository and npm tarball; no `postinstall`; published 2026-07-22 | SUS (new, low downloads) | Lock exact tarball integrity/source revision; planner must retain the required first-install `checkpoint:human-verify`. |
| `@cashu/cashu-ts@4.7.2` | Cashu project repository and npm tarball; no `postinstall`; published 2026-07-17 | SUS (new release) | Lock exact tarball integrity/source revision; planner must retain the required first-install `checkpoint:human-verify`. |
| `kysely@0.29.4` | Official Kysely repository and npm registry; no `postinstall`; published 2026-07-17 | SUS (new release) | Lock exact tarball integrity/source revision; planner must retain the required first-install `checkpoint:human-verify`. |
| `pg@8.22.0` | node-postgres repository/npm; no `postinstall` | OK | Approved. |
| `zod@4.4.3` | Already locked in project; no `postinstall` | OK | Retain exact existing pin. |

Packages removed due to SLOP: none. Do not float versions or substitute a lookalike package.

## Architecture Patterns

### System architecture

```text
signed Nostr event / relay redelivery
        |
        v
ContextVmAdapter -- verified pubkey + event id + normalized tool args --> FundingService
        |                                                               |
        | signed correlated redacted reply                              | serializable transaction
        v                                                               v
CEP-6 announcement / CEP-8 wire                                    FundingStore (Postgres)
                                                                  accounts / commands / ledger
                                                                  topups / policies / holds / outbox
                                                                        |
                         +----------------------+-----------------------+-----------------------+
                         |                      |                                               |
                         v                      v                                               v
                 LightningReceiptPort    CashuSettlementPort                           ReadyCapacityPort
                 invoice/status only     trusted mint online swap                      available-now or reject
                         |                      |                                               |
                         +-------------- normalized verified/unknown outcomes ----------+
                                                                        |
                                                                        v
                                                           one ledger credit or one hold
```

### Required boundaries and commands

```text
ContextVM wire DTO -> Zod parse -> AuthenticatedCommand
  { principalId, requestEventId, clientIdempotencyKey, commandKind,
    canonicalPayload, protocolVersion, paymentInteraction? }
                         |
                         v
FundingService -> FundingStore transaction -> durable ResultEnvelope
```

Use domain commands such as `EnsureAccount`, `BeginLightningTopUp`, `SubmitCashuTopUp`, `ObserveLightningSettlement`, `ObserveCashuSettlement`, `GetAccountStatus`, and `AdmitFundedSession`. They receive `Principal`/plain IDs, integer unit amounts, fingerprints, and opaque protected-reference IDs — never Nostr events, BOLT11 strings, Cashu proof/token fields, or provider SDK objects.

### Recommended schema and invariants

| Table/record | Mandatory keys and constraints | Purpose |
|---|---|---|
| `accounts` | `account_id`, unique normalized `nostr_pubkey`, `unit` | Stable public-key account, no password/secret. |
| `commands` | unique `(account_id, kind, client_idempotency_key)`, `payload_sha256`, durable result | Exact replay; same key/different fingerprint is `IDEMPOTENCY_CONFLICT`. |
| `ledger_entries` | immutable `entry_id`, unique `entry_reference`, debit/credit account IDs, integer amount/unit | Financial truth. Every posting balances by unit. |
| `account_balance_projection` | one per account/unit, updated in same transaction as entries | Read performance only; recomputable from ledger. |
| `top_ups` | `top_up_id`, account, rail, requested amount/unit, policy version, state, safe display reference | Lifecycle root; no raw bearer material. |
| `settlement_attempts` | unique rail external reference; unique Cashu proof commitment; top-up foreign key | Prevents duplicated settlement across notifications and retries. |
| `cashu_mint_policy_versions` / `cashu_mints` | immutable version; normalized mint URL, allowed unit/keyset rules, active interval | Allowlist rotation without rewriting history. |
| `protected_rail_material` | encrypted blob pointer, hash, access/audit metadata, short retention | Only temporary Cashu token/proof or Lightning sensitive material; never status/evidence/log fields. |
| `session_cap_holds` | unique session/admission reference, account, requested cap, held amount, `active/released/consumed` | Reserve `min(cap, settled available)`; not a fee. |
| `admissions` | unique session + command; capacity lease/reference, refusal state | Commit-or-reject record; no queued work state. |
| `outbox` | unique aggregate/event key, state/attempt/fence | Intent-before-I/O dispatch/reconciliation only. |

All amount columns are non-negative integer minor units (`sats` in v1) and all calculations are integers. Reject unit mismatch, zero/negative/overflow amounts, non-canonical pubkeys, and an account that already has an incompatible unit. A `balance` column alone is never sufficient evidence of money.

### State machines

```text
top-up:
pending -> verifying -> settled -> credited -> treasury_reconciled
                     \-> failed
                     \-> reconciliation_pending --(verified)--> settled

admission:
requested -> capacity_reserved -> funded_accepted
          \-> capacity_unavailable (durable retryable refusal; no hold/session)
          \-> insufficient_settled_funds (durable refusal; no hold/session)
```

`settled` is a verified rail fact; `credited` is the atomic local ledger mutation. They may be committed in one transaction with a state transition record but must remain distinguishable. A terminal unknown outcome remains `reconciliation_pending`, never a retry that can create a new payment/redeem effect.

### Transaction ordering

1. **Verified ContextVM command:** perform replay lookup by durable command scope before any provider/capacity call. Verify/normalize pubkey, map account, fingerprint semantic command payload, then insert/replay command within a serializable retry closure.
2. **Lightning top-up initiation:** persist `top_up` and an `invoice_create` intent before receiver I/O. The provider invocation uses the service-created `top_up_id` as its immutable label/idempotency reference. Persist its invoice identity/payment hash/expiry safely; return CEP-8 payment-required data. If creation is ambiguous, mark it `reconciliation_pending` and reconcile by that service reference; never issue another invoice blindly.
3. **Lightning credit:** poll/callback queries the authoritative receiver/wallet record. Verify `settled`, amount/unit, invoice identity/payment hash, expiry/finality policy, top-up reference, and stable provider settlement reference. In one serializable transaction: insert the unique settlement attempt, append balanced credit entries, update the projection, mark credited, persist reply/outbox. Duplicate notifications replay this result.
4. **Cashu top-up:** persist a top-up and protected payload pointer before mint I/O. Check active policy version, canonical mint URL, unit, keysets/keys, proof structure/amount, DLEQ policy, and unique proof commitment. Execute an online receive/swap through the trusted mint; parsed proof or offline cryptographic validation is not value. On successful swap/redeem, append the one credit in the same transaction that claims the proof commitment. A timeout/transport loss after swap is `reconciliation_pending`; query proof state/operation outcome and do not resubmit the proof.
5. **Treasury reconciliation:** outbox consumer writes an idempotent `treasury_reconcile` record keyed by the original credited top-up. It may record held-at-trusted-mint, melted/settled, failed, or unknown; it has no path to append a second account credit.
6. **Funded admission:** obtain an immediately usable, expiring *capacity reservation* synchronously (no durable work queue). In one serializable transaction replay/validate command, recompute settled available balance, hold `min(requested_cap, available)`, persist cap/admission/capacity reference and durable response. If capacity cannot be atomically committed with this authority, reject/compensate before reporting acceptance; do not place an allocation outbox message that converts acceptance into delayed work. Phase 4 consumes the accepted reservation before any worker/model action.

CockroachDB's default is `SERIALIZABLE`; retry only whole, side-effect-free database closures on SQLSTATE `40001`, bounded by a small attempt/deadline policy. External I/O belongs outside that closure and is driven from the committed intent/outbox. [CITED: https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference]

### ContextVM/CEP-8 mapping

| Wire surface | Phase 3 implementation | Never rely on |
|---|---|---|
| CEP-6 kinds `11316`–`11320` | Publish signed server/tool announcements containing only real v1 tools and capability metadata. | Announcement reachability as account authorization. |
| ContextVM kind `25910` request/reply | Use SDK-validated sender context and correlated request event ID. Store a separate durable replay result keyed by account/command/idempotency key. | SDK `seenEventIds` / memory sessions across replicas. |
| `pmi` tags | Advertise server-supported BOLT11 and versioned Cashu direct PMIs; choose an intersection with client PMIs. | A payload whose PMI is absent/unknown. |
| `cap` tags | Advertise top-up capability reference price/range only if it is truthful; use an exact payment-required amount for a service-created top-up. | `cap` as financial authorization or a generation usage price. |
| transparent flow | Correlate notifications by original outer request event ID; duplicate event is a durable replay. | Notification delivery as credit proof. |
| explicit gating | Support `-32042` required / `-32043` pending only through a durable authorization record; canonical identity is client pubkey + JCS method/params excluding `_meta`. | SDK `AuthorizationStore`, which is documented as single-process. |
| Cashu `direct_payment` | Parse one exact PMI-scoped raw request tag in the adapter, bind it to the verified request/account/top-up, then hand an encrypted protected reference to the Cashu port. Require exact paid amount; do not implement bearer change in v1. | The SDK types alone — current package declares direct tags but its middleware does not process them. |
| `payment_accepted` / status | Emit only credited/accepted status and safe reference; return ordinary tool result/replay afterwards. | Preimage/token/proof/provider secret in `_meta`, logs, status, or evidence. |

## Don't Hand-Roll

| Problem | Do not build | Use instead | Why |
|---|---|---|---|
| Nostr event signature/correlation/announcements | Custom Nostr serialization/verification | Pinned `NostrServerTransport` plus contract tests | Nostr signing, NIP-44 and event correlation are protocol-sensitive. |
| CEP-8 semantic request identity | Ad-hoc JSON stringify hash | SDK/JCS canonical identity at the adapter boundary | CEP-8 excludes `_meta` and envelope fields intentionally. |
| Cashu proof/keyset maths | Custom blind-signature/DLEQ implementation | Pinned `@cashu/cashu-ts` in Cashu adapter | Cryptographic and NUT compatibility surface is substantial. |
| Account balance correctness | Mutable balance updates | Append-only entries plus same-transaction projection | Enables conservation, replay, and reconciliation. |
| Cross-replica replay | In-memory Maps / SDK authorization cache | Unique SQL constraints + command results + settlements + outbox | Relay/provider delivery is at-least-once. |
| Transaction retry | Retrying an arbitrary callback with I/O | Short SQL-only retry closure | Retrying payment creation/redemption can mint a second external effect. |

## Common Pitfalls

### SDK payment middleware mistaken for a ledger

The published SDK declares its `AuthorizationStore` as in-memory and single-process, and its normal payment middleware tracks pending requests in memory. Use it only to speak CEP-8 or replace the payment middleware with an adapter that delegates to the durable funding service. Cross-replica duplicate events must remain harmless even after process loss. [VERIFIED: published @contextvm/sdk@0.13.10 declarations]

### Crediting an invoice or Cashu token too early

BOLT11 encodes a payment hash, and Cashu proofs can be syntactically valid, but neither proves the service has received/settled value. For Lightning, verify a service-owned invoice against the receiver's authoritative settled record. For Cashu, the official merchant guidance requires trusted-mint/amount/unit checks and an online swap before treating value as complete. [CITED: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md] [CITED: https://docs.cashu.space/merchants]

### Losing a bearer token or re-spending it after timeout

Cashu raw proof material is sensitive bearer value. Encrypt it only long enough for a persistent redemption/reconciliation workflow; hash/redact everywhere else. If a receive/swap outcome is unknown, check the mint's proof/operation state under the original intent rather than submitting the same proof again.

### Treating transparent and explicit CEP-8 retries alike

CEP-8 transparent retries identify the same outer Nostr event; explicit gating identifies canonical inner method/params plus pubkey. Keep both wire identities as correlation facts but use the domain's `(account, command, idempotency key, fingerprint)` record for business effects. [CITED: https://docs.contextvm.org/reference/ceps/cep-8/]

### Releasing or charging the cap incorrectly

The admission hold is not a fixed fee. Phase 3 may reserve it and return/release it on failed admission; Phase 4 alone converts bounded portions into exact measured debits. A larger requested cap is clamped to settled availability and disclosed as the accepted cap; it never causes overage or a hidden fee.

### Turning the outbox into a work queue

Settlement reconciliation is permissible post-commit asynchronous work. Generation admission is not: capacity must be available and committed in the request path or the reply is a retryable refusal with no session hold or queued generation record.

## Code Examples

### Domain outcome, not rail SDK objects

```ts
type VerifiedSettlement = Readonly<{
  topUpId: string;
  rail: "lightning_bolt11" | "cashu";
  amount: bigint;
  unit: "sat";
  externalReference: string;
  settlementCommitment: string;
  safeDisplayReference: string;
  policyVersion: string;
}>;

interface SettlementVerifier {
  verify(intentId: string): Promise<
    | { status: "verified"; settlement: VerifiedSettlement }
    | { status: "failed"; code: string }
    | { status: "unknown"; code: "RECONCILIATION_PENDING" }
  >;
}
```

Only `FundingService.creditVerifiedSettlement` accepts this value, and it must perform the unique-settlement insert, ledger entries, projection update, top-up state, command result, and outbox event in one serializable SQL transaction.

### Replay-before-effect transaction shape

```ts
await retrySerializable(async (trx) => {
  const replay = await commands.findExact(trx, accountId, kind, idempotencyKey);
  if (replay) return assertSameFingerprintOrConflict(replay, payloadSha256);

  await commands.recordIntent(trx, { accountId, kind, idempotencyKey, payloadSha256 });
  await outbox.insertUnique(trx, { aggregateId: topUpId, type: "lightning_invoice_create" });
  return commands.pendingResult(topUpId);
});
// Dispatcher performs provider I/O after commit. Its result is reconciled, never retried blindly.
```

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|---|---|---:|---:|---|
| Bun | SDK and tests | ✓ | 1.3.14 | None; required engine is >=1.2.0. |
| Node/npm | package verification | ✓ | Node 25.2.1 / npm 11.6.2 | Bun package management at implementation time. |
| ContextVM relay/signer credentials | live signed interoperability | ✗ | — | Deterministic transport fixtures; live provider certification remains Phase 7. |
| Lightning receiver/NWC credentials | real BOLT11 receipt verification | ✗ | — | Fake authoritative receiver contract for Phase 3; no claim of live rail certification. |
| Trusted Cashu mint/treasury credentials | live redemption/reconciliation | ✗ | — | Fake mint port and recorded fixtures; never call an unconfigured mint. |
| Cockroach/PostgreSQL service | production monetary persistence | ✗ | — | Test database/container or test-double only; production/provider selection remains unclaimed. |

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework | Bun test |
| Quick run | focused `bun test tests/funding` |
| Full suite | `bun test` |
| Required eval | `bun run eval:phase-03` (create deterministic reference set) |
| Required design slice | `bun run test:phase-03-design-slice` (create) |

### Requirement test map

| Requirement group | Required deterministic cases |
|---|---|
| CTX-01/02 | Signed announcement contains only v1 tools/PMIs; forged/payload pubkey cannot choose account. |
| CTX-03 | Same event, new-event same command, conflicting idempotency key, process reopen, and two-store race produce one result/effect. |
| CTX-04 | Status shows safe projection/top-up/session references and excludes every sensitive rail field. |
| PAY-01 | No common PMI rejects before rail I/O; BOLT11 and Cashu direct negotiation choose one allowed rail. |
| PAY-02/05 | Invoice creation ambiguity, duplicate callback, callback-before-retry, wrong amount/unit/invoice/expiry/reference, and crash after provider success credit exactly once or reconcile. |
| PAY-03/06/07 | Untrusted/rotated mint, wrong unit/keyset, malformed/DLEQ-invalid proof, duplicate proof, successful swap, timeout-after-swap, and reconcile event never double-credit. |
| PAY-04 | Every legal/illegal top-up transition and redacted status response. |
| BILL-01/02/06 | Invalid/overflow cap, clamp to available, two concurrent admissions, capacity refusal, retry replay, release, and no model/worker allocation without an active hold. |

### Phase gate

- Full suite is green.
- A deterministic fake ContextVM transport proves signature-derived principal, correlated reply, transparent and explicit CEP-8 identity handling, and duplicate relay redelivery.
- Fake Lightning and Cashu adapters produce verified/failed/unknown outcomes; no fake may call the ledger directly.
- Ledger conservation test recomputes balance projection from entries, finds one credit per unique settlement/proof commitment, and finds no stranded active hold after refusal.
- API coverage artifact remains complete and each opted-out SDK capability has a deliberate reason.
- Live ContextVM/Lightning/Cashu interoperability is recorded as blocked/unselected if credentials are unavailable; it must not be relabelled passed.

## Security Domain

| ASVS category | Applies | Control |
|---|---|---|
| V2 Authentication | Yes | Verified Nostr sender pubkey only; no password/user private-key custody. |
| V3 Session Management | Yes | Durable command/request correlation and replay results; no relay-memory session authority. |
| V4 Access Control | Yes | Account-scoped commands/status; adapter-to-core principal binding; worker remains powerless. |
| V5 Input Validation | Yes | Strict Zod schemas for wire tags, amounts, IDs, event metadata, receipt facts, and status responses. |
| V6 Cryptography | Yes | Pinned Nostr/Cashu libraries; encrypted protected rail material; no custom signature/proof crypto. |

| Threat | Mitigation |
|---|---|
| Forged claimed pubkey or request metadata | Use SDK-verified sender context and signed event identity; ignore payload identity. |
| Relay/redelivery/restart duplicate credit | Durable command replay, unique settlement/proof/ledger references, serializable transaction. |
| Invoice created/paid but persistence fails | Intent-before-I/O and reconciliation by immutable service reference. |
| Cashu bearer token exfiltration | No logs/status/evidence raw value; encrypted short-lived protected material; no changes in v1. |
| Mint/keyset rotation or malicious mint | Immutable policy version on top-up; multiple configured trusted mints, URL/unit/keyset checks, online swap, no global acceptance. |
| Cap race/overspend | Account-level serializable admission/hold and Phase 4 authorization seam; integer units only. |
| Hidden queue | Capacity decision in admission path; refusal does not leave hold/session work. |
| SDK/payment type leaking inward | Import firewall tests: core/funding contracts cannot import ContextVM, Nostr, Cashu, Lightning, or worker provider modules. |

## Later-Phase Boundaries

- **Phase 4:** price-versioned per-action provider authorization/finalization, exact usage debits, usage line items, generation/revision and repair. Phase 3 creates the reservation/cap contract only and must not simulate a completed usage debit.
- **Phase 5:** insufficient-funds `needs_top_up`, ten-minute live worker, checkpoint/retention, explicit resume. A Phase 3 top-up changes balance only; it never resumes work.
- **Phase 6:** preview, manifest signing, deployment, attestation.
- **Phase 7:** live multi-region/provider certification, relay/rail outage proof, production receipt-to-worker-ready SLO, package/provenance promotion. Modal remains an unselected Phase 2 candidate and is not a Phase 3 dependency.
- **v2:** x402/L402 remain adapters to the same command/settlement/funding ports; do not expose them now.

## Assumptions Log

| # | Claim | Risk if wrong |
|---|---|---|
| A1 | The service will use the CEP-21 illustrative `bitcoin-cashu-v4-direct` PMI or an equivalently versioned documented Cashu PMI. | Client interoperability; freeze actual PMI in fixtures before public launch. |
| A2 | The selected Lightning receiver exposes a stable service-side settled receipt/reference. | Cannot safely credit; keep rail unconfigured rather than infer settlement. |
| A3 | The selected Cashu treasury can retain protected received proofs and execute/observe online swaps. | Cashu rail remains unavailable; do not credit from parsing alone. |

## Sources

### Primary / official

- [ContextVM CEP-8](https://docs.contextvm.org/reference/ceps/cep-8/) — draft pricing/PMI/explicit-gating/direct-payment/correlation rules.
- [ContextVM CEP-6](https://docs.contextvm.org/reference/ceps/cep-6/) — signed replaceable server and capability announcements.
- [ContextVM server transport](https://docs.contextvm.org/reference/ts-sdk/transports/nostr-server-transport/) and [published SDK source](https://github.com/ContextVM/sdk) — transport boundary and pinned package implementation inventory.
- [Cashu merchant guidance](https://docs.cashu.space/merchants) and [Cashu protocol](https://docs.cashu.space/protocol) — trusted mint validation, online swap, proof/keyset model.
- [Cashu NUT-03 swapping](https://cashubtc.github.io/nuts/03/) — receive/swap consumes inputs and produces fresh outputs.
- [BOLT 11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md) — invoice/payment-hash and signature semantics.
- [CockroachDB transaction retry guidance](https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference) — serializable retry requirements.

## Metadata

**Confidence breakdown:**

- ContextVM/CEP-8 wire behavior: MEDIUM — official draft/docs and pinned declarations, must be fixture-tested.
- Ledger/serializable/outbox design: HIGH — established database pattern, verified against Cockroach transaction guidance.
- Lightning settlement contract: MEDIUM — BOLT11 format is authoritative but receiver-provider receipt fields are selected implementation details.
- Cashu settlement: MEDIUM — official merchant guidance confirms online swap requirement; exact mint/treasury adapter must be fixture-tested.

**Valid until:** 7 days for ContextVM/Cashu package/CEP facts; 30 days for SQL architecture.
