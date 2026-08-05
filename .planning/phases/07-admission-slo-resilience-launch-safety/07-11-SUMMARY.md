---
phase: 07-admission-slo-resilience-launch-safety
plan: "11"
subsystem: supply-chain-security
tags: [opentelemetry, approval, immutable-evidence, supply-chain, otel]
requires:
  - phase: 07-03
    provides: Delegated operator approval scope documented without mutating the pending audit
  - phase: 07-04
    provides: Exact OTel root pins and Collector smoke evidence
provides:
  - Content-addressed delegated-operator approval record bound to one pending audit and six exact package identities
  - Shared fail-closed verifier for package approval, root pins, and Collector smoke evidence
affects: [telemetry-certification, launch-safety, OPS-01, OPS-04]
tech-stack:
  added: []
  patterns: [content-addressed delegated authority, approval-before-effect verification]
key-files:
  created:
    - evidence/certification/phase-07-otel-package-approval.json
    - evidence/certification/otel-package-approvals/6fd27b004e02493a81deffe5286ae8137cbe4f362a4e9e706ff53ca262be22ad.json
    - evidence/certification/otel-package-smokes/09adb3c8cc4d729c94fb92be90217b64f853316de7c78f5431133b951c9e430b.json
  modified:
    - scripts/verify-phase-07-otel-packages.ts
    - tests/phase-07/otel-package-legitimacy.test.ts
key-decisions:
  - "The immutable audit remains pending_human review evidence; a distinct approved_operator record is the only installation authority."
  - "Approval is fixed to its content digest, exact audit digest, exact six name/version/integrity rows, audit inputs, and current root inputs."
  - "Root-pin verification accepts only smoke evidence explicitly bound to the same approval, audit, and package-set digests."
patterns-established:
  - "Approval-dependent modes obtain one shared verifier result before package or container effects."
  - "Immutable evidence upgrades use a new content-addressed record instead of rewriting prior evidence."
requirements-completed: [OPS-01, OPS-04]
coverage:
  - id: D1
    description: Delegated operator approval is separate from the pending audit and binds the exact reviewed package closure.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: tests/phase-07/otel-package-legitimacy.test.ts#delegated approval is a separate immutable decision over the exact pending audit
        status: pass
    human_judgment: false
  - id: D2
    description: Pending, rejected, substituted, mutated, package-drifted, integrity-drifted, and input-drifted approval states block all approval-dependent modes.
    requirement: OPS-01
    verification:
      - kind: integration
        ref: tests/phase-07/otel-package-legitimacy.test.ts#approval pending rejected and drift records fail closed before approval-dependent effects
        status: pass
    human_judgment: false
  - id: D3
    description: Root-pin verification and smoke evidence carry the same approval and audit bindings as the shared verifier.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: bun run scripts/verify-phase-07-otel-packages.ts -- --verify-root-pins
        status: pass
    human_judgment: false
duration: 29min
completed: 2026-08-05
status: complete
---

# Phase 07 Plan 11: Digest-Bound OTel Approval Summary

**A truthful delegated-operator approval now content-addresses the exact pending OTel audit and package closure, and all install/smoke paths fail closed on any approval drift.**

## Performance

- **Duration:** 29 min
- **Started:** 2026-08-05T18:52:00Z
- **Completed:** 2026-08-05T19:21:14Z
- **Tasks:** 2/2
- **Files modified:** 6

## Accomplishments

- Preserved the original immutable `pending_human` audit and introduced a separate `approved_operator` record with delegated—not direct-human—provenance.
- Bound authority to the fixed audit digest, the six exact name/version/integrity rows, the audit inputs, current root inputs, expiry, narrow scope, and explicit limitations.
- Made `--require-approved`, `--verify-root-pins`, and Collector smoke use the strict verifier; a new immutable smoke record ties smoke evidence to the same approval/audit/package-set digests.

## Task Commits

1. **Task 1: Define and persist the exact delegated operator approval** - `d9b17a8` (test), `1d06258` (feat)
2. **Task 2: Enforce the approval at every approval-dependent path** - `12122bc` (test), `8f9e627` (feat)

## Files Created/Modified

- `scripts/verify-phase-07-otel-packages.ts` - Defines strict approval schemas and the shared approval verifier.
- `evidence/certification/phase-07-otel-package-approval.json` - Points to the immutable delegated approval decision.
- `evidence/certification/otel-package-approvals/6fd27b004e02493a81deffe5286ae8137cbe4f362a4e9e706ff53ca262be22ad.json` - Stores the exact content-addressed approval payload.
- `evidence/certification/otel-package-smokes/09adb3c8cc4d729c94fb92be90217b64f853316de7c78f5431133b951c9e430b.json` - Rebinds passing smoke evidence without modifying older immutable records.
- `tests/phase-07/otel-package-legitimacy.test.ts` - Covers authority provenance and fail-closed mutations across CLI modes.

## Decisions Made

- The approved operator decision names delegated authority only and explicitly disclaims direct-human review and signer provenance.
- The approval is narrowly limited to the disposable Bun/Collector smoke and exact root package pins; it grants no release, telemetry-data, provider, promotion, or changed-package authority.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None.

## Verification

- `bun test tests/phase-07/otel-package-legitimacy.test.ts --timeout 10000` — pass (7 tests).
- `bun run scripts/verify-phase-07-otel-packages.ts -- --require-approved` — pass.
- `bun run scripts/verify-phase-07-otel-packages.ts -- --verify-root-pins` — pass.
- `bun install --frozen-lockfile` — pass, no changes.
- `bun test --timeout 10000` — pass (486 tests).

## Self-Check: PASSED

- Approval pointer, immutable approval record, upgraded immutable smoke record, and verifier source exist.
- TDD and feature commits `d9b17a8`, `1d06258`, `12122bc`, and `8f9e627` exist in git history.

## Next Phase Readiness

The package legitimacy bypass is closed; the remaining Phase 7 live certification work remains independently blocked until protected evidence is supplied.
