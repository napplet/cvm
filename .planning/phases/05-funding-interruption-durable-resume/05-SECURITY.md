---
phase: 05
slug: funding-interruption-durable-resume
status: verified
threats_open: 0
asvs_level: 1
block_on: high
created: 2026-08-05
---

# Phase 05 — Security

> ASVS L1 verification of the plan-authored STRIDE register. This sign-off is
> for the deterministic design profile; it does not claim live-provider or
> production certification.

## Trust Boundaries

| Boundary | Protected transition |
|----------|----------------------|
| ContextVM command → coordinator | SDK-verified owner identity and strict command data become durable session authority. |
| Funding state → worker effect | Exact balance, cap, pending intent, action budget, operation, and lease fences authorize one effect. |
| Worker → checkpoint authority | Untrusted archive claims become an authenticated, encrypted, immutable checkpoint only after validation. |
| Payment hint → live wake | An untrusted hint triggers a durable reread; it cannot grant credit or work authority. |
| Deadline/reaper → terminal state | Row-locked time decisions serialize wake, checkpoint, claim, expiry, and deletion. |
| Runtime probe → design evidence | Exact tests gate a redacted, content-addressed design-profile record. |

## Threat Register

| Threat ID | Severity | Disposition | Mitigation / evidence | Status |
|-----------|----------|-------------|-----------------------|--------|
| T-05-01-EFFECT | high | mitigate | Pause transaction precedes budgets/effects; `pause-for-funding.test.ts`. | closed |
| T-05-01-CAP | high | mitigate | Independent bigint cap/balance shortfalls; unchanged approved cap. | closed |
| T-05-01-REPLAY | high | mitigate | Canonical fingerprint and stored-result replay; altered reuse denied. | closed |
| T-05-01-DISCLOSE | high | mitigate | Owner gate and safe continuation projection; protected-canary tests. | closed |
| T-05-01-DEADLINE | medium | mitigate | Immutable server deadline; duplicate/reconnect cannot extend it. | closed |
| T-05-01-SC | low | accept | No dependency install or version change in Phase 05. | closed — accepted |
| T-05-02-SPLIT | high | mitigate | Serializable checkpoint/lease authority and rollback/race coverage. | closed |
| T-05-02-DUP | high | mitigate | Unique pause/checkpoint/lease/allocation claims; concurrent winner tests. | closed |
| T-05-02-REDISPATCH | high | mitigate | Persisted operation dispositions fence historical redispatch. | closed |
| T-05-02-EXPIRY | high | mitigate | Row-locked server-time tombstone transition and claim race tests. | closed |
| T-05-02-RETRY | medium | mitigate | Bounded retry, deterministic lock ordering, effects outside retries. | closed |
| T-05-02-SC | low | accept | Existing pinned PostgreSQL/Kysely seams; no dependency change. | closed — accepted |
| T-05-03-SUBSTITUTE | high | mitigate | Canonical AAD, AEAD, digests, complete binding, tamper matrix. | closed |
| T-05-03-SECRET | high | mitigate | Archive allowlist/denylist and pre-encryption secret rejection. | closed |
| T-05-03-STALE | high | mitigate | Exact lease/claim/pause/version/workspace restore fencing. | closed |
| T-05-03-OVERWRITE | high | mitigate | Conditional immutable object creation and conflict denial. | closed |
| T-05-03-ORACLE | medium | mitigate | Generic restore denial across key/object/archive failures. | closed |
| T-05-03-SC | medium | mitigate | Project-owned ports exclude vendor authority; Modal remains unselected. | closed |
| T-05-04-WAKE | high | mitigate | Durable verified-credit reread and atomic wake predicates. | closed |
| T-05-04-IDLE | high | mitigate | Waiting state proves zero model/tool/build/network/debit effects. | closed |
| T-05-04-LOSS | high | mitigate | Seal/put then atomic lease revocation before termination. | closed |
| T-05-04-RACE | high | mitigate | Row-locked wake/checkpoint attempt at immutable deadline. | closed |
| T-05-04-ORPHAN | medium | mitigate | Orphan is ciphertext only, has no SQL authority, and is auditable. | closed |
| T-05-04-SC | low | accept | Deterministic ports only; live provider behavior is Phase 7 work. | closed — accepted |
| T-05-05-OWNER | high | mitigate | Resume binds only SDK-verified Nostr identity and correlation. | closed |
| T-05-05-DUP | high | mitigate | Atomic unique claim, fresh lease/allocation, exact replay. | closed |
| T-05-05-CONSENT | high | mitigate | Exact pending action/max plus explicit resume and cap consent. | closed |
| T-05-05-REDISPATCH | high | mitigate | Settled/uncertain history and original operation are fenced. | closed |
| T-05-05-COMPAT | high | mitigate | Server-owned pinned compatibility decision; archive text has no authority. | closed |
| T-05-05-DISCLOSE | medium | mitigate | Strict safe resume result excludes private capabilities. | closed |
| T-05-06-RACE | high | mitigate | Strict row-locked claim/expiry comparison at the deadline. | closed |
| T-05-06-REVIVE | high | mitigate | Terminal tombstone blocks credit, command, and restart revival. | closed |
| T-05-06-DELETE | high | mitigate | Tombstone-first exact object/key deletion reconciliation. | closed |
| T-05-06-DUP | medium | mitigate | Unique intents, immutable observations, duplicate-reaper tests. | closed |
| T-05-06-DISCLOSE | medium | mitigate | Owner-gated coarse terminal projection. | closed |
| T-05-06-SC | low | accept | Production retention/deletion provider certification is Phase 7 work. | closed — accepted |
| T-05-07-ORACLE | high | accept | Exact named tests gate evidence, but observations remain a closed static case map. Accepted only for design iteration; Phase 7 must replace or certify it before production. | closed — accepted |
| T-05-07-COVERAGE | high | mitigate | Exact CONT/decision/threat/prohibition mapping and named-suite enforcement. | closed |
| T-05-07-FORGE | high | mitigate | Canonical digest, create-or-verify, reread validation, pointer-after-pass. | closed |
| T-05-07-DISCLOSE | high | mitigate | Redacted strict evidence schema and forbidden-content tests. | closed |
| T-05-07-CLAIM | high | mitigate | Live providers are explicitly unselected/not observed; readiness claims fail. | closed |
| T-05-07-SC | low | accept | No dependency change; only package scripts were added. | closed — accepted |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-05-01 | T-05-01-SC | Phase changed no dependencies. | Product owner / autonomous design directive | 2026-08-05 |
| AR-05-02 | T-05-02-SC | Phase changed no database dependencies. | Product owner / autonomous design directive | 2026-08-05 |
| AR-05-03 | T-05-04-SC | Live-provider behavior belongs to Phase 7 certification. | Product owner / autonomous design directive | 2026-08-05 |
| AR-05-04 | T-05-06-SC | Production retention/deletion certification belongs to Phase 7. | Product owner / autonomous design directive | 2026-08-05 |
| AR-05-05 | T-05-07-SC | Phase changed no dependencies. | Product owner / autonomous design directive | 2026-08-05 |
| AR-05-06 | T-05-07-ORACLE | The user explicitly allows an imperfect trust model during design. Exact tests still gate the record; static observation derivation is prohibited from satisfying Phase 7 production certification. | Product owner | 2026-08-05 |

## Deferred Provider Certification

Modal, object storage, KMS, live PostgreSQL, restore latency, failover,
multi-region behavior, and production certification remain `unselected` or
`not_observed`. Phase 7 owns their closure. No Phase 5 artifact may be read as
launch-readiness evidence.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-05 | 42 | 42 | 0 | gsd-security-auditor + autonomous orchestrator |

## Sign-Off

- [x] All threats have a disposition.
- [x] Accepted risks are bounded and documented.
- [x] `threats_open: 0` is confirmed at the configured `high` threshold.
- [x] `status: verified` is set.

**Approval:** verified for the deterministic design profile on 2026-08-05.
