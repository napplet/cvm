---
phase: 07-admission-slo-resilience-launch-safety
plan: "63"
subsystem: infra
tags: [google-cloud, adc, cloud-run, cloud-storage, cloud-sql, topology]
requires:
  - phase: 07-58
    provides: production architecture and single-authority topology decision
provides:
  - ADC-bound Google control-plane HTTPS transports with durable request identities
  - Two-region Cloud Run, one regional-HA Cloud SQL, and nam4 GCS topology contract
affects: [07-65, 07-66, protected-live-certification]
tech-stack:
  added: [google-auth-library@11.3.1]
  patterns: [observe-before-create, durable-CAS-request-journal, generation-specific-object-observation, immutable-image-reference]
key-files:
  created: [src/release/deployment/google-auth.ts, tests/release/google-production-transport.test.ts]
  modified: [src/release/deployment/google-clients.ts, src/release/topology.ts, src/release/contracts.ts]
key-decisions:
  - "Cloud Run creation uses deterministic serviceId then resource observation; it does not invent requestId support."
  - "Cloud SQL regional HA is one database authority despite two Cloud Run control regions."
  - "GCS retention, lifecycle old-version expiry, and soft-delete duration are observed separately; soft-delete is disabled so a 30-day lifecycle deletion does not retain data for another 30 days."
patterns-established:
  - "Google mutation: durable-CAS journal exact resource/request/content digest, observe, make one official request, then reconcile by original resource or LRO."
requirements-completed: []
coverage:
  - id: D1
    description: ADC-bound Google deployment transports and failure handling
    requirement: OPS-01
    verification:
      - kind: unit
        ref: tests/release/deployment-google-clients.test.ts
        status: implementation-verified
        live_certification: pending
    human_judgment: false
  - id: D2
    description: Single-authority Google production topology and storage policy
    requirement: OPS-02
    verification:
      - kind: unit
        ref: tests/release/google-production-transport.test.ts
        status: implementation-verified
        live_certification: pending
    human_judgment: false
status: complete
---

# Phase 07 Plan 63: Google Production Transports Summary

**ADC-authenticated Google transports durably reconcile Cloud Run, Cloud SQL, and GCS effects while topology bills one regional-HA database authority.**

## Performance

- **Execution timing:** Not recorded; the original estimate predates subsequent review-hardening commits.
- **Tasks:** 2/2
- **Files modified:** 10

## Accomplishments

- Added the official `google-auth-library@11.3.1` ADC broker. It validates receipt-bound project, quota project, principal, observed `cloud-platform` scope, and finite expiry without serializing bearer values.
- Added a durable file-backed CAS journal (plus injectable journal port) that records dispatch claim/LRO/generation before and after official Google REST effects. Timeout/restart paths observe the recorded resource or LRO without a blind second create.
- Required immutable Artifact Registry-style images, service account, project/config environment, Secret Manager references, full terminal readiness comparison, etag-bound Cloud Run cleanup, Cloud SQL LRO/readiness/cleanup, and generation-bound GCS deletion.
- Corrected the topology to two Cloud Run regions with three warm instances each, one regional-HA PostgreSQL authority, and a versioned/KMS/retention-checked `nam4` bucket. GCS policy makes objects eligible for lifecycle deletion at 30 days with soft delete explicitly disabled; scheduled/audited provider verification remains required and retention policy is never locked.

## Task Commits

1. **Task 1: Implement ADC HTTPS and durable Google operations** — `f0ccbf9` (`feat`)
   - Follow-up reconciliation/ADC broker: `d446235` (`fix`)
   - Follow-up durable state and policy correction: `708bc52` (`fix`)
   - Follow-up Cloud Run terminal LRO reconciliation: `4a1a510` (`fix`)
   - Review hardening for bounded streams and immutable provider identity: `ced02f7` (`fix`)
   - Replacement-proof immutable ownership reconciliation: `ffcaa5f` (`fix`)
   - Direct Cloud Run deployment identity comparison: `2513670` (`fix`)
2. **Task 2: Correct the selected topology and storage policy** — `3667aa4` (`feat`)

## Files Created/Modified

- `package.json`, `bun.lock` — pinned, reviewed official `google-auth-library@11.3.1` provenance for documented Application Default Credentials.
- `src/release/deployment/google-auth.ts` — bounded official ADC broker and receipt-compatible account-scope digest; validates metadata bearer type, scope, identity, and expiry.
- `src/release/deployment/google-clients.ts` — official Google transports, persistent CAS journal, immutable config observation, LRO/resource reconciliation, and ownership-bound cleanup.
- `src/release/topology.ts` — one regional-HA Cloud SQL authority and explicit storage policy.
- `src/release/contracts.ts` — validates topology's HA and object-policy declarations.
- `tests/release/deployment-google-clients.test.ts` — authenticated success, failure, timeout/reconciliation, and request-shape contracts.
- `tests/release/google-production-transport.test.ts` — production allocation and GCS-policy contracts.

## Decisions Made

- Cloud Run has no documented create `requestId`; the deterministic service identifier plus persisted request digest is observed before any retry.
- The immutable Cloud Run image contract is a fully qualified registry reference ending in `@sha256:<digest>`; a digest alone is never sent as an image URL.
- Vertex generation remains `unknown` at this layer: it has no durable operation lookup and Plan 65 owns query-only receipt reconciliation.
- GCS sends CRC32C in JSON multipart upload metadata, recomputes it from exact bytes, and verifies the recorded generation before completion or deletion.
- GCS retention policy is observed but never irreversibly locked; lifecycle policy makes objects eligible at 30 days, while provider-scheduled deletion must be verified by audited observation. Soft delete is disabled to avoid a second retention window.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected topology quantity assertion after removing the fabricated second database**
- **Found during:** Task 2
- **Issue:** Preapproval coverage expected twenty topology lines, including a Cloud SQL authority for each control region.
- **Fix:** Updated the expectation to nineteen explicit allocations and documented why one regional-HA instance is billed once.
- **Files modified:** `tests/release/production-preapproval.test.ts`
- **Verification:** Targeted preapproval and controller suites pass.
- **Commit:** `3667aa4`

**Total deviations:** 1 auto-fixed (Rule 1).

**2. [Rule 2 - Critical durability] Added a durable CAS operation journal and LRO reconciliation**
- **Found during:** Review follow-up after Task 1
- **Issue:** A memory-only claim could be lost across process recreation, allowing an ambiguous create to be retried.
- **Fix:** Added exclusive-create/lock/atomic-rename file journal semantics and restart contract coverage; the production assembly may inject its transactional durable journal.
- **Files modified:** `src/release/deployment/google-clients.ts`, `tests/release/deployment-google-clients.test.ts`
- **Commit:** `708bc52`

**3. [Rule 1 - API correctness] Replaced digest-only Cloud Run and header-only GCS checksum requests**
- **Found during:** Review follow-up after Tasks 1–2
- **Issue:** `sha256:...` is not a deployable Cloud Run image reference, and raw media upload did not bind CRC32C through JSON object metadata.
- **Fix:** Required immutable registry image/config/secret contracts and multipart JSON metadata CRC32C; added generation/etag cleanup and Cloud SQL observation APIs.
- **Files modified:** `src/release/deployment/google-clients.ts`, `tests/release/deployment-google-clients.test.ts`
- **Commit:** `708bc52`

**4. [Rules 1–2 - Review hardening] Bound response streams and cleanup reconciliation to provider evidence**
- **Found during:** Post-Task 1 review.
- **Issue:** A timed-out response reader could release without cancellation; completed local cleanup records could be treated as deletion despite a still-present resource; GCS bucket and Cloud SQL recovery lacked immutable creation-identity binding on all paths.
- **Fix:** Enforced total stream deadlines with reader cancellation and request aborts, persisted/checked immutable provider creation times, refused replacement resources, and made all cleanup completion paths re-observe absence before reporting success.
- **Files modified:** `src/release/deployment/google-auth.ts`, `src/release/deployment/google-clients.ts`, `tests/release/deployment-google-clients.test.ts`.
- **Verification:** 27 focused Google deployment tests and the full denied-effects release suite pass.
- **Commit:** `ced02f7`

**5. [Rule 1 - Ownership correctness] Made immutable provider identities write-once during reconciliation**
- **Found during:** Final post-review verification.
- **Issue:** Existing-resource SQL recovery and observation could overwrite a recorded creation time with a same-label replacement, then authorize cleanup of the replacement.
- **Fix:** Reconciliation now returns `unknown` on persisted identity drift; Cloud Run requires saved UID and creation time before cleanup. Added SQL, GCS, and Cloud Run replacement-to-cleanup regressions.
- **Files modified:** `src/release/deployment/google-clients.ts`, `tests/release/deployment-google-clients.test.ts`.
- **Verification:** 30 focused Google deployment tests and the full denied-effects release suite pass.
- **Commits:** `ffcaa5f`, `2513670`

**Total deviations:** 5 auto-fixed (Rules 1–2).

## Remaining Integration

The Google transport layer deliberately leaves paid Vertex generation unresolved; Plan 07-65 owns its production request, usage receipt, and query-only recovery implementation. Plan 07-69 must supply a PostgreSQL journal for cross-region authority; the file journal is not a production Cloud Run durability claim.

## Next Phase Readiness

The code is local-contract verified only. Before a protected execution, production assembly must bind the journal to durable transactional storage (not ephemeral Cloud Run filesystem), provide the exact Artifact Registry/Secret Manager/KMS/bucket/private-network identifiers, grant receipt-bound IAM to the configured service account, and perform approved live LRO/readiness/continuity drills. No cloud resource was created, no credential or token was emitted, and no live continuity claim is made by this plan.

## Self-Check: PASSED

- Confirmed task commits `f0ccbf9`, `3667aa4`, `d446235`, `708bc52`, `4a1a510`, `ced02f7`, `ffcaa5f`, and `2513670` exist and all plan artifacts exist.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release --timeout 10000 --reporter=dot` passed: 184 tests, 905 assertions.
- Root dependency manifest hashes are intentionally omitted: approved manifest pins are parent-owned and changed after the earlier recorded values.

## Mainline and CI

- PR [#7](https://github.com/napplet/cvm/pull/7) merged on 2026-10-27 as `1e7e76829ef6d88b1db300ded9866881bea59fd7`, from reviewed head `14394877d31d277a5aea280fa9e132c4b78a7d49`.
- Required payment run `40529038199`, browser GUI run `40529038333`, and documentation run `40529038189` passed. Browser checks include real local builds, publication, restart/continuation, and post-cleanup liveness.
- This merge did not deploy Beta, provision Google resources, migrate live data, or run protected production certification.
