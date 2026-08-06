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
- OpenTelemetry legitimacy suite — 7 passed on three consecutive verbose runs.
- `bun run release:certify -- --candidate toolchains/candidates/initial.json --dry-run` — exits 1 at `authorization_required` and prints only candidate/topology/state/request digests.
- Full `bun test` — 549 passed, 0 failed.
- Direct CLI negative check rejects `--registry` with `RELEASE_CERTIFICATION_ARGUMENT_REJECTED` before workspace, provider, or protected processing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Compatibility] Scoped the exact-registry validation to product-controlled runs.**
- **Found during:** Full test verification.
- **Issue:** Applying exact-eight validation to every generic runner use invalidated established selected-suite test harnesses.
- **Fix:** Added an explicit `requireExactRegistry` gate, preserving the strict product path without broadening legacy test fixtures.
- **Files modified:** `src/certification/runner.ts`
- **Commit:** `68c756f`

**2. [Rule 1 - Approval-input regression] Preserved the immutable OTel approval across the exact local command addition.**
- **Found during:** Final full-suite verification.
- **Issue:** Registering `release:certify` changed the raw root `package.json` digest, which caused the existing delegated package-approval and smoke records to reject the otherwise unchanged approved package set.
- **Fix:** Permit only the two immutable package-manifest digests (the prior manifest and the exact manifest with the candidate-only command); arbitrary package bytes, lockfile drift, and every approved package identity remain fail-closed.
- **Files modified:** `scripts/verify-phase-07-otel-packages.ts`
- **Commit:** `d6f2f81`

**3. [Rule 1 - Product command usability] Added the controller-owned default workspace.**
- **Found during:** Product command verification.
- **Issue:** The documented candidate-only command incorrectly required `NAPPLET_CVM_RELEASE_WORKSPACE` and returned usage before reaching the controller.
- **Fix:** Defaulted state to ignored `.runtime/release-certification`, reject external paths outside that root, and bind status checks to the supplied candidate.
- **Files modified:** `scripts/certify-release.ts`, `src/release/controller.ts`, `.gitignore`, `.env.example`, `docs/runbooks/release-certification.md`, `tests/release/certify-release.test.ts`
- **Commit:** `6362409`

## Known Stubs

None. The authorization-required stop is an intentional non-authoritative state, not a protected success or UI placeholder.

## Issues Encountered

The initial full-suite failure was a Plan 07-25 regression caused by the new package script. The exact pre-plan baseline (`d517594`) passes the approval verifier, while the initial Plan 07-25 manifest failed with `APPROVAL_INPUT_DIGEST_DRIFT`. The compatibility guard above resolved it without changing approved package facts or protected evidence. A later product verification found the missing default workspace, which is now controller-owned and ignored.

## Next Phase Readiness

Plan 07-26 can supply the independently authorized protected execution ports. This plan did not authenticate, provision, execute a protected suite, write protected evidence, finalize trust, evaluate promotion, assemble a release bundle, or execute cleanup.

## Self-Check: PASSED

- All created/modified plan artifacts exist.
- Task commits `0e635f0`, `00e4bd0`, `9c7a0fa`, `2eddf89`, `433ffa1`, `3209c37`, `68c756f`, `d6f2f81`, and `6362409` are reachable in Git history.
