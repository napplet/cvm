---
phase: 07
fixed_at: 2026-08-05T21:37:36Z
review_path: .planning/phases/07-admission-slo-resilience-launch-safety/07-REVIEW.md
iteration: 2
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 07: Code Review Fix Report

**Fixed at:** 2026-08-05T21:37:36Z
**Source review:** `.planning/phases/07-admission-slo-resilience-launch-safety/07-REVIEW.md`
**Iteration:** 2

**Summary:**

- Findings in scope: 6
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: A self-authenticated release bundle can manufacture a promoted decision

**Files modified:** `src/certification/trust.ts`, `src/promotion/candidate.ts`, `src/promotion/run-promotion.ts`, `tests/phase-07/promotion-gate.test.ts`
**Commit:** d9e7c25
**Applied fix:** Promotion now requires a configured operator/protected-certifier trust root to authenticate the manifest, observations, and both verification records. The public release-evidence command has no trust root and stays blocked; tests show rehashed public content cannot promote.

### CR-02: The claimed source SHA-256 is never computed from source bytes

**Files modified:** `src/certification/reproducibility.ts`, `tests/phase-07/reproducibility.test.ts`, `tests/phase-07/promotion-gate.test.ts`, `tests/phase-07/certification-runner.test.ts`
**Commit:** 6e97c23
**Applied fix:** Reproducibility input now carries an immutable source reference plus byte measurement that the protected trust root must verify. The redacted persisted record binds the measured source digest and reference hashes.

### CR-03: Future-dated verification records bypass the freshness window

**Files modified:** `src/certification/reproducibility.ts`, `src/certification/supply-chain.ts`, `tests/phase-07/reproducibility.test.ts`, `tests/phase-07/supply-chain.test.ts`, `tests/phase-07/promotion-gate.test.ts`
**Commit:** 850d68d
**Applied fix:** Reproducibility and supply-chain validators reject timestamps beyond the authority clock before evaluating maximum age; promotion regression coverage verifies the resulting block.

### WR-01: The supposed immutable Git revision accepts invalid intermediate-length IDs

**Files modified:** `src/certification/contracts.ts`, `src/certification/reproducibility.ts`, `src/certification/phase-07-reference-set.ts`, `src/certification/evidence.ts`, `src/certification/supply-chain.ts`, `src/promotion/candidate.ts`, `src/promotion/schema.ts`, `tests/phase-07/promotion-gate.test.ts`
**Commit:** ba54962
**Applied fix:** Every relevant release revision parser now accepts exactly 40 or 64 hexadecimal characters, with regression coverage for 41- and 63-character rejection.

### CR-04: Memoized promotion bypasses manifest and evidence authentication

**Files modified:** `src/promotion/run-promotion.ts`, `tests/phase-07/promotion-gate.test.ts`
**Commit:** `e3217fb`
**Applied fix:** The evaluator independently authenticates the manifest, observations, and verification records before cache access; its cache key includes a canonical fingerprint of those exact values and the candidate ID. The promotion runner now forwards its configured trust root. Regression coverage proves a changed manifest with the same release ID cannot reuse a promoted cache entry.

### WR-02: The reproducibility CLI has no way to supply the mandatory source-measurement trust root

**Files modified:** `src/certification/trust.ts`, `scripts/verify-phase-07-reproducibility.ts`, `tests/phase-07/reproducibility.test.ts`
**Commit:** `83bd9e8`
**Applied fix:** The command requires a digest-pinned operator trust-root module under an explicit protected root and passes it to both verification and record writing. The concrete trust root re-hashes protected immutable source archive bytes before trusting a source measurement; absent, invalid, or modified configuration fails closed.

## Verification

- TDD regressions: changed manifest cache replay and configured reproducibility command both failed before the fixes and pass afterward.
- Focused suites: `bun test tests/phase-07/promotion-gate.test.ts` and `bun test tests/phase-07/reproducibility.test.ts` passed.
- Full Phase 07 suite: `bun test tests/phase-07` — 79 passing tests, 0 failures.
- Targeted TypeScript check found no errors in the modified files; unrelated project-wide TypeScript errors remain outside this fix.

---

_Fixed: 2026-08-05T21:37:36Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 2_
