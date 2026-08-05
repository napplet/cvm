---
phase: 07-admission-slo-resilience-launch-safety
plan: "04"
subsystem: telemetry
tags: [opentelemetry, otlp, collector, redaction, cardinality, supply-chain]
requires:
  - phase: 07-02
    provides: Immutable no-install provenance audit for six exact OpenTelemetry packages
  - phase: 07-03
    provides: Digest-bound approval for the disposable smoke and conditional root pins
provides:
  - Digest-bound Bun and Collector compatibility evidence for the approved OpenTelemetry package family
  - Exact root OpenTelemetry pins with frozen Bun lockfile verification
  - Observation-only, allowlisted lifecycle telemetry with protected correlations and finite metric attributes
affects: [07-07, 07-09, 07-10, telemetry-certification, promotion]
tech-stack:
  added: [@opentelemetry/api@1.9.1, @opentelemetry/resources@2.10.0, @opentelemetry/sdk-trace-base@2.10.0, @opentelemetry/sdk-metrics@2.10.0, @opentelemetry/exporter-trace-otlp-proto@0.221.0, @opentelemetry/exporter-metrics-otlp-proto@0.221.0]
  patterns:
    - Disposable package and Collector smoke before root dependency installation
    - Strict schema redaction before every telemetry sink with HMAC-protected correlations
    - Manual OTel instrumentation only; exporter failures are non-authoritative
key-files:
  created:
    - infra/otel/collector.yaml
    - src/telemetry/redaction.ts
    - src/telemetry/otel.ts
    - evidence/certification/otel-package-smokes/d683c75a24e6c0a679db2895de803be28051790c366ecb09f1e438a604ab96dd.json
  modified:
    - package.json
    - bun.lock
    - scripts/verify-phase-07-otel-packages.ts
    - src/phase-03/funded-core.ts
    - tests/phase-07/telemetry-policy.test.ts
key-decisions:
  - "Only the approval digest d7fedf16f62e4088cf17442aa39786c33bb4af8f3377e8d121d76b108eaf22b3 authorizes the six exact package pins."
  - "Collector certification uses a resolved immutable image digest and fixed safe attributes; it is not a live service-certification claim."
  - "Production metric labels contain only lifecycle version, stage, and outcome; protected correlation remains trace-only."
patterns-established:
  - "Unknown fields and all free-text canaries are rejected before in-memory and OTel output."
  - "Coordinator composition accepts only an observation port, never telemetry store, payment, worker, or publication authority."
requirements-completed: [OPS-01, OPS-04]
coverage:
  - id: D1
    description: Exact approved OpenTelemetry packages are Bun-imported and OTLP-smoked through a digest-pinned official Collector before root installation.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: bun run scripts/verify-phase-07-otel-packages.ts -- --bun-collector-smoke
        status: pass
      - kind: integration
        ref: bun run scripts/verify-phase-07-otel-packages.ts -- --verify-root-pins && bun install --frozen-lockfile
        status: pass
    human_judgment: false
  - id: D2
    description: Lifecycle telemetry drops forbidden data, bounds metric cardinality, and cannot alter domain effects on exporter failure.
    requirement: OPS-01
    verification:
      - kind: unit
        ref: tests/phase-07/telemetry-policy.test.ts
        status: pass
      - kind: integration
        ref: bun test tests/phase-07/telemetry-policy.test.ts tests/phase-07/admission-slo.test.ts --timeout 10000
        status: pass
    human_judgment: false
metrics:
  duration: 11m
  completed: 2026-08-05
status: complete
---

# Phase 07 Plan 04: Safe OpenTelemetry Lifecycle Summary

**Approved OpenTelemetry pins, a Bun/Collector smoke record, and strict observation-only lifecycle telemetry now provide bounded operational signals without exporting sensitive domain data.**

## Performance

- **Duration:** 11m
- **Started:** 2026-08-05T16:22:26Z
- **Completed:** 2026-08-05T16:33:26Z
- **Tasks:** 2/2
- **Files modified:** 12

## Accomplishments

- Verified the approval digest, smoke-tested all six exact packages under Bun 1.3.14, and sent one finite trace and metric through `otel/opentelemetry-collector@sha256:5b97e6e3550ec6e48a71dba6f6304d349a293af8df4ee1f51da67be94fce2ecd` before root installation.
- Pinned the exact OTel family and added a bounded local Collector configuration with OTLP HTTP receive, memory limits, batching, and no logs pipeline or automatic instrumentation.
- Added strict lifecycle redaction, keyed protected correlations, finite cardinality accounting, non-throwing exporters, and optional observation-only funded-core composition.

## Task Commits

1. **Task 1: Smoke the approved package family under Bun and Collector before root installation** — `12ebcba` (feat)
2. **Task 2: Enforce lifecycle redaction, finite cardinality, and observation-only export** — `9c6e589` (RED test), `73ed92b` (feat)

## Files Created/Modified

- `scripts/verify-phase-07-otel-packages.ts` — verifies approval/root pins and runs the disposable Collector smoke.
- `infra/otel/collector.yaml` — bounded certification-only OTLP trace/metric sink.
- `src/telemetry/redaction.ts` — strict allowlist, HMAC correlation, and cardinality bound.
- `src/telemetry/otel.ts` — in-memory and manual OTel exporters that swallow failures.
- `src/phase-03/funded-core.ts` — optional observation-only telemetry injection for funded admission.
- `tests/phase-07/telemetry-policy.test.ts` — canary, concurrency/cardinality, and non-authority tests.

## Decisions Made

- The original package audit pointer remains immutable and approval-bound; smoke evidence is a separate content-addressed record.
- The Collector debug sink is certification-only and receives fixed allowlisted attributes; production telemetry has no logs pipeline.
- Provider, region, image, and load cohort are excluded from production metric labels and remain evidence-only dimensions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Docker daemon was stopped before the required local Collector smoke.**
- **Found during:** Task 1
- **Fix:** Started the existing local Docker application and verified its daemon before the smoke.
- **Verification:** The disposable Bun/Collector smoke passed and the container was removed afterward.
- **Committed in:** `12ebcba`

**2. [Rule 1 - Bug] Initial smoke wiring did not pass its local OTLP endpoint and did not wait for the Collector batch sink.**
- **Found during:** Task 1
- **Fix:** Bound the disposable script to the mapped local endpoint, waited for Collector readiness/batching, and captured both safe Collector output streams for fixed-attribute inspection.
- **Verification:** Immutable passing smoke record `d683c75a24e6c0a679db2895de803be28051790c366ecb09f1e438a604ab96dd` was written without changing root dependencies before pinning.
- **Committed in:** `12ebcba`

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking, 1 Rule 1 bug).

## Known Stubs

None. The remaining lifecycle subsystems will emit into this shared vocabulary in their owning plans; no empty/mock telemetry value was introduced.

## Next Phase Readiness

- Later Phase 7 plans can emit trusted coordinator transitions through the shared bounded vocabulary.
- The passing smoke is compatibility evidence only; live certification, provider selection, release, and promotion remain blocked by their separate evidence gates.

## Self-Check: PASSED

- Verified every plan-owned package, Collector, telemetry, composition, test, smoke-evidence, and summary file exists.
- Verified task commits `12ebcba`, `9c6e589`, and `73ed92b` resolve to commits in repository history.
