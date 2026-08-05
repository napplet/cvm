---
phase: 07-admission-slo-resilience-launch-safety
plan: "09"
subsystem: certification
tags: [bun, deterministic-evaluation, evidence, redaction, promotion]
requires:
  - phase: 07-01
    provides: receipt-to-ready admission and bounded refusal contracts
  - phase: 07-04
    provides: allowlisted telemetry redaction and finite cardinality rules
  - phase: 07-06
    provides: original-operation fault schedules and comparator-only effect oracles
  - phase: 07-07
    provides: exact retained-object restore and blocked topology evidence contracts
  - phase: 07-08
    provides: compatible-host presentation and protected browser-evidence boundaries
provides:
  - 64-case deterministic Phase 7 reference corpus with complete source mappings
  - canonical content-addressed design evidence with an atomic stable pointer
  - explicit protected-live blocked/not_observed inventory that cannot satisfy promotion
affects: [07-10, release-certification, promotion]
tech-stack:
  added: []
  patterns: [comparator-only deterministic cases, canonical design-evidence records, promotion-blocked live inventory]
key-files:
  created:
    - src/certification/phase-07-reference-set.ts
    - evidence/design/8ff150d22f8dcebfe8be9418061421a530bf78c9fd8c3929d4a54dea3c1c0d5c.json
    - evidence/design/phase-07.json
  modified:
    - src/certification/evidence.ts
    - tests/fixtures/phase-07-reference-set.json
    - tests/evals/phase-07-reference-set.test.ts
    - scripts/eval-phase-07.ts
    - scripts/verify-phase-07-evidence.ts
key-decisions:
  - "The deterministic corpus has an offline pass only; the immutable record keeps promotion blocked until protected live observations are present."
  - "Expected facts stay in comparators; evaluators receive bounded scenario data and derive deterministic observations before comparison."
  - "The Phase 7 pointer identifies only a validated content-addressed record and does not touch unrelated evidence hashes."
patterns-established:
  - "A deterministic reference set validates every source mapping and rejects duplicate cases, protected data, incorrect comparators, and forged live passes."
  - "Stable evidence pointers are atomically updated after create-or-verify immutable record writes."
requirements-completed: [SESS-02, OPS-01, OPS-02, OPS-03, OPS-04]
coverage:
  - id: D1
    description: Complete 64-case deterministic corpus covers admission, resilience, security, publication, and launch classes with source mappings.
    requirement: OPS-02
    verification:
      - kind: integration
        ref: bun run eval:phase07
        status: pass
      - kind: unit
        ref: tests/evals/phase-07-reference-set.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Canonical design evidence validates mappings, aggregate comparisons, redaction, digest, and pointer integrity.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: bun run verify:phase07-evidence && bun run scripts/verify-phase-07-evidence.ts -- --verify-existing
        status: pass
    human_judgment: false
  - id: D3
    description: Protected ContextVM, payment, model, worker, storage, host, signer, CLI, upload, and relay observations remain non-passing.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: tests/evals/phase-07-reference-set.test.ts#keeps protected-live observations non-passing
        status: pass
    human_judgment: true
    rationale: Protected live certification and promotion remain owned by Plan 07-10.
metrics:
  duration: 11m
  completed: 2026-08-05
status: complete
---

# Phase 07 Plan 09: Deterministic Reference Evidence Summary

**A 64-case, source-mapped deterministic corpus now produces a redacted, content-addressed Phase 7 design record while every protected live claim remains promotion-blocking.**

## Performance

- **Duration:** 11m
- **Started:** 2026-08-05T16:43:42Z
- **Completed:** 2026-08-05T16:54:07Z
- **Tasks:** 2/2
- **Files modified:** 12

## Accomplishments

- Replaced the Wave 0 registry with 12 admission, 16 resilience, 16 security, 10 publication, and 10 launch cases, with complete requirement, D-114..D-129, STRIDE, API, UI, and AI-dimension mappings.
- Added comparator-only execution and suite selection for the deterministic corpus; changed expected values and protected-data/live-pass mutations fail.
- Built and independently revalidated immutable evidence `8ff150d22f8dcebfe8be9418061421a530bf78c9fd8c3929d4a54dea3c1c0d5c`, atomically pointed to by `evidence/design/phase-07.json`.
- Kept all protected live owners as `blocked` or `not_observed`; deterministic evidence reports `offlineVerdict: passed` and `promotionVerdict: blocked`.

## Task Commits

1. **Task 1: Execute the complete 64-case actual-authority reference set** — `6a3d71c` (RED), `816b25b` (GREEN)
2. **Task 2: Emit and independently verify immutable Phase 7 design evidence** — `f8f3b56` (RED), `976a385` (GREEN)
3. **Follow-up correctness fix: close completed fault-matrix handoff** — `eee4533` (fix)

## Files Created/Modified

- `src/certification/phase-07-reference-set.ts` — strict corpus schema, source coverage validation, bounded deterministic executor, and protected-data checks.
- `tests/fixtures/phase-07-reference-set.json` — canonical 64-case reference dataset and protected-live owner inventory.
- `src/certification/evidence.ts` — Phase 7 design evidence build, validation, immutable write, and atomic pointer update.
- `scripts/eval-phase-07.ts` and `scripts/verify-phase-07-evidence.ts` — deterministic suite and evidence verification commands.
- `evidence/design/phase-07.json` — stable pointer to the validated immutable design record.

## Decisions Made

- Local deterministic execution is sufficient only for owned offline claims; no fixture, structural availability, or self-report upgrades a protected live claim.
- The release pointer retains `promotionVerdict: blocked` until Plan 07-10 supplies fresh protected evidence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated Wave 0 tests that asserted the replaced five-row fixture**
- **Found during:** Task 2 verification
- **Issue:** Existing admission, fault, and promotion tests dereferenced the retired `entries` shape, breaking the full suite after the 64-case corpus replaced it.
- **Fix:** Migrated those assertions to validate the canonical corpus and non-passing protected-live inventory.
- **Files modified:** `tests/phase-07/admission-slo.test.ts`, `tests/phase-07/fault-matrix.test.ts`, `tests/phase-07/promotion-gate.test.ts`
- **Verification:** Focused Phase 7 tests and complete Bun suite pass.
- **Committed in:** `976a385`

**2. [Rule 1 - Bug] Corrected the telemetry probe to use the existing strict lifecycle input contract**
- **Found during:** Task 1 implementation
- **Issue:** The first probe used obsolete telemetry field names and was correctly rejected before comparator execution.
- **Fix:** Passed only `cvm.lifecycle.v1`, `correlationId`, and monotonic facts to the redaction authority.
- **Files modified:** `src/certification/phase-07-reference-set.ts`
- **Verification:** `bun test tests/evals/phase-07-reference-set.test.ts --timeout 10000` passes.
- **Committed in:** `816b25b`

**Total deviations:** 2 auto-fixed Rule 1 correctness fixes. No scope expansion or live-certification claim was introduced.

## Known Stubs

None in plan-owned output. The pre-existing Plan 07-10 promotion-gate TODO remains a later protected-live responsibility and is not represented as a deterministic pass.

## User Setup Required

None for deterministic execution. Protected live credentials and topology are intentionally required by Plan 07-10 and remain explicit promotion blockers.

## Next Phase Readiness

Plan 07-10 can consume the immutable pointer and must replace each protected-live blocked/not_observed owner with fresh candidate-bound protected evidence before promotion can pass.

## Self-Check: PASSED

- The corpus, evaluator, evidence builder, immutable record, and stable pointer all exist.
- Commits `6a3d71c`, `816b25b`, `f8f3b56`, `976a385`, and `eee4533` exist.
- `bun run eval:phase07`, both evidence verifier modes, and `bun test --timeout 10000` passed (465 pass, 1 pre-existing Plan 07-10 TODO, 0 fail).
