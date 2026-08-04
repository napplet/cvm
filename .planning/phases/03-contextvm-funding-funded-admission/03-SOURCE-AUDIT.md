# Phase 03 Multi-Source Coverage Audit

| Source | ID | Feature / requirement | Plan | Status | Notes |
|---|---|---|---:|---|---|
| GOAL | — | Discover, fund, inspect, and authorize one Nostr-linked prepaid account without duplicate credit or undisclosed charge | 01, 03, 04, 05, 06, 07 | COVERED | Tracer, adapters, durable authority, final composition, and evidence |
| REQ | CTX-01 | Signed v1 capability discovery | 03, 07 | COVERED | Truthful CEP-6 announcement fixture |
| REQ | CTX-02 | Verified signed pubkey maps to one stable account without held secret | 01, 02, 03, 07 | COVERED | Verified principal and durable account uniqueness |
| REQ | CTX-03 | Durable redelivery/replay without repeated effect | 01, 02, 03, 07 | COVERED | Domain fingerprint plus SQL replay across instances |
| REQ | CTX-04 | ContextVM balance/session/pending/settlement status | 02, 03, 06, 07 | COVERED | Account-scoped combined redacted projection |
| REQ | PAY-01 | Separate CEP-8 top-up and mutually supported PMI | 03, 04, 05, 07 | COVERED | Exact Lightning/Cashu PMI intersection |
| REQ | PAY-02 | Settled BOLT11 top-up credits once | 04, 07 | COVERED | Service-owned authoritative receipt matrix |
| REQ | PAY-03 | Trusted-mint Cashu credits only after verified spendability | 05, 07 | COVERED | Pinned policy plus online swap |
| REQ | PAY-04 | Explicit visible top-up lifecycle | 01, 02, 03, 04, 05, 07 | COVERED | Legal/illegal transition and status cases |
| REQ | PAY-05 | Duplicate settlement/messages credit once | 01, 02, 04, 05, 07 | COVERED | Independent command/settlement/proof/posting constraints |
| REQ | PAY-06 | Versioned rotating multi-mint allowlist preserves history | 05, 07 | COVERED | Immutable policy versions and rotation fixture |
| REQ | PAY-07 | Treasury reconciliation cannot double-credit | 05, 07 | COVERED | Separate transition without credit method |
| REQ | BILL-01 | Explicit disclosed session maximum | 01, 03, 06, 07 | COVERED | Positive integer-sat cap schema and reply |
| REQ | BILL-02 | Authorization bounded by balance and remaining cap | 01, 02, 06, 07 | COVERED | Cap hold plus action-budget reservation |
| REQ | BILL-06 | Unused balance/cap remains user value | 01, 02, 06, 07 | COVERED | Holds/releases are not fees or exact usage |
| RESEARCH | R-01 | Thin ContextVM adapter over transport-neutral FundingService | 01, 03, 06 | COVERED | Import firewall and project-owned commands |
| RESEARCH | R-02 | Pinned SDK verified sender/correlation but no in-memory financial authority | 02, 03 | COVERED | Automated package evidence and durable replay |
| RESEARCH | R-03 | Exact Lightning and Cashu top-up PMIs; generation charging stays internal | 03, 04, 05 | COVERED | Announcement/negotiation and rail coordinators |
| RESEARCH | R-04 | PostgreSQL-wire serializable append-only double-entry ledger | 02 | COVERED | Migration, FundingStore adapter, conservation/race tests |
| RESEARCH | R-05 | Commands/settlements/proofs/postings/holds/outbox have independent uniqueness | 01, 02, 04, 05, 06 | COVERED | Canonical identity and SQL constraints |
| RESEARCH | R-06 | Intent-before-I/O and explicit reconciliation_pending | 02, 04, 05, 06 | COVERED | Provider/capacity effects never run in SQL retry |
| RESEARCH | R-07 | Service-owned authoritative Lightning receipt | 04 | COVERED | Full top-up/amount/unit/invoice/finality/reference match |
| RESEARCH | R-08 | Trusted-mint Cashu policy, keyset/DLEQ/proof checks, online swap | 05 | COVERED | cashu-ts adapter confinement and fixtures |
| RESEARCH | R-09 | Protected short-lived rail material and redacted status/evidence | 03, 04, 05, 06, 07 | COVERED | AES-GCM vault and recursive canary scan |
| RESEARCH | R-10 | Versioned multi-mint policy rotation without historical rewrite | 02, 05 | COVERED | Immutable SQL policy rows/registry |
| RESEARCH | R-11 | Treasury reconciliation is idempotent and cannot recredit | 05 | COVERED | Separate no-credit transition |
| RESEARCH | R-12 | Cap hold is min(requested, settled available), not fee/debit | 01, 02, 06 | COVERED | Boundary/concurrency/compensation tests |
| RESEARCH | R-13 | Immediate capacity or durable retryable refusal; no generation queue | 02, 06 | COVERED | ReadyCapacityPort and no-queue schema/test |
| RESEARCH | R-14 | Deterministic ContextVM/rail/database/capacity fakes and complete reference eval | 03, 04, 05, 06, 07 | COVERED | Provider-separated fixture/evidence architecture |
| RESEARCH | R-15 | API coverage inventory with explicit opt-outs | 03, 05, 07 | COVERED | Canonical `COVERAGE.md` plus detailed inventory |
| RESEARCH | R-16 | Missing live credentials/services remain blocked/unselected | 03, 06, 07 | COVERED | No false live/provider/SLO certification |
| CONTEXT | D-40 | ContextVM-only v1; verified sender principal | 01, 03, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-41 | Wire types stop at adapter; transport-neutral core | 01, 03, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-42 | Full truthful signed v1 announcement; no x402/L402 | 03, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-43 | Pubkey account; no password/private-key custody | 01, 03, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-44 | Serializable append-only relational ledger | 01, 02, 07 | COVERED | Cited in truths/actions; one-way rating retained |
| CONTEXT | D-45 | Command fingerprint plus independent uniqueness | 01, 02, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-46 | Separate CEP-8 top-up; Lightning/Cashu only | 03, 04, 05, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-47 | Normalized lifecycle and verified settlement before credit | 01, 04, 05, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-48 | Authoritative matched Lightning settlement | 04, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-49 | Safe status; no raw bearer/preimage/provider secret | 01, 03, 04, 05, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-50 | Versioned active multi-mint allowlist | 05, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-51 | Cashu mint/unit/keyset/proof/spendability/commitment verification | 05, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-52 | Treasury reconcile never posts second credit | 05, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-53 | Explicit cap and min(cap, available) hold; no fee | 01, 06, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-54 | Per-action authorization seam; exact usage remains Phase 4 | 01, 06, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-55 | Commit-or-reject funded immediate capacity; no queue/stranded hold | 01, 06, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-56 | At-least-once inputs, exactly-once business effects | 01, 02, 03, 04, 05, 06, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-57 | Intent before I/O; unknown effects are observed, not reissued | 02, 04, 05, 06, 07 | COVERED | Cited in truths/actions |
| CONTEXT | D-58 | Complete redacted account/top-up/cap/session/pending status | 03, 06, 07 | COVERED | Cited in truths/actions |
| CONTEXT | Deferred | Phase 4 exact usage/debits/generation/revision | — | EXCLUDED | Named only as prohibited authority/deferral |
| CONTEXT | Deferred | Phase 5 needs_top_up/live wait/checkpoint/resume/retention | — | EXCLUDED | Named only as prohibited authority/deferral |
| CONTEXT | Deferred | Phase 6 preview/signing/publication/attestation | — | EXCLUDED | Named only as prohibited authority/deferral |
| CONTEXT | Deferred | Phase 7 live SLO/multi-region/provider/provenance certification | — | EXCLUDED | Named as required later certification |
| CONTEXT | Deferred | Public x402/L402 adapters | — | EXCLUDED | Core seam preserved; no endpoint planned |

## Audit Result

- Phase goal: covered.
- Requirements: 14/14 appear in plan frontmatter and concrete task behavior.
- Locked decisions: D-40 through D-58, 19/19, are cited in executable plan bodies.
- Research implementation constraints: 16/16 covered.
- Same-wave plans 03-03, 03-04, and 03-05 have disjoint `files_modified` ownership.
- Deferred items have no implementation task.
- No source item is missing; no phase split is required.
