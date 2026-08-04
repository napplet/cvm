---
phase: 03-contextvm-funding-funded-admission
audited: 2026-08-04T17:38:00Z
status: secured
asvs_level: 1
block_on: high
threats_closed: 30/32
threats_open_blocking: 0
threats_open_non_blocking: 2
reviewed_through: b1e3486
---

# Phase 03 Security Audit

## Verdict

**SECURED** — all high-severity Phase 3 threats are mitigated at the offline design boundary. Two medium evidence-correlation gaps remain explicit and non-blocking. Live ContextVM, Lightning, Cashu, PostgreSQL, capacity-provider, and Modal certification remains blocked and unselected until Phase 7.

## Threat Verification

| Threat | Severity | Status | Implemented evidence |
|---|---:|---|---|
| T-03-01 | high | Closed | Only the SDK-verified Nostr public key becomes the principal. |
| T-03-02 | high | Closed | Canonical command fingerprints and transactional replay prevent repeated state changes. |
| T-03-03 | high | Closed | Public adapters receive narrow funding/status/admission facades, not store mutation authority. |
| T-03-04 | high | Closed | Strict schemas, owner-scoped projections, reply allowlists, and recursive evidence scans constrain disclosure. |
| T-03-02-SC | high | Closed | ContextVM, Cashu, SQL, and PostgreSQL packages are exactly pinned and intake-verified. |
| T-03-05 | high | Closed | Serializable SQL transactions bind command results, postings, projection, and outbox effects. |
| T-03-06 | medium | Closed | SQL connection, query, retry count, and total retry duration are bounded. |
| T-03-07 | high | Closed | The database adapter alone owns SQL credentials; rail modules use narrow lifecycle and vault ports. |
| T-03-08 | medium | Closed | Durable command, settlement, admission, capacity, hold, action-budget, and outbox identities exist. |
| T-03-09 | high | Closed | ContextVM identity derives from verified SDK context rather than request payload fields. |
| T-03-10 | high | Closed | Request, PMI, interaction, and direct-payment tag parsing is strict and fail closed. |
| T-03-11 | medium | Open — non-blocking | The original ContextVM request-event ID routes replies but is not durably stored with the funding command/result. |
| T-03-12 | high | Closed | Top-up wire replies are explicitly allowlisted and cannot spread invoice, token, proof, or provider fields. |
| T-03-03-SC | high | Closed | ContextVM/CEP-8 imports remain confined to the transport bridge. |
| T-03-13 | high | Closed | Lightning credit requires a fully matched, final, unexpired authoritative receipt. |
| T-03-14 | medium | Closed | Durable Lightning and Cashu lifecycle state is correlated and owner scoped. |
| T-03-15 | high | Closed | AES-GCM protected-material storage binds account, top-up, and rail metadata. |
| T-03-16 | high | Closed | Rail providers return observations only; the coordinator and funding authority own credit. |
| T-03-17 | high | Closed | Cashu amount, mint, unit, policy, keyset, proof, DLEQ, and condition checks precede credit. |
| T-03-18 | high | Closed | Public composition constructs the database-backed encrypted vault; bearer material is never returned. |
| T-03-19 | high | Closed | Proof commitments fence replay; abort-aware swap ambiguity is reconciled by query of the original protected token, never another swap. |
| T-03-20 | high | Closed | The Cashu adapter has no ledger or credit authority. |
| T-03-05-SC | high | Closed | `@cashu/cashu-ts` is pinned and adapter confined. |
| T-03-21 | high | Closed | Server-owned capacity dispatch and funded holds are transactionally fenced; compensation runs even when pre-release persistence fails. |
| T-03-22 | medium | Closed | Capacity and rail calls are deadline/abort bounded; ambiguous outcomes persist for query-only reconciliation. |
| T-03-23 | high | Closed | Action budgets require an account-scoped active hold and expose no worker financial authority. |
| T-03-24 | high | Closed | Cashu replay and all lifecycle/status reads are owner scoped. |
| T-03-25 | medium | Open — non-blocking | No single durable evidence record yet correlates every command, capacity intent, hold, action budget, result, and evidence identity. |
| T-03-26 | high | Closed | Each fixture executes an independent scenario/evidence oracle; mutation of fixture-controlled expectations is rejected. |
| T-03-27 | medium | Closed | Design evidence requires the complete declared requirement, decision, threat, provider, and identity mapping. |
| T-03-28 | high | Closed | Recursive forbidden-field and value scanning rejects bearer material in evidence. |
| T-03-29 | high | Closed | Blocked or failed provider observations cannot claim selection or certification. |

## Reconciliation and Compensation Integrity

- Lightning and Cashu operations receive server-owned abort signals. A timeout becomes durable reconciliation rather than a blind retry.
- The default Cashu adapter binds abort to the actual mint request and reconciles possible proof consumption through proof-state query of the encrypted original token.
- Capacity reservation is server owned and immediate. Every post-reservation failure enters compensation; a failed pre-release fence write cannot suppress external release.
- If released-state persistence fails after confirmed release, durable dispatch/reconciliation state fences retry from trusting stale availability.
- Regression cases cover `FAIL_4` and `FAIL_5`: one reserve, one release, no hold, no acceptance, and fail-closed retries.

## Validation

- `bun test` — 266 pass, 0 fail, 1,172 expectations.
- `bun run eval:phase-03` — 22 pass, including 19 exact fixture scenarios and expectation-mutation rejection.
- `bun run test:phase-03-design-slice` — design-ready; all six live providers remain blocked/unselected.
- Code review — clean through `b1e3486`, 0 blockers and 0 warnings.
- Goal verification — passed, 5/5 must-haves and all 14 Phase 3 requirements.

## Explicit Deferrals

- T-03-11 and T-03-25 remain medium, non-blocking evidence-correlation work.
- No live rail, relay, database, capacity, worker-provider, regional, or readiness-SLO certification is claimed.
- Production provider selection, chaos/load testing, and launch certification remain Phase 7 gates.

**Blocking threats open:** 0
