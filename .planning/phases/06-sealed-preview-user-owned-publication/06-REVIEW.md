---
phase: 06-sealed-preview-user-owned-publication
reviewed: 2026-08-05T10:31:57Z
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
  critical: 2
  warning: 1
  info: 0
  total: 3
status: issues_found
---

# Phase 06: Code Review Report

**Reviewed:** 2026-08-05T10:31:57Z
**Depth:** standard
**Files Reviewed:** 43
**Status:** issues_found

## Summary

CR-01 through CR-05 from the prior review are closed: approval is recomputed from the sealed artifact, SQLite awaits asynchronous callbacks, request replay is timestamp-independent, owner authorization precedes in-flight sharing, and the PostgreSQL durable-store surface is present. Both prior generations of WR-01 are closed: the design script now calls `executePhase06ReferenceCase` and consumes structured observations. The previously cited direct compiler errors in `capability-review.ts`, `publication-intent.ts`, and `postgres-sql-funding-store.ts` are also cleared.

The re-review found two new critical defects in the promoted CLI adapter. Its exact-byte check accepts an arbitrary file set because it never derives the artifact aggregate from those bytes, and it treats an untrusted source callback as sufficient proof that an incomplete relay effect completed. Both were reproduced with executed calls to `deployPreSignedNamed`. The full compiler still reports three direct TypeScript errors in `sqlite-publication-store.ts`; the focused Phase 06 suite passes 50 tests, and `bun run scripts/verify-phase-06-design-slice.ts` passes while producing evidence from structured observations.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Sealed deployment accepts a substituted file set

**Classification:** BLOCKER
**File:** `/Users/sandwich/Develop/napplet-cvm/src/publication/napplet-cli-adapter.ts:48-57`
**Issue:** `assertSealedNamedDeployPlan` verifies each supplied file against its *caller-supplied* per-file hash, then compares the equally caller-supplied `sealedAggregateSha256` and `deployAggregateSha256` strings to the artifact aggregate. It never derives the aggregate from the supplied files or compares the files to a trusted sealed-file manifest. A reproduced call supplied different bytes (`05e7d216…`) with their matching per-file SHA-256 while copying the artifact aggregate (`aaaaaaaa…`); `deployPreSignedNamed` returned `completed`. This breaks the core guarantee that only the verified, sealed artifact is deployed.
**Fix:** Read the sealed file manifest from a trusted artifact record and require an exact path, MIME type, size, and hash match before deployment. Derive the canonical aggregate from that trusted manifest (or from the supplied canonical file list) and reject unless it equals `artifact.aggregateSha256`; do not accept caller-provided aggregate strings as proof.

### CR-02: Adapter promotes incomplete source effects to completed deployment

**Classification:** BLOCKER
**File:** `/Users/sandwich/Develop/napplet-cvm/src/publication/napplet-cli-adapter.ts:85-91`
**Issue:** After only checking the upload state, the adapter delegates its completion decision entirely to `source.networkDeploySucceeded`. It does not validate the relay effect state or require the evidence identifiers before returning `completed`. An executed probe supplied `publishEventWithSimplePool` with `{ state: "partial" }` and `networkDeploySucceeded: () => true`; the adapter returned `{ state: "completed", fullServerUploadId: "upload" }`. Dependency/tool output is untrusted in this system, so a malformed or compromised source facade can falsely commit a publication effect and suppress the required reconciliation path.
**Fix:** Parse both source responses at the adapter boundary and compute completion locally. Return `completed` only when upload and relay are both exactly `complete` and their required operation-bound evidence is present; otherwise return the corresponding `partial`, `failed`, or `unknown` result. Remove `networkDeploySucceeded` from the untrusted port, or make it an additional consistency check that cannot upgrade an incomplete effect.

## Warnings

### WR-01: Reviewed SQLite publication authority still prevents a clean type check

**Classification:** WARNING
**Files:** `/Users/sandwich/Develop/napplet-cvm/src/persistence/sqlite-publication-store.ts:1`; `/Users/sandwich/Develop/napplet-cvm/src/persistence/sqlite-publication-store.ts:40-41`; `/Users/sandwich/Develop/napplet-cvm/src/persistence/sqlite-publication-store.ts:93`
**Issue:** `bunx tsc --noEmit --pretty false` still fails directly in this Phase 06 module. The project does not provide the `bun:sqlite` declaration, and the SQLite row helpers return `null` through interface methods declared to return `undefined` for a missing intent, effect, or signed event. These errors make the durable publication implementation fail the repository compiler gate and hide future contract regressions behind existing diagnostics.
**Fix:** Configure the supported Bun type declarations for the compiler, then normalize absent rows explicitly, for example `return row === null ? undefined : parsedIntent;`, in `#intent`, `#effect`, and `getSignedEvent`. Add the Phase 06 compiler command to the required gate after baseline compiler errors are addressed.

---

_Reviewed: 2026-08-05T10:31:57Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
