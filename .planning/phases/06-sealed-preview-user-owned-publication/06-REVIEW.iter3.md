---
phase: 06-sealed-preview-user-owned-publication
reviewed: 2026-08-05T10:19:51Z
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
  critical: 0
  warning: 2
  info: 0
  total: 2
status: issues_found
---

# Phase 06: Code Review Report

**Reviewed:** 2026-08-05T10:19:51Z  
**Depth:** standard  
**Files Reviewed:** 43  
**Status:** issues_found

## Summary

The previous critical findings CR-01 through CR-05 are closed in the reviewed code: publication approval is recomputed from the sealed artifact, SQLite awaits asynchronous service callbacks, idempotency uses a timestamp-independent durable fingerprint, owner authorization precedes in-flight sharing, and a PostgreSQL `DurablePublicationStore` surface plus signed-event migration now exist. The reference-set evaluator also consumes structured observations emitted by its named scenarios.

Two warning-level defects remain. The Phase 06 evidence artifact generator discards those structured observations and reconstructs its asserted results from fixture labels, and the reviewed Phase 06 TypeScript sources do not type-check under the repository compiler configuration. The focused Phase 06 tests pass (50 tests), but they do not exercise PostgreSQL against a live PostgreSQL-wire database.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Design evidence reintroduces fixture-derived observations

**Classification:** WARNING  
**File:** `/Users/sandwich/Develop/napplet-cvm/scripts/verify-phase-06-design-slice.ts:25`  
**Issue:** `observedComparison` derives every `observed` status, effect string, and value from `item.input` with hard-coded branches (lines 30-50), then returns the fixture's `expectedEffects` unchanged (line 51). `runPhase06DesignChecks` runs the reference suite but never consumes `executePhase06ReferenceCase` results or the `PHASE06_OBSERVATION` records that were added to close the earlier reference-set finding. A scenario can therefore emit a different structured observation while this script still produces a byte-valid, `design-ready` evidence record containing the expected values.

**Fix:** Export and call the reference-set execution routine from this script (or have it write a validated structured result artifact), build each comparison from its returned `observed` and parsed effect counts, and fail before evidence creation when an observation is missing, the child exit status is non-zero, or any expected/observed field differs. Do not derive observations from fixture labels.

### WR-02: Phase 06 source fails TypeScript checking

**Classification:** WARNING  
**Files:** `/Users/sandwich/Develop/napplet-cvm/src/publication/capability-review.ts:101`; `/Users/sandwich/Develop/napplet-cvm/src/publication/publication-intent.ts:183`; `/Users/sandwich/Develop/napplet-cvm/src/persistence/postgres-sql-funding-store.ts:204-210`  
**Issue:** `bunx tsc --noEmit` reports errors in all three reviewed files: `crypto.subtle.digest` is passed a `Uint8Array<ArrayBufferLike>` where the configured DOM types require `BufferSource`; the readonly tuple `tags` cannot satisfy the mutable `string[][]` contract; and the PostgreSQL observation record infers `state` as `string` while also reads nonexistent `input.requestFingerprintSha256`. The last expression happens to fall back to the stored fingerprint at runtime, but it is not type-safe and prevents a clean compile. The scope also has broader pre-existing compiler errors; these three are direct Phase 06 source errors.

**Fix:** Make the byte argument an accepted `BufferSource` (or use Node's hash consistently), declare/copy template tags as mutable `string[][]` before schema return, and build the observation through `PublicationObservationSchema.parse` (or an explicitly typed `PublicationObservation`) while using `effect.requestFingerprintSha256` directly. Add the project's supported type-check command to the Phase 06 gate once unrelated baseline errors are addressed.

---

_Reviewed: 2026-08-05T10:19:51Z_  
_Reviewer: the agent (gsd-code-reviewer)_  
_Depth: standard_
