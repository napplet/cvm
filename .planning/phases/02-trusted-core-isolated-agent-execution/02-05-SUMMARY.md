---
phase: 02-trusted-core-isolated-agent-execution
plan: 05
subsystem: worker-adapters
tags: [typescript, modal, worker-port, isolation, evidence, zod]
requires:
  - phase: 02-trusted-core-isolated-agent-execution
    provides: canonical WorkerPort contracts, immutable policy fixture, and scoped capability gateway
provides:
  - strict Modal candidate adapter behind the canonical WorkerPort
  - opt-in provider probe with canonical passed, failed, and blocked evidence states
  - stable blocked/unselected observation when Modal provider configuration is absent
affects: [worker-adapters, provider-selection, phase-07-certification]
tech-stack:
  added: [modal@0.9.0]
  patterns: [lazy-provider-loading, default-deny-sandbox-construction, content-addressed-provider-evidence]
key-files:
  created:
    - src/worker-adapters/modal-worker.ts
    - scripts/probe-modal-worker.ts
    - tests/integration/modal-probe.test.ts
    - evidence/phase-02/modal-probe.json
  modified:
    - package.json
    - bun.lock
key-decisions:
  - "Modal remains a candidate: a passed observation establishes only eligible-not-selected status, while blocked and failed states remain unselected."
  - "The Modal SDK loads only after a provider configuration has passed the strict project schema, keeping offline blocked probes free of SDK construction."
  - "Sandbox resource ceilings and process bounds derive exclusively from PHASE_02_POLICY_INITIAL rather than provider-configurable values."
patterns-established:
  - "Provider adapters import canonical WorkerPort schemas and return parsed project results instead of vendor values."
  - "Provider observations are immutable canonical JSON, with a content-addressed record and a stable current pointer."
requirements-completed: [SAFE-04]
coverage:
  - id: D1
    description: Strict Modal WorkerPort adapter enforces default-deny resource, timeout, output, and termination controls.
    requirement: SAFE-04
    verification:
      - kind: integration
        ref: "bun test tests/integration/modal-probe.test.ts --test-name-pattern='adapter contract'"
        status: pass
    human_judgment: false
  - id: D2
    description: Optional Modal isolation probe emits honest blocked, failed, or eligibility-only provider evidence.
    requirement: SAFE-04
    verification:
      - kind: integration
        ref: "env -u MODAL_TOKEN_ID -u MODAL_TOKEN_SECRET -u NAPPLET_CVM_MODAL_PROBE_CONFIG bun run test:modal-probe && bun test tests/integration/modal-probe.test.ts"
        status: pass
    human_judgment: false
metrics:
  duration: 6m 19s
  completed: 2026-08-04
status: complete
---

# Phase 02 Plan 05: Modal Candidate Adapter and Probe Summary

**Strict, default-deny Modal WorkerPort candidate with content-addressed provider evidence that remains unselected without live configuration.**

## Performance

- **Duration:** 6m 19s
- **Started:** 2026-08-04T10:57:59Z
- **Completed:** 2026-08-04T11:04:18Z
- **Tasks:** 2/2
- **Files modified:** 7

## Accomplishments

- Pinned `modal@0.9.0` and confined it to the reversible candidate adapter with an injected SDK seam.
- Enforced immutable Phase 2 CPU, memory, lifetime, idle, execution, output, workdir, and default-deny network controls before any provider call.
- Added an opt-in two-sandbox isolation probe and immutable provider evidence, with deterministic blocked/unselected output when configuration or credentials are absent.

## Task Commits

1. **Task 1: Implement the strict Modal adapter behind WorkerPort** - `16f3080` (test), `a331534` (feat), `ed9fefb` (fix)
2. **Task 2: Emit honest passed, failed, or blocked isolation-probe evidence** - `5bb3387` (test), `7dc2b67` (feat)

## Files Created/Modified

- `src/worker-adapters/modal-worker.ts` - Canonical-port adapter, strict provider schema, lazy SDK bridge, and isolation evidence evaluator.
- `scripts/probe-modal-worker.ts` - Optional live or blocked provider probe command and immutable evidence writer.
- `tests/integration/modal-probe.test.ts` - Adapter boundary and offline/provider-evidence coverage.
- `evidence/phase-02/modal-probe.json` - Stable current blocked provider observation.
- `evidence/phase-02/provider/eac631d91afbd8f9a6e88a4ee8fc00b9c8abf1f12907bf8efff03992753e5718.json` - Immutable blocked provider observation.
- `package.json` and `bun.lock` - Exact Modal candidate SDK pin and probe command.

## Decisions Made

- A live provider pass can mark Modal only `eligible-not-selected`; it never claims selection, production certification, or the five-second SLO.
- Missing configuration and credentials are observable `blocked` states, not successful provider assertions or failures of offline contract tests.
- Provider output, checkpoint files, and gateway requests are parsed as untrusted inputs; evidence stores only canonical check outcomes and identifiers.

## TDD Gate Compliance

- **RED:** `16f3080` proved the adapter module was absent; `5bb3387` proved the probe evidence export was absent.
- **GREEN:** `a331534` and `7dc2b67` satisfy focused and full-suite verification; `ed9fefb` preserves the no-config security boundary.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Deferred SDK loading until strict configuration validation**
- **Found during:** Task 1
- **Issue:** A static SDK import could load provider code on an offline blocked path, conflicting with the requirement to validate before importing or constructing provider functionality.
- **Fix:** Replaced the production bridge with a lazy dynamic import after the strict provider schema has accepted the configuration.
- **Files modified:** `src/worker-adapters/modal-worker.ts`
- **Verification:** Focused adapter tests and the no-config probe both pass.
- **Committed in:** `ed9fefb`

**Total deviations:** 1 auto-fixed (Rule 2).

## Known Stubs

None.

## User Setup Required

None for offline execution. A future live observation needs an approved configuration file at `NAPPLET_CVM_MODAL_PROBE_CONFIG` plus Modal's documented `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`; it remains candidate-only even when passed.

## Next Phase Readiness

- Provider selection, production certification, and five-second readiness-SLO measurement remain explicitly deferred to Phase 7.
- The current pointer records `blocked` / `PROVIDER_UNSELECTED`, so no account, region, or image is selected by Phase 2.

## Self-Check: PASSED

- Confirmed all seven implementation, evidence, and test artifacts plus this summary exist.
- Confirmed TDD and implementation commits `16f3080`, `a331534`, `ed9fefb`, `5bb3387`, and `7dc2b67` exist.
