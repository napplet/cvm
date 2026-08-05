---
phase: 07-admission-slo-resilience-launch-safety
plan: "02"
subsystem: supply-chain
tags: [opentelemetry, npm, provenance, preinstall, evidence, otlp]
requires:
  - phase: 07-01
    provides: Trusted Phase 07 admission baseline and pending-only certification posture
provides:
  - Exact no-install provenance verification for the six proposed OpenTelemetry packages
  - Immutable preinstall package-audit record and validated stable pointer
  - Explicit SUS/pending-human approval state before package installation
affects: [07-03, 07-04, telemetry-certification, promotion]
tech-stack:
  added: []
  patterns:
    - Registry plus tarball package-identity validation with response digests
    - Content-addressed immutable evidence with an independently verified stable pointer
key-files:
  created:
    - scripts/verify-phase-07-otel-packages.ts
    - tests/phase-07/otel-package-legitimacy.test.ts
    - evidence/certification/phase-07-otel-package-audit.json
  modified: []
key-decisions:
  - "A passed metadata audit does not approve installation: all non-API packages retain SUS and pending_human status."
  - "Bun and Collector compatibility remain pending runtime execution and cannot be inferred from registry provenance."
patterns-established:
  - "Preinstall package verification hashes metadata and tarball responses, checks immutable exact pins, and snapshots dependency manifests before and after."
  - "Stable evidence pointers reference only canonically digested immutable records and reject non-pending or non-passing records."
requirements-completed: [OPS-01, OPS-04]
coverage:
  - id: D1
    description: "All six exact OpenTelemetry package identities are checked against official npm metadata and tarballs without installing packages."
    requirement: OPS-01
    verification:
      - kind: unit
        ref: "tests/phase-07/otel-package-legitimacy.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "The content-addressed preinstall record preserves SUS and pending_human approval, while offline pointer validation fails closed on malformed evidence."
    requirement: OPS-04
    verification:
      - kind: integration
        ref: "bun run scripts/verify-phase-07-otel-packages.ts -- --offline-fixture && bun run scripts/verify-phase-07-otel-packages.ts -- --verify-pointer"
        status: pass
    human_judgment: false
metrics:
  duration: 7m 17s
  completed: 2026-08-05
status: complete
---

# Phase 07 Plan 02: OpenTelemetry Preinstall Audit Summary

**Six exact OpenTelemetry package pins now have no-install, tarball-verified provenance evidence while every non-API package remains SUS and pending human approval.**

## Performance

- **Duration:** 7m 17s
- **Started:** 2026-08-05T15:45:29Z
- **Completed:** 2026-08-05T15:52:46Z
- **Tasks:** 2/2
- **Files modified:** 4

## Accomplishments

- Added a no-install verifier for `@opentelemetry/api@1.9.1`, the `2.10.0` resources/SDK family, and both `0.221.0` OTLP protobuf exporters.
- Verified exact registry integrity, tarball SHA-256, source repository, Apache-2.0 license, publisher, publish time, lifecycle safety, and required dependency ranges against official npm data and tarball contents.
- Wrote immutable audit evidence `d7fedf16f62e4088cf17442aa39786c33bb4af8f3377e8d121d76b108eaf22b3` with a stable pointer that can be checked offline.

## Task Commits

1. **Task 1: Verify the exact OpenTelemetry package identities without installing them** - `9cc15be` (RED test), `f63c29d` (implementation)
2. **Task 2: Emit immutable preinstall audit evidence for the blocking review** - `e658abf` (evidence)

## Files Created/Modified

- `scripts/verify-phase-07-otel-packages.ts` - Exact package verifier, tarball inspection, immutable evidence writer, and offline pointer validator.
- `tests/phase-07/otel-package-legitimacy.test.ts` - Identity, mutation, SUS, and manifest/lock no-mutation oracle.
- `evidence/certification/otel-package-audits/d7fedf16f62e4088cf17442aa39786c33bb4af8f3377e8d121d76b108eaf22b3.json` - Canonical immutable audit record.
- `evidence/certification/phase-07-otel-package-audit.json` - Validated stable pointer to the immutable record.

## Decisions Made

- Treat registry/tarball verification as necessary package provenance evidence, not as a Bun, Collector, or dependency-installation compatibility claim.
- Preserve the research `SUS` disposition and `approvalStatus: pending_human` for all five non-API packages even when all audited facts pass.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The audit normalizes the official tarball's shorthand repository field to the canonical OpenTelemetry JavaScript repository before comparison; this is part of the planned source-identity verification.

## Known Stubs

None. Runtime/Bun/Collector compatibility is deliberately recorded as pending, not stubbed or claimed.

## User Setup Required

None - no external service configuration or package installation occurred.

## Next Phase Readiness

Plan 07-03 can review the immutable package facts at the required blocking human gate. It must not approve installation based on this record alone: the five `SUS` packages remain pending, and Bun/Collector compatibility has not run.

## Self-Check: PASSED

- All four plan-owned implementation, test, and evidence files exist.
- Task commits `9cc15be`, `f63c29d`, and `e658abf` exist.
- Focused tests, full `bun test --timeout 10000`, offline pointer validation, and dependency-manifest diff checks passed.
