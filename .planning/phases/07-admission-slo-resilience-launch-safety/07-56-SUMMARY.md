---
phase: 07-admission-slo-resilience-launch-safety
plan: "56"
subsystem: development-source-to-preview
tags: [contextvm, postgres, docker, napplet, paja, playwright]
requires:
  - phase: 07
    provides: durable model proposals, funded admission, and metered actions
provides:
  - pinned no-network development worker with real CLI build gates
  - verified immutable artifacts, durable grants, and official Paja previews
  - signed browser projection of durable model, worker, artifact, and billing facts
affects: [07-54, 07-57]
tech-stack:
  added: [@kehto/paja-0.19.0, Playwright-1.62.1]
  patterns: [content-bound artifacts, opaque preview grants, server readiness before spend]
key-files:
  created: [infra/dev-ui/Dockerfile, src/dev/local-artifact-verifier.ts, src/dev/local-artifact-repository.ts, src/dev/local-preview-grant-store.ts, src/dev/development-runtime-readiness.ts]
  modified: [src/dev-ui/contextvm-server.ts, src/dev-ui/browser/main.ts, src/phase-04/metered-generation-service.ts, src/contextvm/adapter.ts, tests/dev-ui/generation-preview.e2e.ts]
decisions:
  - "The worker accepts only the action-bound stored proposal and verifies real CLI output before any artifact is sealed or previewed."
  - "Configured pricing profile and price-card IDs are immutably registered before SQL metering; deterministic mode remains clearly labelled."
  - "Original-operation crash recovery remains a Plan 54/57 responsibility; this plan proves bounded worker failures and durable artifact/grant restart behavior."
metrics:
  tasks_completed: 2
  completed: 2026-10-15
status: complete
---

# Phase 07 Plan 56: Isolated Source-to-Preview Summary

**A funded signed ContextVM action now runs its exact stored proposal through an isolated napplet build, seals verified bytes, and renders the result through an opaque official Paja preview grant.**

## Accomplishments

- Built the pinned ARM64 development worker path with a read-only, non-root, no-network Docker invocation, bounded resources/output/deadline, exact container cleanup, and real create/init/skills/install/build/verify/conformance/dry-run evidence.
- Added independent artifact verification of ordered command evidence, trusted CSP placement, file-set/hash bijection, official CLI aggregate hash, manifest tags, and bounded no-follow file reads before SQL/object promotion.
- Added durable SQL-indexed artifact metadata and opaque owner/session/artifact/version-bound preview grants. Reads revalidate sealed bytes and redact failures; repository/grant restart, expiry, revoke, cross-owner, traversal, MIME, CORS, and altered-byte cases are covered.
- Added development runtime readiness before funded admission/model dispatch. It checks source/host integrity, the pinned Paja package tree, worker image/platform/CLI/Chromium route, and host browser launch.
- Wired the signed ContextVM browser flow through funded admission, metered SQL, durable proposal, worker, verifier, repository, grant, preview server, and official Paja. The UI projects durable provider/model/profile/card/usage, source/worker verification, artifact/version, exact spend, remaining cap/balance, and explicit publication unavailability without HTTP application commands.
- Fixed exact-cap affordability, action-budget lifecycle constraints, joined action identity, zero-charge terminal settlement, immutable deterministic replay across template revisions, and configured pricing registration before SQL foreign keys.

## Verification

- `bun run tests/dev-ui/generation-preview.e2e.ts --case=deterministic-real-worker-compatible-host` — passed: Chromium → encrypted ContextVM → PostgreSQL proposal/charge → real Docker create/init/skills/install/build/verify/conformance/dry-run → sealed artifact → Paja → generated counter click; displayed charge and artifact were compared with SQL.
- `bun run tests/dev-ui/generation-preview.e2e.ts --case=boundaries-platform-provider-recovery --allow-skip-without-provider-credentials` — passed. The generated `allow-scripts` frame had opaque `null` origin, no `window.nostr`, blocked parent storage and direct fetch, and made no HTTP application command. Configured provider: `skipped_without_credentials`.
- `bun test tests/dev/model-proposal.integration.test.ts --timeout 60000` — 4 passed, 37 assertions.
- `bun test tests/phase-04 tests/contextvm --timeout 60000` — 31 passed, 168 assertions in the final root validation run.
- `bun test tests/dev/local-artifact-verifier.test.ts tests/dev/artifact-persistence.integration.test.ts --timeout 60000` — 10 passed, 32 assertions.
- `bun test tests/dev-ui/preview-server.boundaries.test.ts --timeout 60000` — passed, 32 assertions.
- `bun test tests/dev/metered-finalization.integration.test.ts --timeout 60000` — passed, 2 tests and 20 assertions against PostgreSQL.
- Worker/readiness validation passed 7 tests and 28 assertions. The real conformance report is accurately retained as 5 passed, 0 failed, 5 skipped; manifest/wire/lifecycle checks are skipped without corresponding external inputs.

## Task Commits

1. `5d79fc5` — add the failing generation-preview tracer.
2. `5a01b08` — run verified napplets in isolated preview.
3. `089371a`, `07b9288`, `2a83db7` — harden artifact verification and sealed reads.
4. `1569538` — persist artifacts and preview grants.
5. `fa2037d` — wire signed ContextVM generation preview flow.
6. `17acf46`, `39ada9a`, `3466b14` — bound worker execution, preflight readiness, and preview HTTP/browser boundaries.
7. `8ac3de4`, `91b7d69`, `b08e065`, `f846537` — repair lifecycle accounting, prove terminal SQL settlement, retain bounded diagnostics, and register immutable configured pricing.
8. `8e5b213`, `10aef15` — complete the signed UI/SQL trace and generated-frame boundary assertions.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 1 - Accounting] Used the action's active hold when evaluating its own affordability.**
   Exact funding previously paused because `availableBalance` excludes the active approved hold. Continuation comparisons now use `availableBalance + remainingCap` while retaining a separate cap check.

2. **[Rule 1 - SQL lifecycle] Allowed terminal budget release and zero hold exhaustion.**
   The initial action-budget check rejected the repository's released terminal state and the hold check rejected exact consumption to zero. A compatibility migration and real PostgreSQL tests correct both cases.

3. **[Rule 1 - Worker source] Preserved template guidance contracts in deterministic output.**
   The real upstream verify gate requires its exact domain-helper import and frame-filling CSS contract. Deterministic output now satisfies those contracts and replays the originally persisted proposal after any later template change.

4. **[Rule 2 - Spend safety] Added readiness and immutable configured pricing registration before dispatch.**
   The development composition verifies the actual worker/host route before admission and stores configured profile/card versions before the metered-action foreign keys can reference them.

## Known Limits

- No live paid configured-provider credentials or fresh operator price captures were available. The boundary tracer records `skipped_without_credentials`; configured mode is wired to the same worker/artifact/preview path when supplied with valid server-only configuration.
- Full interrupted original-operation/crash recovery is deliberately not claimed here. Plan 54/57 owns the remaining continuation/recovery execution path.

## Self-Check: PASSED

The summary exists, the listed Plan 56 commits are present, and no Plan 56 commit intentionally deletes tracked files.
