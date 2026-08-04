---
phase: 03-contextvm-funding-funded-admission
verified: 2026-08-04T17:53:33Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "Account status now merges owner-scoped Lightning and Cashu lifecycle records with credited funding rows."
    - "The public ContextVM account_status route now returns redacted pending, failed, reconciliation-pending, and credited states."
    - "Each of the 19 Phase 3 fixtures now dispatches an in-process, exact scenario/oracle instead of a broad test-file group."
    - "Rail provider timeouts now abort the supplied call and persist/replay reconciliation rather than reissuing an opaque effect."
    - "Post-reservation persistence failures now compensate capacity or retain a durable reconciliation-pending outcome when release is uncertain."
    - "An opaque or aborted Cashu swap now reconciles from proof state without a second swap, and failed release finalization fences retry before a new reservation."
    - "A pre-release capacity-fence write failure can no longer suppress the compensating external release."
  gaps_remaining: []
  regressions: []
---

# Phase 3: ContextVM Funding & Funded Admission Verification Report

**Phase Goal:** A Nostr user can safely discover the service, fund one stable prepaid account, inspect its state, and authorize work without duplicate credits or undisclosed charges.

**Verified:** 2026-08-04T17:53:33Z  
**Status:** passed  
**Re-verification:** Yes — compensation-persistence closure through `b1e3486`.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Signed v1 discovery exposes a usable ContextVM funding surface. | ✓ VERIFIED | `createFundedCore` configures the truthful announcement before building the adapter; tests assert the canonical v1-only top-up PMIs and planned/unavailable future tools. |
| 2 | A verified user can fund the stable principal-derived account through Lightning or trusted-mint Cashu. | ✓ VERIFIED (offline design) | The adapter uses the SDK-verified pubkey and routes CEP-8-validated requests to coordinator-owned rail flows; both credit only through `FundingService`, and timeout/opaque Cashu swap paths become durable proof-state reconciliation rather than blind reissue. |
| 3 | Duplicate delivery, settlement, and lifecycle state are durable across service instances. | ✓ VERIFIED (offline design) | `PostgresFundingDatabase` owns the PostgreSQL-wire serializable funding authority, durable rail lifecycle ports, encrypted protected-material port, and owner-scoped status projection. |
| 4 | A disclosed cap is coupled to server-owned immediately usable capacity, with no durable generation queue. | ✓ VERIFIED | The public request has no capacity fact; `FundedAdmissionService` atomically fences one capacity dispatch, bounds waits, rejects an expired lease, and never suppresses external compensation because of a pre-release persistence failure; existing durable dispatch state still prevents a second reservation. |
| 5 | ContextVM status presents complete owner-scoped, redacted funding/session/rail lifecycle state. | ✓ VERIFIED (offline design) | `AccountStatusService` merges funding, sessions, and database-owned rail lifecycle records; adapter and database projection tests cover pending, failed, reconciliation-pending, credited, cross-owner exclusion, and redaction. |

**Score:** 5/5 truths verified.

## Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/contextvm/announcement.ts`, `src/contextvm/sdk-bridge.ts`, `src/contextvm/adapter.ts` | Signed discovery, verified-principal transport boundary, CEP-8 top-up/status/admission routes | ✓ VERIFIED | Final-core composition configures announcement; adapter rejects malformed negotiation facts and correlates redacted responses. |
| `src/phase-03/funded-core.ts` | Fail-closed public composition | ✓ VERIFIED | Public surface requires one `PostgresFundingDatabase`, both provider ports, policy registry, capacity, transport, and valid AES-GCM key; caller-supplied "durable" rail facades are rejected outside test mode. |
| `src/persistence/postgres-sql-funding-store.ts`, `src/persistence/postgres-funding-database.ts`, `migrations/phase-03/001_funding.sql` | Narrow PostgreSQL-wire monetary, lifecycle, material, and status authority | ✓ VERIFIED (offline design) | Serializable funding store, bounded retry/deadline, DB-owned repository ports, ciphertext/nonce/digest schema, and owner-filtered rail projection are substantive and tested. |
| `src/funding/lightning-top-up.ts`, `src/funding/cashu-top-up.ts`, `src/funding/cashu-provider.ts`, `src/funding/protected-rail-material.ts` | Safe durable rail lifecycle state | ✓ VERIFIED (offline design) | Lifecycle/replay paths use narrow ports; Cashu claims proof commitment before provider I/O; protected bearer bytes use one database-owned AES-GCM vault; bounded rail calls pass abort signals; opaque Cashu swaps reconcile with a proof-state query rather than resubmission. |
| `src/funding/funded-admission.ts`, `src/persistence/funding-store.ts` | Capacity-fenced cap/hold admission | ✓ VERIFIED | Dispatch fence, best-effort pre/post compensation persistence, lease check, release/finalization fence, action-budget limit, and bounded provider waits are exercised. |
| `src/funding/account-status.ts` | Combined redacted account projection | ✓ VERIFIED | Merges credit projection with `AccountTopUpStatusPort`, preserving credited records and adding non-credited lifecycle rows without duplication. |
| `tests/evals/phase-03-reference-set.test.ts`, `tests/fixtures/phase-03-reference-set.json` | Exact deterministic reference matrix | ✓ VERIFIED | Unique fixture input maps to a unique in-process scenario; returned result/state/effect/evidence object equals the fixture’s declared expected oracle. |

## Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| Final core | ContextVM transport | `configureAnnouncement` + adapter constructor | ✓ WIRED | Public composition announces only the v1 funding surface and registers inbound handling. |
| ContextVM `top_up` | Lightning/Cashu coordinators | verified pubkey, PMI/mode, redacted result | ✓ WIRED | Direct Cashu bearer is required only for Cashu and is never returned; Lightning rejects it; timeout calls are aborted and opaque Cashu effects reconcile with proof-state observation, never another swap. |
| ContextVM `funded_admission` | `FundedAdmissionService` | server-owned capacity port | ✓ WIRED | Client cannot submit `capacity.usable` or a capacity reference; a failed pre-release persistence write cannot suppress external release, and durable dispatch/reconciliation state prevents retry from reserving again. |
| ContextVM `account_status` | `AccountStatusService` | authenticated principal → database rail-status projection | ✓ WIRED | Public route test proves owner-scoped pending/failed/reconciliation lifecycle output and redaction. |
| `PostgresFundingDatabase` | Funding, rail, material, status ports | database-owned narrow capabilities | ✓ WIRED | Final composition constructs both coordinators and the AES-GCM vault from those ports; rail modules receive no arbitrary SQL capability. |
| Fixtures | exact in-process oracle | `oracles[item.input]` → equality with `item.expected` | ✓ WIRED | Nineteen fixtures have distinct inputs, each with its own scenario execution and exact observation comparison. |

## Data-Flow Trace

There are no rendered UI artifacts. The relevant authority flow is complete in the offline design:

`SDK-verified pubkey → ContextVM adapter → principal-derived account → coordinator/funding database → account status rail projection → redacted ContextVM response`.

The only omitted path is live provider/database/relay execution, intentionally recorded as unselected rather than represented by a fake success.

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Full deterministic implementation suite | `bun test` | 266 pass, 0 fail, 1,172 expectations, 32 files | ✓ PASS |
| Fixture-specific Phase 3 evaluation | `bun run eval:phase-03` | 22 pass, 0 fail, 102 expectations; 19 exact fixture-bound scenarios plus evidence-mutation rejection | ✓ PASS |
| Complete Phase 3 design-slice gate | `bun run test:phase-03-design-slice` | `design-ready`; offline verdict `passed`; evidence `7beb4957b2bc3ff79ba9207f8d91ed1f86b3e06eabf2d7a64e8b9681192f2f08` | ✓ PASS |
| Rail/capacity edge behavior | Included in full suite | Serialization/deadline, owner-filtered rail status, abort/opaque-effect proof-state reconciliation, capacity fence, lease expiry, release-finalization retry fence, and pre-release-persistence failure compensation all pass | ✓ PASS |

## Probe Execution

| Probe | Command | Result | Status |
| --- | --- | --- | --- |
| Phase 3 design slice | `bun run test:phase-03-design-slice` | Canonical immutable evidence is valid; six live observations are `blocked` / `unselected`; no live provider claim | PASS |

## Requirements Coverage

| Requirement | Source Plans | Status | Evidence |
| --- | --- | --- | --- |
| CTX-01 | 03, 07 | ✓ SATISFIED (offline design) | Truthful signed v1 announcement is composed. |
| CTX-02 | 01, 02, 03, 07 | ✓ SATISFIED | Only SDK-verified sender identity becomes the principal. |
| CTX-03 | 01, 02, 03, 07 | ✓ SATISFIED (offline design) | Serializable store and durable database-owned lifecycle ports are used by final composition. |
| CTX-04 | 02, 03, 06, 07 | ✓ SATISFIED (offline design) | Public status combines owner-scoped funding, rail lifecycle, sessions, and pending actions without bearer material. |
| PAY-01 | 03, 04, 05, 07 | ✓ SATISFIED (offline design) | CEP-8 PMIs/modes are validated then dispatched to the appropriate coordinator. |
| PAY-02 | 04, 07 | ✓ SATISFIED (offline design) | Lightning intent, receipt match, deadline abort/reconciliation, and credit flow are exercised. |
| PAY-03 | 05, 07 | ✓ SATISFIED (offline design) | Cashu policy pinning, bounded bearer validation, abort/opaque-effect proof-state reconciliation, proof claim, verification, and sole credit authority are exercised. |
| PAY-04 | 01, 02, 04, 05, 07 | ✓ SATISFIED (offline design) | Pending, failed, reconciliation-pending, and credited states merge into public owner status. |
| PAY-05 | 01, 02, 04, 05, 07 | ✓ SATISFIED (offline design) | Durable idempotency/commitment/capacity fences prevent duplicate business effects. |
| PAY-06 | 05, 07 | ✓ SATISFIED (offline design) | Each Cashu request pins the allowed mint policy before asynchronous work. |
| PAY-07 | 05, 07 | ✓ SATISFIED (offline design) | Query-only proof-state reconciliation and one-time treasury reconciliation avoid resubmission and re-credit. |
| BILL-01 | 01, 03, 06, 07 | ✓ SATISFIED (offline design) | Positive integer cap and lesser-of-available hold are enforced. |
| BILL-02 | 01, 02, 06, 07 | ✓ SATISFIED (offline design) | Immediate capacity and a valid lease precede the hold; no client capacity claim is trusted. |
| BILL-06 | 01, 02, 06, 07 | ✓ SATISFIED (offline design) | No durable request queue was introduced; unavailable/ambiguous capacity denies or reconciles before admission, pre-release persistence failure does not suppress compensation, and uncertainty remains fenced against retry. |

All fourteen Phase 3 requirements occur in plan frontmatter; none is orphaned.

## Anti-Patterns Found

No blocker or warning anti-patterns found. A scan found no unresolved `TBD`, `FIXME`, `XXX`, HACK, or placeholder markers in Phase 3 implementation/eval files. `git diff --check` passes.

## Design-Stage Boundaries Preserved

- The fresh immutable evidence pointer records ContextVM, Lightning, Cashu, PostgreSQL, capacity, and Modal as `blocked` / `unselected`.
- Phase 4 exact usage/debit, Phase 5 interruption/resume, Phase 6 preview/publication, Phase 7 live-provider/SLO/provenance certification, and v2 x402/L402 remain deferred.
- The Phase passes its offline deterministic design contract only; it does not claim live relay, database, payment rail, capacity vendor, or Modal certification.

## Gaps Summary

None within the Phase 3 offline-design scope. The remaining live-provider/database and SLO work is explicitly owned by Phase 7 and does not block this design completion.

---

_Verified: 2026-08-04T17:53:33Z_  
_Verifier: the agent (gsd-verifier)_
