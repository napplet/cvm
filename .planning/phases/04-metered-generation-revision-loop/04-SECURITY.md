---
phase: 04
slug: metered-generation-revision-loop
status: verified
threats_open: 0
asvs_level: 1
created: 2026-08-05
---

# Phase 04 — Security

> ASVS L1 verification of the threat registers authored in Plans 04-01 through 04-07.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| User/ContextVM → coordinator | Signed but untrusted bounded text requests paid state changes. | identity, idea/revision, idempotency key, cap, version |
| Coordinator → provider/worker | Only a persisted, budgeted operation may cause a billable or build effect. | operation intent, approved task data, short-lived authority |
| Provider/worker → financial and artifact authority | Untrusted receipts and generated output may affect money or artifact lineage only after strict verification. | normalized usage, safe evidence reference, candidate files |
| Durable state → owner status | Complete financial/session state is reduced to a bounded owner-only projection. | balances, caps, lifecycle, immutable line items |
| Fixture/runtime → release evidence | Expected values cannot manufacture observed facts or a passing immutable record. | case facts, runtime observations, canonical evidence digest |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation evidence | Status |
|-----------|----------|-----------|----------|-------------|---------------------|--------|
| T-04-PRICE | Tampering | receipt pricing/finalization | high | mitigate | Pinned profile/card identity, bigint rational pricing, ceiling enforcement; `price-card.test.ts`, `operation-finalization.test.ts`. | closed |
| T-04-EFFECT | Repudiation | provider dispatch | high | mitigate | Persisted operation identity and claim precede I/O; tracer and revision replay counters. | closed |
| T-04-AUTHORITY | Elevation of privilege | provider/worker boundaries | high | mitigate | Coordinator-owned gateway, pricing, worker, verifier, and finalizer composition. | closed |
| T-04-INPUT | Denial of service | session admission | medium | mitigate | Phase 2 bounded-input gate runs before budget/provider/worker effects; tracer rejection test. | closed |
| T-04-DISCLOSE | Information disclosure | result/evidence records | medium | mitigate | Safe normalized fields and protected evidence references; status/evidence canary tests. | closed |
| T-04-SC | Tampering | promoted dependencies/toolchain | high | mitigate | No Phase 4 dependency change; pinned project-owned adapters and promoted napplet workflow remain gated. | closed |
| T-04-ATOMIC | Tampering | metered finalization | high | mitigate | Serializable transaction, deterministic locks, unique identities, conservation checks, rollback/failpoint tests. | closed |
| T-04-REPLAY | Repudiation | receipts/postings/results | high | mitigate | Durable unique keys and canonical terminal replay prevent duplicate debit, release, result, or artifact advance. | closed |
| T-04-EVIDENCE | Tampering / disclosure | history and design evidence | high | mitigate | Owner-scoped bounded history plus canonical create-or-verify evidence; standalone validation re-derives and canonically compares all derived fields. | closed |
| T-04-RETRY | Denial of service | SQL/provider retry | medium | mitigate | Bounded SQL retry and original-operation-only provider recovery; no external effect in transaction retries. | closed |
| T-04-QUARANTINE | Tampering | invalid receipt | high | mitigate | Unpriceable/over-ceiling/mismatched receipts cannot debit and quarantine the profile/card pair. | closed |
| T-04-AMBIGUITY | Tampering | provider timeout/loss | high | mitigate | `usage_unknown` blocks later paid actions; persisted original intent is reconciled without redispatch. | closed |
| T-04-DOUBLE | Repudiation | concurrent reconciliation | high | mitigate | Reconciliation claim, unique receipt/finalization identities, and terminal reread; concurrency tests show one posting. | closed |
| T-04-MISMATCH | Spoofing | late receipt correlation | high | mitigate | Operation/request/provider/model/profile/card correlation precedes pricing; mismatch remains ambiguous/quarantined. | closed |
| T-04-NATIVE | Information disclosure | provider-native evidence | medium | mitigate | Public records retain only normalized usage and protected evidence references. | closed |
| T-04-BLOCK | Denial of service | unresolved usage | medium | accept | Spend safety intentionally blocks the session while usage is unresolved; owner status exposes reconciliation state and Phase 7 owns operational deadlines. | closed |
| T-04-RACE | Tampering | revisions | high | mitigate | Owner, lineage, expected-version, idempotency, and one-active-action fences; concurrent/stale tests. | closed |
| T-04-INJECTION | Elevation of privilege | napplet harness | high | mitigate | Strict schemas, fixed commands/workflow, approved edit surfaces, server-owned gates, hostile-content tests. | closed |
| T-04-HONESTY | Spoofing | artifact outcome | high | mitigate | Only the all-gates-pass branch advances verified artifact lineage; failures retain the prior artifact. | closed |
| T-04-REPAIR | Denial of service | automatic repair | high | mitigate | One versioned, separately authorized repair bound to failure evidence; recursive/second repair denied. | closed |
| T-04-DIAGNOSTIC | Information disclosure | failure status | high | mitigate | Closed redacted diagnostic schema rejects prompts, source, reasoning, credentials, grants, and native evidence. | closed |
| T-04-STATUS-OWNER | Spoofing | session status | high | mitigate | Authenticate-before-read, owner-scoped lookup, and indistinguishable foreign/missing responses. | closed |
| T-04-STATUS-LEAK | Information disclosure | status/history | high | mitigate | Strict allowlisted projections, decimal strings, safe references, and recursive leak canaries. | closed |
| T-04-ADAPTER | Elevation of privilege | ContextVM registry | high | mitigate | Exact three-tool allowlist; repair remains internal; thin parsed calls into transport-neutral services. | closed |
| T-04-HISTORY-DOS | Denial of service | billing history | medium | mitigate | Owner-scoped indexed order, 1–50 page bound, signed opaque cursor, pagination tests. | closed |
| T-04-READINESS | Spoofing | status/evidence claims | high | mitigate | Closed schemas reject preview/publication/live-provider claims; deterministic provider remains `unselected`. | closed |
| T-04-ORACLE | Tampering | runtime evidence gate | high | mitigate | Fact-only probe inputs, actual authority reads, exact fourteen-field comparison, exhaustive recomputed-oracle mutation tests. | closed |
| T-04-EVIDENCE-LEAK | Information disclosure | immutable evidence | high | mitigate | Strict observation schema, forbidden-name/value scan, protected references, and adversarial canaries before write. | closed |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-04-01 | T-04-BLOCK | An unresolved provider effect must stop further spending; this deliberate availability tradeoff is safer than guessing zero usage. Phase 7 owns live recovery deadlines and certification. | Phase 04 plan authority | 2026-08-05 |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-05 | 28 | 28 | 0 | GSD secure-phase ASVS L1 |

## Sign-Off

- [x] All threats have a disposition.
- [x] Accepted risks are documented.
- [x] `threats_open: 0` confirmed at the configured `high` blocking threshold.
- [x] `status: verified` set in frontmatter.

**Approval:** verified 2026-08-05 — plan-time register present; all mitigations have implementation/test evidence, so the ASVS L1 short-circuit applies.
