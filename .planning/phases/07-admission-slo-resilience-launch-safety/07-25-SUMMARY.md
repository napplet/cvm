---
phase: 07-admission-slo-resilience-launch-safety
plan: "25"
subsystem: release-certification
tags: [registry, controller, certifier, fail-closed, local-only]
requires:
  - phase: 07-23
    provides: Operational protected-adapter seams
  - phase: 07-24
    provides: Integration protected-adapter seams
provides:
  - Exact-eight generated protected registry
  - Candidate-only local release-certification command and fail-closed journal boundary
  - Operator documentation with no hand-authored certification material
affects: [07-26-protected-execution, release-promotion]
tech-stack:
  added: []
  patterns: [exact-suite-registry, candidate-only-cli, authorization-required-boundary]
key-files:
  created: [src/certification/live/registry.ts, tests/release/certify-release.test.ts, docs/runbooks/release-certification.md]
  modified: [src/certification/runner.ts, src/release/materialize-certifier.ts, src/release/controller.ts, scripts/certify-release.ts, package.json, config/README.md, .env.example]
key-decisions:
  - "The controller exposes only a candidate-bound local certification entrypoint and stops at authorization_required before any protected effect."
  - "Generated registry modules have all eight canonical suite keys; locally injected deterministic ports block before adapter work."
  - "Operators authenticate and approve the controller-issued cost/effect digest but never author certification profiles, registries, trust roots, evidence, or paths."
metrics:
  duration: 20m
  completed: 2026-08-06
  status: complete
---

# Phase 07 Plan 25: Local Release-Certification Orchestration Summary

**A candidate-only, locally testable release-certification command now creates a digest-pinned eight-suite registry and stops safely at the persisted authorization boundary.**

## Accomplishments

- Composed admission, telemetry, chaos, restore, security-host, supply-chain, ContextVM/payment/model, and publication adapters into one exact runtime-checked registry.
- Materialized the registry module instead of the generic adapter entrypoint and added optional exact-set enforcement to protected profile execution.
- Added a candidate-only controller entrypoint that writes/reuses content-addressed discovery and authorization-request state, while refusing to reach any provider, protected runner, trust root, evaluator, bundle, promotion, or cleanup effect.
- Registered `bun run release:certify` and documented the redacted, resumable no-hand-authoring contract.

## Task Commits

1. **Task 1: Wire one candidate through the generated exact-eight live registry and protected runner** — `0e635f0` (RED), `00e4bd0` (GREEN)
2. **Task 2: Persist resumable suite state and fail-closed release finalization with bounded cleanup** — `9c7a0fa` (RED), `2eddf89` (GREEN)
3. **Task 3: Expose and document the one-command contract and lock its negative gates** — `433ffa1` (RED), `3209c37` (GREEN)

## Verification

- `bun test tests/release/certify-release.test.ts` — 4 passed.
- Relevant controller/materializer/certifier coverage — 15 passed.
- Full `bun test` — 545 passed; two pre-existing OpenTelemetry package-legitimacy failures remain outside this plan's files.
- Direct CLI negative check rejects `--registry` with `RELEASE_CERTIFICATION_ARGUMENT_REJECTED` before workspace, provider, or protected processing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Compatibility] Scoped the exact-registry validation to product-controlled runs.**
- **Found during:** Full test verification.
- **Issue:** Applying exact-eight validation to every generic runner use invalidated established selected-suite test harnesses.
- **Fix:** Added an explicit `requireExactRegistry` gate, preserving the strict product path without broadening legacy test fixtures.
- **Files modified:** `src/certification/runner.ts`
- **Commit:** `68c756f`

## Known Stubs

None. The authorization-required stop is an intentional non-authoritative state, not a protected success or UI placeholder.

## Issues Encountered

The repository-wide suite retains two pre-existing failures in `tests/phase-07/otel-package-legitimacy.test.ts`; the focused release-certification, controller, materializer, and runner tests pass. No unrelated OpenTelemetry changes were made.

## Next Phase Readiness

Plan 07-26 can supply the independently authorized protected execution ports. This plan did not authenticate, provision, execute a protected suite, write protected evidence, finalize trust, evaluate promotion, assemble a release bundle, or execute cleanup.

## Self-Check: PASSED

- All created/modified plan artifacts exist.
- Task commits `0e635f0`, `00e4bd0`, `9c7a0fa`, `2eddf89`, `433ffa1`, `3209c37`, and `68c756f` are reachable in Git history.
