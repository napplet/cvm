---
phase: 07-admission-slo-resilience-launch-safety
plan: "53"
subsystem: development-model-proposals
tags: [postgres, model-gateway, metering, source-proposal, openai-responses]
requires:
  - phase: 07
    provides: local PostgreSQL funding composition and metered action contracts
provides:
  - immutable operation-bound source proposals with PostgreSQL recovery
  - proposal-only worker handoff for the metered generation path
  - explicit deterministic or source-attributed configured-provider model selection
affects: [07-54, 07-56]
tech-stack:
  added: []
  patterns: [content-addressed source proposal, original-operation provider observation, source-attributed rational price card]
key-files:
  created: [migrations/development/001_generation.sql, migrations/development/002_provider_observations.sql, migrations/development/004_source_proposal_bindings.sql, src/dev/source-proposal-store.ts, src/dev/development-model-gateway.ts, src/dev/dev-composition.ts, tests/dev/model-proposal.integration.test.ts]
  modified: [src/model/model-gateway.ts, src/model/deterministic-model-gateway.ts, src/model/price-card.ts, src/phase-02/contracts.ts, src/phase-04/metered-generation-service.ts, src/phase-04/napplet-harness.ts, scripts/dev-payments.ts]
decisions:
  - "Generated sources are content-addressed and each operation remains independently bound to account, session, action, fingerprint, prior artifact, and approved paths before worker use."
  - "Configured OpenAI Responses mode requires fresh source-attributed price/conversion capture and matching operator-configured rational profile/card ceilings; all-or-nothing configuration remains explicitly deterministic."
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
- Made deterministic source generation produce safe vanilla TypeScript application surfaces (`src/main.ts`, `src/styles.css`) keyed by request fingerprint; it imports the original protected domain helper and no prompt text is interpolated into generated code.
- Added action-bound proposal resolution before the worker boundary, while retaining legacy fixture input compatibility.
- Added the strict development selector: only a fully absent server-only provider configuration yields `Deterministic fixture`; partial configuration fails with an actionable error. Configured OpenAI Responses requests use bounded input/output, authoring/system instructions, owner-bound prior source injection, raw REST `output[]` parsing that ignores reasoning content, native model/metadata binding, normalized inclusive usage, operator-configured source-provenance checks, and original-response GET reconciliation before replay can report a receipt.

## Task Commits

1. `17e8a9a` — Persist deterministic source proposals.
2. `a9db077` — Hand charged proposals to workers.
3. `07ba98f` — Add configured model proposal gateway.
4. `05a64de` — Cover charged proposal handoff.
5. `1210b2f` — Persist configured-provider observations for lookup-only recovery.

The follow-up configured-provider correction is committed with the updated migration, source store, deterministic source generator, gateway, tests, and this summary.

## Verification

- `bun scripts/dev-payments.ts up && bun test tests/dev/model-proposal.integration.test.ts --test-name-pattern 'deterministic proposal SQL dispatch lookup restart replay'` — passed.
- `bun scripts/dev-payments.ts up` — passed against the existing local PostgreSQL stack; it applied `004_source_proposal_bindings.sql`.
- `bun test tests/dev/model-proposal.integration.test.ts --timeout 300000` — 4 passed, including PostgreSQL reconnect/replay, operation-binding conflicts, shared source digest under a second owner/action, raw Responses HTTP parsing, normalized usage, and GET reconciliation.
- `bun test ./tests/model/reconciliation.test.ts ./tests/billing/price-card.test.ts --timeout 120000` — 11 passed.
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

**3. [Rule 1 - Provider protocol and pricing] Corrected the configured OpenAI Responses adapter**
- **Found during:** Post-plan review
- **Issue:** It expected SDK-only `output_text`, double-counted cached/reasoning subsets, had no output ceiling or original-response verification, and accepted digest-only price provenance.
- **Fix:** Parse raw REST `output[]` envelopes while ignoring reasoning output; accept optional provider completion timestamps while persisting the first observed completion time; validate native model/metadata; send bounded input/output authoring/schema requests with owner-bound prior source data; normalize inclusive usage once; validate fresh raw price/conversion capture bytes against the operator-configured card; and fetch the original response before lookup recovery reports a receipt.
- **Files modified:** `src/dev/development-model-gateway.ts`, `src/dev/source-proposal-store.ts`, `tests/dev/model-proposal.integration.test.ts`

**4. [Rule 1 - Durable identity] Separated source digest from operation identity**
- **Found during:** Configured-provider fixture with identical source for a second operation
- **Issue:** `proposal_sha256` was the table primary key, so an identical valid proposal could not serve another independently billed operation.
- **Fix:** Added migration `004_source_proposal_bindings.sql`: operation ID is now the primary durable binding and source SHA is a non-unique lookup index. Store checks keep proposal/observation identity strict per operation.
- **Files modified:** `migrations/development/004_source_proposal_bindings.sql`, `scripts/dev-payments.ts`, `src/dev/source-proposal-store.ts`, `tests/dev/model-proposal.integration.test.ts`

## Known Stubs

No product stubs. The credential-free suite exercises raw provider HTTP fixtures only; no live paid OpenAI key was available, so a live paid-provider request was deliberately not run. Real mode remains opt-in and requires server-only credentials plus fresh source-backed pricing evidence.

## Self-Check: PASSED

All Plan 53 source, migration, test, and summary files exist. The original five task commits are present; the post-plan correction commit is verified before finalization. No Plan 53 commit deleted tracked files.
