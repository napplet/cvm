---
phase: 06
fixed_at: 2026-08-05T10:41:31Z
review_path: .planning/phases/06-sealed-preview-user-owned-publication/06-REVIEW.md
iteration: 3
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 06: Code Review Fix Report

**Fixed at:** 2026-08-05T10:41:31Z
**Source review:** `.planning/phases/06-sealed-preview-user-owned-publication/06-REVIEW.md`
**Iteration:** 3

**Summary:**

- Findings in scope: 3
- Fixed: 3
- Skipped: 0

## Fixed Issues

### CR-01: Bind deployment bytes to the sealed artifact manifest

**Files modified:** `src/publication/contracts.ts`, `src/publication/napplet-cli-adapter.ts`, `tests/phase-06/fakes.ts`, `tests/phase-06/sealed-deployment.test.ts`, `tests/phase-06/tracer.test.ts`
**Commits:** b92b438, 5da2c11
**Applied fix:** The adapter derives a canonical aggregate from trusted sealed file facts, rejects mismatched and substituted supplied files, and no longer accepts caller-provided aggregate strings as proof.

### CR-02: Fail closed on untrusted deployment-source outcomes

**Files modified:** `src/publication/napplet-cli-adapter.ts`, `tests/phase-06/sealed-deployment.test.ts`
**Commit:** 8d4ecab
**Applied fix:** Upload and relay observations are checked locally for the original operation, valid state, and completion evidence; source `networkDeploySucceeded` is not trusted or invoked. Partial and unknown relay outcomes remain non-complete.

### WR-01: Normalize SQLite absence and use supported Bun types

**Files modified:** `package.json`, `bun.lock`, `tsconfig.json`, `src/persistence/sqlite-publication-store.ts`, `src/publication/contracts.ts`, `tests/phase-06/fakes.ts`, `tests/phase-06/sealed-deployment.test.ts`
**Commit:** 8ebf1d6
**Applied fix:** Added the pinned Bun type package/configuration, normalized absent SQLite rows to `undefined`, bound nullable SQL values explicitly, and kept the touched Phase 06 tests type-clean under the scoped compiler check.

---

_Fixed: 2026-08-05T10:41:31Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 3_
