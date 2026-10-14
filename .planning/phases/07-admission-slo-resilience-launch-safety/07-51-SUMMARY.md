---
phase: 07-admission-slo-resilience-launch-safety
plan: "51"
subsystem: development-funding
tags: [cashu, nwc, postgres, docker, e2e]
requires: []
provides:
  - Automatic two-mint, NWC, relay and migrated PostgreSQL development environment
  - Reusable development composition of real payment rails and application funding coordinators
  - Durable ledger replay and pending invoice restart coverage
affects: [development-e2e]
tech-stack:
  added: [PostgreSQL 17.11 Docker service]
  patterns: [loopback development adapters, checked local migrations, disposable integration stacks]
key-files:
  created: [scripts/dev-funding.ts, tests/dev/funding.e2e.test.ts, tests/dev/funding.test.ts]
  modified: [scripts/dev-payments.ts, infra/dev-payments/compose.yaml, src/funding/lightning-top-up.ts, tests/funding/lightning-top-up.test.ts, .github/workflows/development-payments.yml, docs/runbooks/development-payments.md, docs/runbooks/production-readiness-deferred.md, README.md]
key-decisions:
  - Development work proceeds independently of deferred production plans 07-20 and 07-26.
  - Two independent local mints satisfy the existing multi-mint policy through reserved development aliases and an exact loopback-only custom request seam.
  - Existing PostgreSQL repositories and rail coordinators own credits; no synthetic ledger seed or settlement-success adapter.
  - An NWC create response lost before its hash is recorded remains unknown without blind reissue.
requirements-completed: []
metrics:
  completed_date: 2026-10-14
  tasks_completed: 2
---

# Phase 07 Plan 51: Local application funding

The automatic development stack now includes two independent Nutshell mints, Alby Hub/NWC, a Nostr relay and PostgreSQL. Setup applies all four existing migrations with checksum tracking, retains the encrypted-material key across restarts, and keeps published ports on loopback. Test runs use separate projects, credentials, volumes and ephemeral ports and clean them in `finally`.

`createDevelopmentFunding` connects actual signed NWC observations and Cashu swaps to `FundingService`, the rail coordinators and `PostgresFundingDatabase`. The existing production HTTPS mint policy remains intact; development-only aliases route to the two local mints through cashu-ts's custom request seam. No package manifest or lockfile change was needed.

## Completed tasks and commits

- `2ee5c3d`: recorded the development plan under the resumed autonomous workflow.
- `f928f36`: fixed duplicate protected invoice storage discovered by real pending-invoice polling, with a failing-then-passing regression test.
- `5631b20`: automatic durable development composition, application e2e, loopback/cancellation tests, and CI coverage.

## Verification

- `bun scripts/dev-payments.ts test`: both Docker e2e suites passed. Actual swaps at both independent mints and NWC settlement produced four balanced ledger transactions, four billing credits and four account-credit outbox events. Final available balance was exactly 1,358 sats. Exact replay and owner/amount conflicts preserved balances. Closing application connections and restarting all containers preserved wallet identity, ledger data and encrypted pending invoice recovery.
- `bun test tests/funding/lightning-top-up.test.ts tests/dev/funding.test.ts`: 12 passed, including external endpoint rejection, cancellation before relay connection, unknown-create handling and invoice material reuse/expiry.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000`: 681 passed, 2 Docker tests skipped, 0 failed; 5,189 assertions across 126 files.
- `bun scripts/dev-payments.ts`: successfully upgraded the existing local stack; five development services are running, private config refreshed, no test stacks left behind.
- `git diff --check`: passed.
- Exploratory `bunx tsc --noEmit` remains red on existing repository-wide diagnostics (for example typed-array compatibility and release/test contract typing). No diagnostics remained in the new development modules/tests after their fixes. This is not reported as a passing typecheck.

## Plan deviation

The first real application test reached the correct balance and passed restart/replay checks, but found two unexpired orphan invoice records. Repeated `created` observations sealed another copy before noticing a stored invoice already existed. The coordinator now validates and reuses the stored identity and expires a redundant copy if another observer wins the persistence race. A regression reproduced the leak before the fix. An unrelated existing 50ms timeout test failed once under load, then passed in focused and full runs without changing its deadline.

## Scope and deferred work

This verifies the application funding/ledger boundary with simulated Lightning settlement. ContextVM/CEP-8 wire negotiation and full generation-session e2e remain separate development work. Durable Cashu treasury custody, recovery of ambiguous swaps, and lost NWC-create responses require further work before production; these are recorded in the production follow-up runbook. Local credits do not certify real Lightning routing or protected release evidence.

Production plans 07-20/07-26 remain deferred at user direction. Phase 7 and its five live requirements remain unverified; no release gate or production approval was bypassed. Autonomous execution has no further runnable recorded plans after this development plan.

## Self-check

PASS: the new composition/tests and referenced commits exist; the test environment was cleaned; the default development stack remains ready; no local credentials or unrelated untracked artifacts were staged.
