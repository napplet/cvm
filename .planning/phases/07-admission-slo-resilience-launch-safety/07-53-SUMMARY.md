---
phase: 07-admission-slo-resilience-launch-safety
plan: "53"
subsystem: development-model-proposals
tags: [postgres, model-gateway, metering, source-proposal, openai-responses]
requires:
  - phase: 07
    provides: local PostgreSQL funding composition and metered action contracts
provides:
  - immutable owner/action-bound source proposals with PostgreSQL recovery
  - proposal-only worker handoff for the metered generation path
  - explicit deterministic or source-attributed configured-provider model selection
affects: [07-54, 07-56]
tech-stack:
  added: []
  patterns: [content-addressed source proposal, original-operation provider observation, source-attributed rational price card]
key-files:
  created: [migrations/development/001_generation.sql, migrations/development/002_provider_observations.sql, src/dev/source-proposal-store.ts, src/dev/development-model-gateway.ts, src/dev/dev-composition.ts, tests/dev/model-proposal.integration.test.ts]
  modified: [src/model/model-gateway.ts, src/model/deterministic-model-gateway.ts, src/model/price-card.ts, src/phase-02/contracts.ts, src/phase-04/metered-generation-service.ts, src/phase-04/napplet-harness.ts, scripts/dev-payments.ts]
decisions:
  - "Generated sources are content-addressed and bound to operation, account, session, action, fingerprint, prior artifact, and approved paths before worker use."
  - "Configured OpenAI Responses mode requires fresh source-attributed price and conversion provenance; missing configuration remains explicitly deterministic."
metrics:
  tasks_completed: 3
  files_modified: 14
status: complete
---

# Phase 07 Plan 53: Durable Metered Source Proposal Summary

**A paid model operation now persists exactly the bounded source it charged for, recovers it from PostgreSQL after reconnect, and passes that source to the worker without an independent idea-generation input.**

## Accomplishments

- Added checksum-protected development migrations for immutable source proposals and original provider observations.
- Extended model contracts with bounded prompts, authorized prior-artifact references, opaque proposal references, and terminal proposal correlations.
- Made deterministic source generation produce safe vanilla TypeScript application surfaces (`src/main.ts`, `src/styles.css`, and the checked domain helper) keyed by request fingerprint; no prompt text is interpolated into generated code.
- Added action-bound proposal resolution before the worker boundary, while retaining legacy fixture input compatibility.
- Added the strict development selector: absent complete server-only provider configuration yields `Deterministic fixture`; configured OpenAI Responses requests use a fixed schema, provider response identity, authoritative native usage, and a source-attributed price card.

## Task Commits

1. `17e8a9a` — Persist deterministic source proposals.
2. `a9db077` — Hand charged proposals to workers.
3. `07ba98f` — Add configured model proposal gateway.
4. `05a64de` — Cover charged proposal handoff.
5. `1210b2f` — Persist configured-provider observations for lookup-only recovery.

## Verification

- `bun scripts/dev-payments.ts up && bun test tests/dev/model-proposal.integration.test.ts --test-name-pattern 'deterministic proposal SQL dispatch lookup restart replay'` — passed.
- `bun test tests/dev/model-proposal.integration.test.ts --timeout 120000` — 3 passed, including real development PostgreSQL reconnect/replay and the metered worker handoff.
- `bun test tests/phase-04/tracer.test.ts tests/phase-04/artifact-outcome.test.ts --timeout 120000` — 5 passed.
- `bun test tests/model/reconciliation.test.ts tests/billing/price-card.test.ts --timeout 120000` — 11 passed.
- Root manifest hashes remained pinned: `package.json` `cbcc433278d32391b075576ebd847ae30039f1d86ad229a149f5566856989f23`; `bun.lock` `8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Registered development proposal migrations in the local runner**
- **Found during:** Task 1
- **Issue:** The local PostgreSQL runner did not load the development proposal schema.
- **Fix:** Added the proposal and provider-observation migrations to its checksum-protected ordered list.
- **Files modified:** `scripts/dev-payments.ts`, `migrations/development/002_provider_observations.sql`

**2. [Rule 2 - Critical recovery] Persisted configured-provider observation receipts separately from proposal bytes**
- **Found during:** Task 3
- **Issue:** A configured provider result needed an original-response lookup path after restart without a replacement dispatch.
- **Fix:** Added immutable `provider_observations` bound to the proposal digest and original request identity.
- **Files modified:** `src/dev/source-proposal-store.ts`, `src/dev/development-model-gateway.ts`, `migrations/development/002_provider_observations.sql`

## Known Stubs

None. A real provider call remains conditional on server-only credentials and fresh immutable price/conversion evidence; without them the selector truthfully stays deterministic.

## Self-Check: PASSED

All Plan 53 source, migration, test, and summary files exist. All five listed commits are present. No Plan 53 commit deleted tracked files.
