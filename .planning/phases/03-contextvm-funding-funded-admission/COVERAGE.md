# API Coverage — ContextVM, CEP-8, Cashu, and PostgreSQL

> Full coverage by default. Opt-outs are explicit, reasoned decisions. Detailed adapter treatment remains in `03-API-COVERAGE.md`.

| capability | decision | reason |
|---|---|---|
| ContextVM `NostrServerTransport` signed inbound processing | INTEGRATE | |
| ContextVM `onmessageWithContext` verified sender callback | INTEGRATE | |
| ContextVM request-event injection and raw signed-event correlation | INTEGRATE | |
| CEP-6 announced server and tool lists | INTEGRATE | |
| ContextVM announcement extra PMI/payment-interaction tags | INTEGRATE | |
| ContextVM truthful top-up `cap` discovery tags | INTEGRATE | |
| ContextVM targeted responses, notifications, and correlated event tags | INTEGRATE | |
| CEP-8 custom `PaymentProcessor` boundary | INTEGRATE | |
| CEP-8 required, accepted, rejected, pending, and PMI wire DTOs | INTEGRATE | |
| CEP-8 transparent and explicit-gating interaction modes | INTEGRATE | |
| CEP-8 canonical invocation identity | INTEGRATE | |
| CEP-8 Cashu `direct_payment` tag with project-owned strict parser | INTEGRATE | |
| ContextVM `withServerPayments` adapter wrapper | INTEGRATE | |
| CEP-8 Cashu bearer `change` response | OPT-OUT | Exact-amount top-ups avoid outbound bearer custody and change handling. |
| SDK `AuthorizationStore` as business authority | OPT-OUT | It is in-memory and single-process; durable SQL commands govern financial effects. |
| SDK built-in NWC BOLT11 processor | OPT-OUT | The service-owned receiver port must supply the authoritative settled receipt contract. |
| SDK built-in LNBits/Zap processors | OPT-OUT | The service accepts only its configured service-owned Lightning receiver. |
| SDK client payment handlers and wallet behavior | OPT-OUT | napplet-cvm is the server and never takes user wallet/key custody. |
| SDK in-memory seen-event, session, and correlation stores as authority | OPT-OUT | They may optimize transport only; cross-replica effects use durable command records. |
| SDK user `PrivateKeySigner` | OPT-OUT | The CVM never receives or stores a user's Nostr private key. |
| ContextVM open streams, oversized transfer, proxy, and gateway surfaces | OPT-OUT | Phase 3 exposes bounded account, top-up, status, and admission commands only. |
| Cashu token and proof parsing | INTEGRATE | |
| Cashu mint loading, info, keysets, and keys | INTEGRATE | |
| Cashu keyset ID, unit, active-state, and pinned-policy validation | INTEGRATE | |
| Cashu configured DLEQ verification | INTEGRATE | |
| Cashu online receive/swap prepare and completion | INTEGRATE | |
| Cashu proof-state query for reconciliation | INTEGRATE | |
| Cashu treasury melt/BOLT11 conversion | OPT-OUT | Phase 3 records treasury reconciliation state; operational melt policy is outside the user-credit contract. |
| Cashu deterministic user wallet seed and counters | OPT-OUT | The service does not create or custody per-user Cashu wallets or seeds. |
| Cashu P2PK, HTLC, and unsupported proof-condition flows | OPT-OUT | No user-wallet custody contract exists; unsupported conditions fail policy validation. |
| Cashu bearer change return | OPT-OUT | The v1 top-up rail requires exact amount and never returns bearer change. |
| PostgreSQL/Cockroach `SERIALIZABLE` transactions | INTEGRATE | |
| PostgreSQL SQLSTATE `40001` bounded SQL-only retry | INTEGRATE | |
| PostgreSQL unique financial-effect constraints | INTEGRATE | |
| PostgreSQL transactional settlement/reconciliation outbox | INTEGRATE | |
| Mutable balance column as source of truth | OPT-OUT | Append-only balanced postings are authoritative; the balance is a same-transaction recomputable projection. |
