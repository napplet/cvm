---
phase: 06
fixed_at: 2026-08-05T10:16:07Z
review_path: .planning/phases/06-sealed-preview-user-owned-publication/06-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 06: Code Review Fix Report

**Fixed at:** 2026-08-05T10:16:07Z  
**Source review:** `.planning/phases/06-sealed-preview-user-owned-publication/06-REVIEW.md`  
**Iteration:** 1

**Summary:**

- Findings in scope: 6
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: Caller-supplied capability review can bypass required-capability approval

**Files modified:** `src/publication/capability-review.ts`, `src/publication/publication-intent.ts`, `tests/phase-06/publication-intent.test.ts`  
**Commit:** 5564712  
**Applied fix:** Recompute canonical capability approval from the sealed artifact, require identity fences, and verify its digest before an intent is created.

### CR-02: SQLite cannot execute the transaction callbacks used by PublicationService

**Files modified:** `src/persistence/sqlite-publication-store.ts`, `tests/phase-06/publication-reconciliation.test.ts`  
**Commit:** 22c457f  
**Applied fix:** Separate async callback serialization from synchronous SQLite transactions, avoiding Promise cloning and queue re-entry; added service-on-SQLite coverage.

### CR-03: Intent creation bypasses the durable idempotency API

**Files modified:** `src/publication/publication-intent.ts`, `src/publication/publication-service.ts`, `src/persistence/publication-store.ts`, `src/persistence/sqlite-publication-store.ts`, `tests/phase-06/publication-intent.test.ts`  
**Commit:** 77bcda1  
**Applied fix:** Route creation through durable create-or-replay with a stable request fingerprint that excludes coordinator timestamps; covered later-clock replay on memory and SQLite.

### CR-04: Concurrent request can bypass the owner check and receive another owner’s result

**Files modified:** `src/publication/publication-service.ts`, `tests/phase-06/publication-reconciliation.test.ts`  
**Commit:** 8b4dbc8  
**Applied fix:** Authorize the owner before in-flight lookup and scope in-flight entries by account plus intent; added concurrent cross-owner denial coverage.

### CR-05: The PostgreSQL publication authority cannot back PublicationService

**Files modified:** `src/persistence/postgres-sql-funding-store.ts`, `migrations/phase-06/001_publication.sql`, `tests/phase-06/publication-store-parity.test.ts`  
**Commit:** 5f6fb8b  
**Applied fix:** Added a PostgreSQL-backed `DurablePublicationStore` facade, signed-owner-event persistence, and migration/interface coverage.

### WR-01: The reference-set evaluator hard-codes its observations instead of reading test results

**Files modified:** `tests/evals/phase-06-reference-set.test.ts`, `tests/phase-06/reference-observation.ts`, Phase 06 scenario tests  
**Commit:** 9c08e57  
**Applied fix:** Referenced scenarios now emit structured, post-assertion observations; the evaluator parses and compares those observations instead of mapping fixture labels.

---

_Fixed: 2026-08-05T10:16:07Z_  
_Fixer: the agent (gsd-code-fixer)_  
_Iteration: 1_
