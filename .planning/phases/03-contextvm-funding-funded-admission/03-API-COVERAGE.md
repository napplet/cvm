# Phase 03 ContextVM, CEP-8, and Cashu API Coverage

**Pinned research target:** `@contextvm/sdk@0.13.10`; `@cashu/cashu-ts@4.7.2`
**Boundary:** ContextVM/CEP-8/Cashu objects stop in adapters. `FundingService` accepts only normalized authenticated commands and verified settlement outcomes.
**Status:** design inventory — not a claim that a live rail/provider is selected or certified.

## ContextVM SDK coverage

| Capability | Decision | Phase 3 treatment |
|---|---|---|
| `NostrServerTransport` signed inbound event processing | INTEGRATE | Derive principal only from SDK-verified `clientPubkey`; independently persist replay result. |
| `onmessageWithContext` | INTEGRATE | Receive verified client pubkey at adapter boundary. Configure exactly one message callback to avoid duplicate dispatch. |
| `injectRequestEventId` + `getNostrRequestEvent` | INTEGRATE | Correlate raw signed event/tag data to a tool call; retain only safe hashes/IDs in core. |
| `isAnnouncedServer`, CEP-6 server/tool lists | INTEGRATE | Publish signed v1-only discovery; update when capability availability changes. |
| `setAnnouncementExtraTags` | INTEGRATE | Advertise selected PMIs and optional payment-interaction capability. |
| `setAnnouncementPricingTags` / `cap` tags | INTEGRATE | Advertise truthful top-up discovery metadata only; never use as ledger authorization. |
| `sendTargetedResponse`, `sendNotification`, correlated `e` tags | INTEGRATE | Return redacted status and CEP-8 flow messages correlated to original request. |
| `PaymentProcessor` interface | INTEGRATE | Custom Lightning/Cashu processors delegate create/verify to durable service commands; processors cannot credit directly. |
| CEP-8 `PaymentRequired`, `PaymentAccepted`, `PaymentRejected`, `pmi` types | INTEGRATE | Strictly validate/emit wire DTOs at adapter edge. |
| `PaymentInteractionMode` | INTEGRATE | Support transparent default and explicit-gating only when effective mode is disclosed/accepted. |
| `computeCanonicalInvocationIdentity` | INTEGRATE | Use only as CEP-8 explicit-gating wire identity; retain domain command fingerprint separately. |
| `direct_payment` tag type | INTEGRATE WITH CUSTOM PARSER | Extract one exact Cashu direct payload from the verified raw event, bind it to top-up/account, encrypt it, then dispatch to Cashu port. |
| `change` tag | OPT-OUT | Require exact Cashu top-up amount in v1; returning bearer change expands custody and raw-token outbound handling. |
| `withServerPayments` | ADAPTER-ONLY | May provide CEP-8 wire interoperability around custom durable processors; never becomes authorization, replay, or credit authority. |
| `AuthorizationStore` | OPT-OUT | Explicitly in-memory/single-process in SDK declarations; unsuitable for replicas or financial effects. |
| built-in `LnBolt11NwcPaymentProcessor` | OPT-OUT | Its NWC provider connection/status is not the selected durable service-owned Lightning receipt port. |
| built-in LNBits/Zap processors and client handlers | OPT-OUT | v1 server accepts service-defined Lightning top-ups only; clients retain wallet/key custody. |
| client `withClientPayments` / handlers | OPT-OUT | Service is a server; client wallet behavior is not service authority. |
| SDK in-memory seen-event/session/correlation stores | OPT-OUT AS AUTHORITY | Helpful transport optimization only; durable SQL command records govern effects across replicas/restarts. |
| `PrivateKeySigner` for users | FORBIDDEN | CVM never receives/stores a user's Nostr private key. Server signing key stays host-side, outside worker/core. |
| open streams, oversized transfer, proxy/gateway surfaces | OPT-OUT | No need for payment admission; bounded text tools only. |

## Cashu library/protocol coverage

| Capability | Decision | Phase 3 treatment |
|---|---|---|
| Token/proof parsing | INTEGRATE | Parse only inside Cashu adapter after size limit; never log/raw-store in normal records. |
| `Wallet.loadMint`, mint info, keysets, keys | INTEGRATE | Fetch/verify active trusted mint metadata and keyset policy before redemption. |
| Keyset ID/unit/active verification | INTEGRATE | Match the top-up's immutable policy version; reject unknown/inactive/wrong-unit keysets. |
| DLEQ verification / `requireDleq` | INTEGRATE | Apply strict configured proof/keyset policy; DLEQ does not replace online spendability verification. |
| Receive/swap `prepare` + `completeSwap` | INTEGRATE | Persist intent before mint I/O; online swap is the settlement gate before user credit. |
| Proof state query/stream | INTEGRATE | Reconcile timeout/ambiguous redemption using original proof commitment, never a blind re-submit. |
| `Melt`/BOLT11 treasury conversion | DEFERRED | Phase 3 records automated treasury reconciliation state; operational melt policy is not required to credit an already-swapped trusted-mint top-up. |
| Deterministic wallet seed/counters | OPT-OUT | Do not make per-user Cashu wallets or store user seeds; treasury key material stays in protected rail adapter only. |
| P2PK/HTLC/NUT-11 user proof flows | OPT-OUT | No v1 user wallet custody contract; reject unsupported proof conditions by policy. |
| Token change return | OPT-OUT | Exact amount only; no bearer change delivery in v1. |

## PostgreSQL/Cockroach/Kysely coverage

| Capability | Decision | Phase 3 treatment |
|---|---|---|
| `SERIALIZABLE` transactions | INTEGRATE | All account/command/settlement/ledger/hold mutations. |
| SQLSTATE `40001` retry | INTEGRATE | Retry bounded SQL-only closure, never provider I/O. |
| unique indexes/constraints | INTEGRATE | Command scope, settlement reference, proof commitment, ledger reference, active admission/hold, and outbox aggregate/event. |
| transactional outbox | INTEGRATE | Rail/reconciliation side effects after intent commit; no generation queue. |
| mutable balance as source of truth | FORBIDDEN | Projection is updated transactionally and recomputed from append-only postings. |

## Evidence contract

Record package versions/integrity, protocol/policy versions, normalized pubkey hash, command/request/event IDs, selected PMI, top-up ID/state, amount/unit, safe display/settlement reference hash, policy version, ledger/outbox IDs, capacity decision, and test fixture outcome. Exclude Nostr private keys, Cashu token/proofs/secrets, Lightning preimages, NWC/provider credentials, invoice payloads when unnecessary, prompts, and raw event content.

## Required fixture gates

1. Pinned SDK transport: valid signature/context, forged sender, announcement tags, request/reply correlation, same event replay, and cross-replica redelivery.
2. CEP-8: no PMI intersection, transparent `e` correlation, explicit `-32042/-32043` canonical identity, effective-mode rejection, and price waiver after funded reservation.
3. Lightning: service-created invoice only; duplicate/late/wrong receipt, paid-before-write crash, and reconciliation.
4. Cashu: policy/mint/keyset/unit/DLEQ/proof rejection, online swap success, duplicate proof, timeout-after-swap, and no second credit from treasury reconciliation.
5. Ledger/admission: double-entry conservation, command conflict, serializable race/retry, cap clamp/release, capacity refusal, and no queued worker work.
