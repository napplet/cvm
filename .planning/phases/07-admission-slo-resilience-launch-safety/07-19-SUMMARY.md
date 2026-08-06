---
phase: 07-admission-slo-resilience-launch-safety
plan: "19"
subsystem: release-certification
tags: [typescript, zod, sha256, release-controller, authorization, fail-closed]
requires:
  - phase: 07-18
    provides: operator-owned protected certifier composition and release promotion gates
provides:
  - project-owned, candidate-bound release topology and no-effect dry-run controller
  - redacted finite provider-discovery inventory with all required integration owners
  - content-addressed authorization request and resumable controller state
affects: [protected-live-certification, release-promotion, launch-safety]
tech-stack:
  added: []
  patterns: [canonical content-addressed controller state, create-or-verify immutable writes, fail-closed authorization boundary]
key-files:
  created: [src/release/contracts.ts, src/release/topology.ts, src/release/controller.ts, scripts/certify-release.ts, tests/release/controller.test.ts]
  modified: []
key-decisions:
  - "Dry-run performs only finite read-only discovery and always exits nonzero at authorization_required."
  - "Release topology, effects, and maximum cost are project-owned inputs bound to the candidate, never operator-authored certifier files."
  - "Resume requires intact monotonic prior state plus exact candidate, topology, effect-plan, capability, and authorization digests."
metrics:
  duration: 6m 12s
  completed: 2026-08-06
status: complete
---

# Phase 07 Plan 19: Release Certification Controller Dry-Run Summary

**A real immutable candidate now reaches one content-addressed, no-effect authorization boundary with all provider/integration prerequisites explicitly non-pass when credentials are absent.**

## Performance

- **Duration:** 6m 12s
- **Started:** 2026-08-06T11:01:44Z
- **Completed:** 2026-08-06T11:07:56Z
- **Tasks:** 2/2
- **Files created:** 5

## Accomplishments

- Defined strict controller, topology, capability, effect-plan, and authorization-request schemas.
- Derived the fixed Phase 7 release topology (two Cloud Run regions with warm floor, digest-pinned Collector, GCS retention/versioning, Cockroach/PostgreSQL, Modal/Fly, and all required integrations) entirely from project code and immutable candidate identity.
- Added a product CLI that records only canonical controller state and an authorization request, reports `authorization_required`, and exits nonzero without protected credentials.
- Sealed provider-output redaction, immutable create-or-verify writes, pointer/state integrity, monotonic transition checks, and replay/input binding.

## Task Commits

1. **Task 1: Trace one candidate from CLI input to an authorization-required dry-run** — `ab796d9` (test), `a163c79` (feat)
2. **Task 2: Seal provider discovery and controller-state invariants** — `aa1a75b` (test), `5f78a8b` (feat), `7ae31c9` (fix)

## Decisions Made

- Discovery ports expose only a closed capability/authentication result and digest references for account scope and cost; native output and credential-shaped data are discarded.
- The state chain uses a discovery state as the exact authorization request resume point, then an `authorization_required` state; neither is protected evidence or a promotion decision.
- A dry run cannot reuse a workspace after candidate, derived topology, or project-owned effect/cost-plan drift.

## Verification

- `bun test tests/release/controller.test.ts --timeout 10000` — 5 pass, 0 fail.
- `bun test --timeout 10000` — 527 pass, 0 fail.
- Credential-free `bun run scripts/certify-release.ts -- --candidate toolchains/candidates/initial.json --workspace <temp> --dry-run` — emitted one `authorization_required` request/state and exited 1 as required.
- The dry-run workspace contained exactly `current.json`, two state records, and one authorization-request record; no persisted status was `protected_live`, `passed`, or `promoted`.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. Missing credentials and unavailable provider capabilities are explicit finite non-pass facts, not placeholder readiness.

## Next Phase Readiness

The authorization request and resumable dry-run state are ready for the later authorization-gated provider registry. Protected provider effects, observations, certification passes, and promotion remain unavailable by design.

## Self-Check: PASSED

- All five planned source/test files exist.
- Task commits `ab796d9`, `a163c79`, `aa1a75b`, `5f78a8b`, and `7ae31c9` are reachable in git history.
