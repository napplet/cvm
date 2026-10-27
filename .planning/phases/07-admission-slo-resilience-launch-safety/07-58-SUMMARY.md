---
phase: 07-admission-slo-resilience-launch-safety
plan: 58
subsystem: production operations documentation
tags: [architecture, migration, safety, multi-repository]
requires: [07-PRODUCTION-RESUMPTION.md, 07-CONTEXT.md]
provides: [production architecture boundary, backup-first migration runbook]
affects: [future provisioning, certification, cutover plans]
tech-stack:
  added: []
  patterns: [receipt-gated change control, realm separation, restore-before-cutover]
key-files:
  created:
    - docs/runbooks/production-architecture.md
    - docs/runbooks/production-migration.md
    - /Users/sandwich/Develop/homelab/ops/cvm/production-architecture.md
  modified: []
decisions:
  - Keep private Beta as development evidence and data source while production construction remains blocked.
  - Use one Cloud SQL PostgreSQL 17 regional-HA authority; correct the incompatible two-region SQL quantity in downstream work.
  - Preserve compatible non-monetary history while production-real money authority begins at zero.
metrics:
  tasks_completed: 2
  files_created: 3
  completed_date: 2026-10-27
status: complete
---

# Phase 07 Plan 58: Production Architecture and Migration Boundaries Summary

Documented the receipt-gated production topology and a backup-first migration path without changing a provider, wallet, routing rule, deployment, or production authority.

## Completed Tasks

1. Recorded matching CVM and homelab architecture boundaries: private Beta stays available as the development source; production requires two warm Cloud Run regions, one Cloud SQL PostgreSQL 17 regional-HA authority, encrypted versioned dual-region GCS, and measured Modal/Fly worker cohorts.
2. Recorded an inventory, fresh-instance restore, quiesce/checkpoint, certification, cutover, abort, and forward-recovery procedure that preserves non-monetary history but rejects development monetary authority.

## Commits

- `0513166` — `docs(07-58): define production architecture boundary` (CVM repository)
- `8afc341` — `docs(cvm): define production architecture boundary` (homelab repository)
- `9b0aa5e` — `docs(07-58): define backup-first migration` (CVM repository)

## Decisions Made

- The working Coolify/Beta deployment remains private development infrastructure, including its existing ChatGPT credential, identity, projects, artifacts, test-ledger history and audits. Its single host, host-local volumes, and privileged nested Docker engine cannot support production HA or sandbox claims.
- `development-test` and `production-real` are distinct realms. Compatible schemas and project/artifact/receipt/audit history may migrate, including development migration files, while production money and role authority begin at zero and reject development adapters, fixtures, faucets, synthetic pricing and development keys.
- Cloud SQL regional HA is a single-region authority. The conflicting two-region Cloud SQL quantity in downstream planning must be corrected/rebound; two Cloud Run regions do not imply cross-region SQL continuity.
- After any real-money effect, stale financial backups must never overwrite the production ledger. Recovery is query-only reconciliation by original operation identity plus forward recovery or audited compensation.

## Verification

- `git diff --check` passed in both repositories.
- Content checks confirmed the locked Cloud Run, Cloud SQL, GCS, Modal/Fly, realm separation, ContextVM-only public generation, fresh restore, receipt gate, and stale-ledger recovery boundaries.
- No runtime, provider, wallet, secret, deployment, or live configuration action was run.

## Remaining Runtime and Evidence Work

- Implement and test the planned root CVM production commands; current `./homelab cvm` commands remain Beta-only.
- Build the receipt-gated production configuration and provision it only after a candidate-bound authorization receipt validates.
- Capture a consistent Beta backup, quiesce/checkpoint active work, and restore into a fresh isolated instance with row, object-generation, digest, identity, and migration comparisons.
- Measure equivalent Modal and Fly cohorts, run the eight certification suites, and collect the required admission, restore, security, payment-model, and publication evidence.
- Prove recovery objectives through live drills. RTO/RPO and cross-region database continuity remain unclaimed until then.
- Push, review, and merge the independent CVM and homelab commits before any configuration is allowed to affect live state.

## Deviations from Plan

None - plan executed as documentation-only preparation. Minor trailing-whitespace normalization was applied before committing so `git diff --check` passes.

## Self-Check: PASSED

All three requested documents exist and the recorded commits are present on their respective feature branches. Plan completion means the documentation tasks are complete; it does not assert production readiness or authorize execution.
