---
phase: 01-napplet-contract-artifact-verification
reviewed: 2026-08-04T00:00:00Z
depth: standard
files_reviewed: 36
files_reviewed_list:
  - fixtures/capability-harness/fixture.json
  - fixtures/capability-harness/src/App.tsx
  - fixtures/minimal/fixture.json
  - fixtures/minimal/src/App.tsx
  - fixtures/rejections/cases.json
  - infra/toolchain/Dockerfile
  - infra/toolchain/denial-probe.ts
  - infra/toolchain/egress-policy.json
  - infra/toolchain/fixture-runner.ts
  - package.json
  - policy/upstream-coverage.json
  - scripts/build-toolchain-image.ts
  - scripts/test-promotion.ts
  - scripts/verify-design-slice.ts
  - src/evidence/bundle.ts
  - src/fixtures/registry.ts
  - src/policy/artifact-contract.ts
  - src/promotion/candidate.ts
  - src/promotion/run-promotion.ts
  - src/promotion/schema.ts
  - src/runner/hermetic-command.ts
  - src/runner/sealed-toolchain.ts
  - src/verification/design-evidence.ts
  - tests/evidence/bundle.test.ts
  - tests/fixtures/capability-harness.test.ts
  - tests/fixtures/fake-toolchain.ts
  - tests/fixtures/minimal.test.ts
  - tests/policy/artifact-contract.test.ts
  - tests/promotion/candidate.test.ts
  - tests/runner/hermetic-command.test.ts
  - tests/runner/sealed-toolchain.test.ts
  - tests/tracer.test.ts
  - tests/verification/design-evidence.test.ts
  - toolchains/candidates/cli-0.5.2-release-set.json
  - toolchains/candidates/cli-0.5.2.json
  - toolchains/candidates/initial.json
findings:
  critical: 4
  warning: 1
  info: 0
  total: 5
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-08-04T00:00:00Z  
**Depth:** standard  
**Files Reviewed:** 36  
**Status:** issues_found

## Summary

Phase 1 has useful argv-only and default-deny building blocks, and `bun test` passes (52 tests). However, the production-facing seams currently allow a policy for one candidate to run another candidate and manufacture positive-looking evidence that was never measured. These are correctness/security defects, not the explicitly deferred Phase 7 certification work.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Sealed execution does not bind the policy candidate to the requested candidate

**Classification:** BLOCKER  
**File:** `src/runner/sealed-toolchain.ts:119`  
**Issue:** `runSealedToolchain` parses a policy containing an immutable `candidateId`, but never compares it with `request.toolchainId`. `runPromotionCandidate` supplies the manifest-derived ID at `src/promotion/run-promotion.ts:121-145`, so a fully shaped but different manifest can be run through the policy that was approved for `a19fc7d…`. The Docker image reference is then derived from the unbound request digest. The input-builder verifies this relationship, but the actual execution boundary does not.

**Fix:** Reject before constructing Docker argv unless `policy.candidateId === request.toolchainId`; add a regression test that attempts a different well-formed toolchain ID with the committed policy and expects rejection.

### CR-02: Review-ready promotion bundles claim artifact, golden, reproducibility, and provenance evidence that was not produced

**Classification:** BLOCKER  
**File:** `src/promotion/run-promotion.ts:87-100`  
**Issue:** The tracer uses the first pinned fixture digest as the built-artifact digest, the first pinned golden digest as a verified golden, unconditionally records reproducibility as `matched` after one run, and emits `example.invalid` package provenance URLs. Consequently, a successful tracer returns `review-ready` with evidence that looks verified but was neither built, compared, nor sourced from the candidate. This is a false positive evidence claim, distinct from deferring exhaustive Phase 7 reproducibility/golden certification.

**Fix:** Make the tracer/design path record these layers as explicitly unmeasured/deferred (and never `review-ready` on their basis), or require actual fixture output, two-build comparison, approved golden data, and candidate-provided provenance origins before permitting those positive values. Extend the evidence schema so “not evaluated” cannot be represented as `matched`.

### CR-03: A real failed fixture stage is rejected instead of preserved as the promised structured blocked result

**Classification:** BLOCKER  
**File:** `infra/toolchain/fixture-runner.ts:70-75` and `src/fixtures/registry.ts:87-115`  
**Issue:** The image-local runner appends a stage result before throwing when its exit code is non-zero. Its catch block then emits `status: "blocked"` with that partial stage array. `parseRunnerOutput` nevertheless routes every blocked stage through `parseStage`, which requires `exitCode === 0`. Any native failure after a stage begins therefore throws `fixture <stage> stage evidence is invalid` instead of returning the structured blocked result described in the Phase 1 summary. Current tests cover only an empty blocked stage list, and the design script fakes that empty list, so they miss the actual runner behavior.

**Fix:** Parse a blocked run separately: permit one final failed stage with valid digests and a non-zero exit code (and reject later stages), while retaining the failure reason. Add an integration-style parser test using a blocked `create` stage with `exitCode: 1`.

### CR-04: Capability-harness evidence is hard-coded, while the app never executes the claimed storage/intent flow

**Classification:** BLOCKER  
**File:** `fixtures/capability-harness/src/App.tsx:6-17` and `infra/toolchain/fixture-runner.ts:92`  
**Issue:** `saveValue` contains the storage and optional-intent calls but `App` never calls it or offers an interaction that does. Independently, the runner reports `storage` and (in primary mode) `intent` as observed and sets `intentUsedThroughSdk: true` solely from fixture name/mode. A successful native fixture would therefore claim public-SDK intent composition without exercising it. The mocked tests assert the same static fields and cannot detect this false positive.

**Fix:** Make the fixture run a deterministic interaction that invokes `saveValue` in both modes, and derive observed-domain evidence from the runtime/instrumented SDK report rather than fixture-mode constants. Add a test that fails when the primary path never invokes the SDK intent operation.

## Warnings

### WR-01: Dist-tree identity loses directory structure during recursion

**Classification:** WARNING  
**File:** `infra/toolchain/fixture-runner.ts:22-30`  
**Issue:** Recursive calls reset `root`, so nested files are recorded relative only to their immediate parent. Moving an unchanged file between similarly named nested directories can leave the recorded identities indistinguishable, despite `distSha256` being described as a complete dist-tree identity.

**Fix:** Pass the original root through recursion and always use `relative(originalRoot, path)`. Add a nested-directory fixture test that verifies the hash changes when a file’s parent path changes.

---

_Reviewed: 2026-08-04T00:00:00Z_  
_Reviewer: the agent (gsd-code-reviewer)_  
_Depth: standard_
