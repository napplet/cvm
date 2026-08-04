---
phase: 01-napplet-contract-artifact-verification
fixed_at: 2026-08-04T00:00:00Z
review_path: .planning/phases/01-napplet-contract-artifact-verification/01-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-08-04T00:00:00Z  
**Source review:** `.planning/phases/01-napplet-contract-artifact-verification/01-REVIEW.md`  
**Iteration:** 1

**Summary:**

- Findings in scope: 5
- Fixed: 5
- Skipped: 0

## Fixed Issues

### CR-01: Sealed execution does not bind the policy candidate to the requested candidate

**Files modified:** `src/runner/sealed-toolchain.ts`, `tests/runner/sealed-toolchain.test.ts`  
**Commit:** `35753f4`  
**Applied fix:** The parsed policy candidate ID must equal the requested toolchain ID before Docker argv construction; a mismatched well-formed candidate is rejected without execution.

### CR-02: Review-ready promotion bundles claim evidence that was not produced

**Files modified:** `src/evidence/bundle.ts`, `src/promotion/run-promotion.ts`, `tests/evidence/bundle.test.ts`, `tests/tracer.test.ts`  
**Commit:** `915bcf1`  
**Applied fix:** Artifact/golden, reproducibility, and provenance layers now support an explicit `not-evaluated` state. A native trace records those deferred layers and remains blocked at `certification-deferred`; `review-ready` requires measured artifacts, matched reproducibility, and verified provenance.

### CR-03: A real failed fixture stage is rejected instead of preserved as a structured blocked result

**Files modified:** `src/fixtures/registry.ts`, `tests/fixtures/minimal.test.ts`  
**Commit:** `c26cce7`  
**Applied fix:** Blocked reports may carry a prefix of successful stages followed by exactly one final, non-zero native stage and a required reason. Such results retain `blocked` status and cannot be parsed as passing evidence.

### CR-04: Capability-harness evidence is hard-coded while the app never executes its claimed flow

**Files modified:** `fixtures/capability-harness/src/App.tsx`, `infra/toolchain/fixture-runner.ts`, `tests/fixtures/capability-harness.test.ts`  
**Commit:** `7df4a48`  
**Applied fix:** The fixture deterministically invokes `saveValue` after mount, including public SDK intent use when present. The runner accepts capability observations only from a runtime-instrumented report and emits no unproven observations in a blocked result.

### WR-01: Dist-tree identity loses directory structure during recursion

**Files modified:** `infra/toolchain/fixture-runner.ts`, `tests/fixtures/fixture-runner.test.ts`  
**Commit:** `15eee2e`  
**Applied fix:** Recursive dist traversal preserves the original root, so identities include complete relative paths; the regression test verifies moving an unchanged nested file changes the tree digest.

---

_Fixed: 2026-08-04T00:00:00Z_  
_Fixer: the agent (gsd-code-fixer)_  
_Iteration: 1_
