# Phase 3: ContextVM Funding & Funded Admission - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-04
**Phase:** 3-ContextVM Funding & Funded Admission
**Mode:** `--auto` single pass
**Areas discussed:** Signed identity and transport boundary, account and ledger authority, CEP-8 top-up lifecycle, Cashu mint and treasury reconciliation, funded admission and session cap, replay/ambiguity/evidence

---

## Signed Identity and Transport Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Thin adapter into transport-neutral core | SDK verifies the signed event; only normalized principal/domain commands cross the adapter boundary. | ✓ |
| ContextVM types throughout domain | Couple financial/session state directly to living ContextVM and CEP-8 wire types. | |
| Multiple public transports in v1 | Implement ContextVM, x402, and L402 together. | |

**Auto-selected choice:** Thin adapter into transport-neutral core.
**Notes:** Preserves the locked ContextVM-only v1 surface and Phase 2 D-23.

## Account and Ledger Authority

| Option | Description | Selected |
|--------|-------------|----------|
| Serializable append-only ledger | Immutable postings and outbox commit together; balance is a projection. | ✓ |
| Mutable balance rows | Treat one balance column as financial truth. | |
| Adapter-owned balances | Let protocol handlers maintain account state. | |

**Auto-selected choice:** Serializable append-only ledger.
**Notes:** Required for duplicate settlement, holds, reconciliation, and later exact usage.

## CEP-8 Top-Up Lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| Verified normalized settlement | Both rails share explicit states; only verified settlement produces one credit. | ✓ |
| Credit on payment submission | Make invoice/token submission immediately spendable. | |
| Credit on notification | Trust callback receipt without independent settlement verification. | |

**Auto-selected choice:** Verified normalized settlement.
**Notes:** CEP-8 remains a separate funding capability, not per-call charging.

## Cashu Mint and Treasury Reconciliation

| Option | Description | Selected |
|--------|-------------|----------|
| Versioned allowlist and commitments | Pin mint policy, verify proofs/spendability, dedupe commitments, reconcile treasury separately. | ✓ |
| Accept any syntactically valid mint | Treat parse success as trusted value. | |
| One immutable mint | Avoid rotation and multi-mint history. | |

**Auto-selected choice:** Versioned allowlist and commitments.
**Notes:** Historical records retain their original policy/version when the active allowlist rotates.

## Funded Admission and Session Cap

| Option | Description | Selected |
|--------|-------------|----------|
| Transactional hold and admit-or-reject | Reserve the lesser of cap/balance and require immediate usable capacity; otherwise refuse without queued work. | ✓ |
| Charge cap upfront | Turn the approved maximum into a fixed fee. | |
| Balance check without hold | Permit concurrent work to race on the same funds. | |

**Auto-selected choice:** Transactional hold and admit-or-reject.
**Notes:** Exact debits are Phase 4; measured p95 certification is Phase 7.

## Replay, Ambiguity, and Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Durable intent and reconciliation | Persist before I/O, record verified/unknown outcomes, and never blindly repeat ambiguous value effects. | ✓ |
| Blind retry | Retry opaque failures as fresh payment or redemption operations. | |
| Notification equals success | Treat receipt of a network event as settled value. | |

**Auto-selected choice:** Durable intent and reconciliation.
**Notes:** Carry forward Phase 2 replay/effect-intent and redacted-evidence patterns.

## the agent's Discretion

- Exact state/error names and schema organization.
- SQL migration/query layout and conservative serializable retry mechanics.
- Provider adapter interfaces after current official protocol research.
- Safe settlement-reference presentation and protected-record retention details.

## Deferred Ideas

- Exact usage charging — Phase 4.
- Ten-minute funding pause and 30-day resume — Phase 5.
- Preview/publication — Phase 6.
- SLO, multi-region, and launch certification — Phase 7.
- x402/L402 public adapters — v2.
