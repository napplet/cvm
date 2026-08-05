---
phase: 06-sealed-preview-user-owned-publication
reviewed: 2026-08-05T10:00:10Z
depth: standard
files_reviewed: 43
files_reviewed_list:
  - bun.lock
  - migrations/phase-06/001_publication.sql
  - package.json
  - scripts/probe-phase-06-cli-source-contract.ts
  - scripts/verify-phase-06-design-slice.ts
  - src/contextvm/adapter.ts
  - src/contextvm/announcement.ts
  - src/persistence/funding-store.ts
  - src/persistence/postgres-sql-funding-store.ts
  - src/persistence/publication-store.ts
  - src/persistence/sqlite-publication-store.ts
  - src/phase-03/funded-core.ts
  - src/publication/attestation-event.ts
  - src/publication/capability-review.ts
  - src/publication/contracts.ts
  - src/publication/host-surface.ts
  - src/publication/manifest-event.ts
  - src/publication/napplet-cli-adapter.ts
  - src/publication/napplet-cli-source-contract.ts
  - src/publication/preview-service.ts
  - src/publication/public-status.ts
  - src/publication/publication-intent.ts
  - src/publication/publication-service.ts
  - src/verification/phase-06-design-evidence.ts
  - tests/contextvm/publication-adapter.test.ts
  - tests/evals/phase-06-reference-set.test.ts
  - tests/fixtures/phase-06-cli-source-contract.json
  - tests/fixtures/phase-06-reference-set.json
  - tests/phase-06/capability-review.test.ts
  - tests/phase-06/cli-source-contract.test.ts
  - tests/phase-06/fakes.ts
  - tests/phase-06/host-surface.test.ts
  - tests/phase-06/manifest-signature.test.ts
  - tests/phase-06/nostr-tools-direct-dependency.test.ts
  - tests/phase-06/preview-descriptor.test.ts
  - tests/phase-06/publication-intent.test.ts
  - tests/phase-06/publication-reconciliation.test.ts
  - tests/phase-06/publication-store-parity.test.ts
  - tests/phase-06/runtime-status.test.ts
  - tests/phase-06/sealed-deployment.test.ts
  - tests/phase-06/tracer.test.ts
findings:
  critical: 5
  warning: 1
  info: 0
  total: 6
status: issues_found
---

# Phase 06: Code Review Report

**Reviewed:** 2026-08-05T10:00:10Z  
**Depth:** standard  
**Files Reviewed:** 43  
**Status:** issues_found

## Summary

The reviewed paths contain security and correctness defects in the publication approval, owner isolation, durable-store, and production-composition paths. The targeted Phase 06 suite passes, but it primarily exercises the in-memory store and does not cover the failing SQLite transaction path or a production PostgreSQL integration.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Caller-supplied capability review can bypass required-capability approval

**File:** `/Users/sandwich/Develop/napplet-cvm/src/publication/publication-intent.ts:60`  
**Issue:** `parsedInput` accepts any syntactically valid `CapabilityReview`; it does not recompute `capabilityDigest` or require the optional manifest/policy/toolchain/runtime identity fences. A caller can submit an artifact with an unavailable required capability alongside `{ required: [], optional: [], compatibility: "compatible", capabilityDigest: <sha> }`, omitting the optional fences, and `createPublicationIntent` creates a signable intent. This was reproduced directly against the implementation.  
**Fix:** Recompute the review with `canonicalCapabilityReview(artifact, runtimeVariant)` inside the trusted publication facade and compare every canonical field and digest. At minimum, require all four currently optional identity fields and verify `await capabilityDigestForReview(review) === review.capabilityDigest` before accepting the review.

### CR-02: SQLite cannot execute the transaction callbacks used by PublicationService

**File:** `/Users/sandwich/Develop/napplet-cvm/src/persistence/sqlite-publication-store.ts:75`  
**Issue:** `transact` passes an async callback into `#serialized(false, ...)`. That method immediately calls `immutable(operation())`, which attempts `structuredClone` on the returned Promise and throws `DataCloneError`. PublicationService uses this API to create intents, persist signed events, and read signed events, so it cannot operate with `SqlitePublicationStore` despite the store passing its direct-method parity test.  
**Fix:** Do not clone a Promise. Provide explicit asynchronous read/write transaction helpers that await the callback before cloning, and avoid re-entering the same serialization queue from inside a held transaction. Add an integration test that runs `PublicationService.createIntent` and `submitSignedManifest` against SQLite.

### CR-03: Intent creation bypasses the durable idempotency API

**File:** `/Users/sandwich/Develop/napplet-cvm/src/publication/publication-service.ts:22`  
**Issue:** `createIntent` calls legacy `transact(tx.putIntent)` instead of `createOrReplayIntent`. The intended command identity is therefore not recorded. Because `createdAtMs` is part of the fingerprint, an ordinary retry after the clock advances becomes a new intent: the SQLite legacy path permits two records with the same idempotency key, while the memory path returns an idempotency conflict. This breaks retry semantics and creates divergent behavior between stores.  
**Fix:** Make `PublicationService` depend on the durable create/replay interface, derive a stable request fingerprint excluding server-assigned timestamps, and return the prior intent for an exact owner-scoped idempotency-key replay. Test a retry with a later clock value on both memory and SQLite implementations.

### CR-04: Concurrent request can bypass the owner check and receive another owner’s result

**File:** `/Users/sandwich/Develop/napplet-cvm/src/publication/publication-service.ts:29`  
**Issue:** The in-process deduplication map is keyed only by `intentId` and is consulted before `#intentForOwner`. During an active legitimate submission, a caller for a different account who knows the intent ID receives the existing promise and its publication status without owner authorization.  
**Fix:** Resolve and authorize the intent before consulting the in-flight map, and key the map by both `accountId` and `intentId` (or store an owner-bound promise record). Add a concurrent cross-account test asserting `PUBLICATION_NOT_FOUND_OR_DENIED`.

### CR-05: The PostgreSQL publication authority cannot back PublicationService

**File:** `/Users/sandwich/Develop/napplet-cvm/src/persistence/postgres-sql-funding-store.ts:71`  
**Issue:** The production store implements `PublicationFundingStore`, but PublicationService requires `DurablePublicationStore` (`transact`, `getIntent`, and persistence for signed owner events). The PostgreSQL class does not implement those methods, and the provided migration has no signed-event table. It cannot be passed to PublicationService without a type escape and then fails at runtime; production publication therefore has no durable service-compatible persistence path.  
**Fix:** Implement a single production `DurablePublicationStore` backed by PostgreSQL, including owner-event persistence and transactional intent/effect operations, or refactor PublicationService to use a complete owner-scoped PostgreSQL publication interface. Exercise the service end-to-end against PostgreSQL/Cockroach rather than source-text assertions.

## Warnings

### WR-01: The reference-set evaluator hard-codes its observations instead of reading test results

**File:** `/Users/sandwich/Develop/napplet-cvm/tests/evals/phase-06-reference-set.test.ts:28`  
**Issue:** `canonicalObservedPhase06Case` returns a hard-coded expected-looking record based solely on fixture labels. `executePhase06ReferenceCase` only uses the spawned test’s exit code, so a test may pass while no asserted runtime value/effect is connected to the fixture’s claimed observation. This can report a green “actual-authority” reference set while the mapped fact has regressed or was never exercised.  
**Fix:** Have each referenced test emit a structured, asserted result (status, exact effect counts, value) and compare that output to the fixture, or replace the fixture runner with direct scenario invocations that return those values.

---

_Reviewed: 2026-08-05T10:00:10Z_  
_Reviewer: the agent (gsd-code-reviewer)_  
_Depth: standard_
