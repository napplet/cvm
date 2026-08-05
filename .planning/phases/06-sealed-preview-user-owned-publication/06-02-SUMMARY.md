---
phase: 06-sealed-preview-user-owned-publication
plan: "02"
subsystem: publication
tags: [sealed-preview, capability-review, sha256, zod, sandbox]
requires:
  - phase-06-plan-01
    provides: strict sealed-artifact and preview/publication tracer contracts
provides:
  - owner-safe sealed-preview descriptor and runtime-status projection
  - manifest-derived canonical capability review and approval digest
affects: [phase-06-plans-03-through-07, contextvm-preview-adapter]
tech-stack:
  added: []
  patterns: [manifest-derived-review, versioned-canonical-bytes, deny-by-default-host-grants, owner-safe-runtime-projection]
key-files:
  created:
    - src/publication/public-status.ts
    - src/publication/capability-review.ts
    - tests/phase-06/fakes.ts
    - tests/phase-06/preview-descriptor.test.ts
    - tests/phase-06/runtime-status.test.ts
    - tests/phase-06/capability-review.test.ts
  modified:
    - src/publication/contracts.ts
    - src/publication/preview-service.ts
decisions:
  - Preview host responses may echo only the descriptor context plus the three grant fields; any other field is a safe denial.
  - Canonical capability digest binds the manifest hash, artifact identity, d-tag, policy/toolchain/runtime identities, selected runtime, and normalized declarations.
patterns-established:
  - Runtime messages are parsed as tainted observations and projected through a finite owner-safe allowlist.
  - Required capabilities block preview; optional gaps are explicit degradation with no direct-authority fallback.
requirements-completed: [PREV-01, PREV-02, PREV-03, PREV-04]
coverage:
  - id: D1
    description: Exact verified-artifact preview descriptor with allow-scripts-only, read-only grant and zero publication authority.
    requirement: PREV-01
    verification:
      - kind: unit
        ref: tests/phase-06/preview-descriptor.test.ts#issues one exact verified-artifact descriptor with an allow-scripts-only read grant
        status: pass
    human_judgment: false
  - id: D2
    description: Expiry-aware, finite, owner-safe runtime status projection that discards tainted message fields.
    requirement: PREV-03
    verification:
      - kind: unit
        ref: tests/phase-06/runtime-status.test.ts#projects ready, incompatible, exact-expiry, post-expiry, and denied observations into only safe states
        status: pass
    human_judgment: false
  - id: D3
    description: Required-first manifest capability review with deterministic canonical bytes and SHA-256 approval binding.
    requirement: PREV-04
    verification:
      - kind: unit
        ref: tests/phase-06/capability-review.test.ts#canonicalizes empty and permuted verified-manifest capability declarations into exact stable bytes
        status: pass
    human_judgment: false
metrics:
  duration: 38m 22s
  completed_date: 2026-08-05
status: complete
---

# Phase 06 Plan 02: Complete Sealed Preview and Capability Review Summary

Exact verified bytes now receive only a short-lived, `allow-scripts` preview descriptor, while canonical manifest capability facts produce an approval-bound SHA-256 digest and finite owner-safe runtime status.

## Performance

- **Duration:** 38m 22s
- **Started:** 2026-08-05T08:11:05Z
- **Completed:** 2026-08-05T08:49:27Z
- **Tasks:** 2/2
- **Files modified:** 8

## Accomplishments

- Denies malformed, substituted, or incomplete artifact identities before descriptor creation or any publication effect; valid descriptors have a fixed one-minute expiry, `allow-scripts` sandbox, and `preview_read_only` authority only.
- Projects untrusted host/runtime observations into the exhaustive ready, incompatible, expired, or denied status contract with safe next actions and no raw runtime fields.
- Parses verified-manifest capability declarations only, rejects duplicates/conflicts/identity mismatches, preserves required-first byte order, and binds all approval fences into SHA-256 canonical review bytes.

## Task Commits

1. **Task 1: Issue exact sealed preview descriptors and safe runtime statuses** — `3c56605` (RED), `e34c234` (GREEN)
2. **Task 2: Canonicalize required/optional capabilities and bind runtime compatibility** — `873c943` (RED), `7a19916` (GREEN), `1a5675c` (security fix)

## Verification

- `bun test tests/phase-06/preview-descriptor.test.ts tests/phase-06/runtime-status.test.ts tests/phase-06/capability-review.test.ts --timeout 10000` — 8 passed, 0 failed.
- `bun test tests/phase-06/tracer.test.ts --timeout 10000` — 3 passed, 0 failed.

## TDD Gate Compliance

- RED commits: `3c56605`, `873c943`.
- GREEN commits: `e34c234`, `7a19916`.

## Decisions Made

- Host responses are deny-by-default: only the known grant fields and echoed descriptor context are permitted, so any new browser, signer, relay, storage, network, or publication field is rejected without creating an effect.
- Canonical review data carries explicit required/optional availability and normalized compatible-runtime facts; all capability, artifact, manifest, d-tag, policy, toolchain, runtime identity, and selected runtime facts contribute to the approval digest.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added verified-manifest capability declaration and approval-fence contract fields**
- **Found during:** Task 2
- **Issue:** The Phase 6 tracer schema could not express manifest-only purpose, consent, compatible-runtime, and availability facts or bind every D-102 approval fence.
- **Fix:** Added bounded strict declaration fields and optional review fence fields, then used them in the canonical serializer/digest.
- **Files modified:** `src/publication/contracts.ts`, `src/publication/capability-review.ts`, `src/publication/preview-service.ts`
- **Verification:** Capability, descriptor, runtime-status, and tracer tests pass.
- **Committed in:** `7a19916`

**2. [Rule 1 - Bug] Rejected host-grant authority expansion**
- **Found during:** Task 2 verification
- **Issue:** A permissive parsed host result could admit unrecognized authority-bearing fields while preserving the safe fields.
- **Fix:** Restricted host result keys to the three grant values and expected echoed descriptor context; every other field returns a safe denial.
- **Files modified:** `src/publication/preview-service.ts`, `tests/phase-06/preview-descriptor.test.ts`
- **Verification:** Focused authority-expansion test and all plan verification pass.
- **Committed in:** `1a5675c`

**Total deviations:** 2 auto-fixed (1 Rule 2, 1 Rule 1).
**Impact on plan:** Both changes were required to enforce the stated manifest-only and least-authority preview contracts; no unrelated scope was added.

## Known Stubs

None. Deterministic ports remain intentional test fixtures; live host runtime integration is explicitly deferred to later Phase 6/7 work.

## Next Phase Readiness

Plan 03 can bind these exact preview/capability identities into the explicit signed publication-intent flow. No external user setup is required.

## Self-Check

PASSED — all eight planned files exist and all five TDD/task commits (`3c56605`, `e34c234`, `873c943`, `7a19916`, `1a5675c`) exist in git history.
