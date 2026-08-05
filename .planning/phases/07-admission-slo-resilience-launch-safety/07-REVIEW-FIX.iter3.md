---
phase: 07
fixed_at: 2026-08-05T22:36:17Z
review_path: .planning/phases/07-admission-slo-resilience-launch-safety/07-REVIEW.md
iteration: 3
findings_in_scope: 1
fixed: 1
skipped: 0
status: all_fixed
---

# Phase 07: Code Review Fix Report

**Fixed at:** 2026-08-05T22:36:17Z
**Source review:** `.planning/phases/07-admission-slo-resilience-launch-safety/07-REVIEW.md`
**Iteration:** 3

**Summary:**

- Findings in scope: 1
- Fixed: 1
- Skipped: 0

## Fixed Issues

### CR-05: Direct promotion can authenticate a different trusted archive than the release manifest

**Files modified:** `src/promotion/run-promotion.ts`, `tests/phase-07/promotion-gate.test.ts`
**Commit:** `2806dd5`
**Applied fix:** The sole evaluator now exact-compares the caller-supplied source measurement with the canonical source revision and SHA derived from the release manifest before consulting the trust root or decision cache. The new two-archive regression proves that a root which pins archives A and B cannot promote manifest A using measurement B, even after archive A is mutated or removed.

## Verification

- TDD regression: the two-archive substitution test failed before the fix because the trust root accepted measurement B; it passes after the manifest-binding check.
- Focused suite: `bun test tests/phase-07/promotion-gate.test.ts` — 17 passing tests.
- Full suite: `bun test` — 518 passing tests, 0 failures.

---

_Fixed: 2026-08-05T22:36:17Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 3_
