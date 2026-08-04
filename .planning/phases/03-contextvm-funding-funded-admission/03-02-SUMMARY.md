---
phase: 03-contextvm-funding-funded-admission
plan: 02
subsystem: payments
tags: [postgres, ledger, funding, idempotency, supply-chain]
requires:
  - phase: 03-01
    provides: transport-neutral FundingStore port and funded-account tracer
provides:
  - Exact package intake gate and locked funding adapter dependencies
  - Serializable append-only funding-store migration and deterministic PostgreSQL-wire seam
affects: [03-03, 03-04, 03-05, 03-06, 03-07]
tech-stack:
  added: ["@contextvm/sdk@0.13.10", "@cashu/cashu-ts@4.7.2", "kysely@0.29.4", "pg@8.22.0"]
  patterns: [exact design-stage package evidence, injected serializable funding executor, replay-before-effect]
key-files:
  created: [scripts/verify-phase-03-packages.ts, evidence/phase-03/package-intake.json, migrations/phase-03/001_funding.sql, src/persistence/postgres-funding-store.ts, tests/persistence/postgres-funding-store.test.ts]
  modified: [package.json, bun.lock]
key-decisions:
  - "Production monetary composition requires an explicit PostgreSQL-wire executor; SQLite and the Phase 3 memory double are not fallbacks."
  - "The package gate is autonomous and fail-closed for concrete identity, source, license, lifecycle, integrity, and tarball ambiguity; exhaustive provenance remains Phase 7."
requirements-completed: [CTX-02, CTX-03, CTX-04, PAY-04, PAY-05, BILL-01, BILL-02, BILL-06]
coverage:
  - id: D1
    description: Exact Phase 3 integration packages are admitted through immutable design-stage evidence.
    requirement: CTX-02
    verification:
      - kind: integration
        ref: bun run scripts/verify-phase-03-packages.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Funding replay, uniqueness, holds, rollback, conservation projection, and bounded serialization retry are deterministic.
    requirement: PAY-05
    verification:
      - kind: integration
        ref: tests/persistence/postgres-funding-store.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 18min
  completed: 2026-08-04
status: complete
---

# Phase 3 Plan 02: PostgreSQL Funding Authority Summary

**Exact adapter packages are locked through a fail-closed intake gate, and funding commands now run through an injected serializable, append-only PostgreSQL-wire ledger seam.**

## Accomplishments

- Verified four exact package identities against registry metadata, tarball SRI/SHA-256, official repositories, approved licenses, and unsafe lifecycle scripts before locking them.
- Added the PostgreSQL/Cockroach-compatible funding migration: commands, double-entry postings, projections, settlement identities, policies, protected material, holds, admissions, treasury records, and non-generation outbox.
- Implemented durable-style replay, independent settlement uniqueness, balance holds, outbox emission, transaction rollback, projection checks, and bounded SQLSTATE 40001 retry through an explicit executor seam.

## Task Commits

1. Task 1 package intake — `a72da45` (`build`)
2. Task 2 RED store tests — `9277646` (`test`)
3. Task 2 funding authority — `f15781a` (`feat`)

## Verification

- `bun run scripts/verify-phase-03-packages.ts` — pass
- `bun pm ls @contextvm/sdk @cashu/cashu-ts kysely pg` — exact versions present
- `bun test tests/persistence/postgres-funding-store.test.ts` — 4 pass
- `bun test` — 195 pass, 0 fail

## Decisions Made

- The store accepts only an explicit `PostgresFundingExecutor`; the deterministic executor is test-only and does not become a production fallback.
- Retry closures contain only canonical funding mutation logic. External provider/capacity effects remain outside retries and are represented by later coordinator plans.

## Deviations from Plan

None - plan executed as written. The deterministic PostgreSQL-wire seam is deliberately not a claim of live Cockroach/PostgreSQL production certification.

## Next Phase Readiness

Plans 03-03 through 03-06 can compose their transport and rail adapters over the canonical `FundingStore` port. Live provider/database certification remains an explicit Phase 7 gate.

## Self-Check: PASSED

- All five planned implementation/evidence files exist.
- Task commits `a72da45`, `9277646`, and `f15781a` exist.
