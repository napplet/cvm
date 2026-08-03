---
phase: 01-napplet-contract-artifact-verification
plan: 06
subsystem: napplet-policy-evidence
tags: [napplet, capability, policy, evidence, design-stage]
requires:
  - phase: 01-05
    provides: approved CLI release-set and sealed fixture contract
provides:
  - storage-hard and intent-optional capability harness contract
  - gap-only, fail-closed artifact policy with representative rejections
  - canonical design-stage evidence record with explicit Phase 7 deferrals
affects: [phase-02, phase-07, generation-policy, launch-safety]
tech-stack:
  added: []
  patterns: [public-SDK-only capability composition, upstream-owned scanner evidence, blocked-native design evidence]
key-files:
  created:
    - fixtures/capability-harness/fixture.json
    - src/policy/artifact-contract.ts
    - src/verification/design-evidence.ts
    - scripts/verify-design-slice.ts
    - evidence/design/phase-01.json
  modified:
    - src/fixtures/registry.ts
    - infra/toolchain/fixture-runner.ts
    - scripts/test-promotion.ts
    - package.json
key-decisions:
  - The only direct shell observation is the post-injection presence read `window.napplet?.intent`; present intent is used only through public SDK `requireDomain`.
  - Native fixture limitations are durable blocked design evidence, never a claim of Chromium or conformance success.
  - Phase 1 evidence has certificationProfile design and rejects waivers; Phase 7 owns launch certification and promotion.
patterns-established:
  - "CVM policy consumes immutable upstream findings and adds only inventoried gaps."
  - "Representative blocked execution remains a usable downstream interface when its identity, reason, and deferred closure are explicit."
requirements-completed: [GEN-02, GEN-03, SAFE-06]
coverage:
  - id: D1
    description: Storage-hard/intent-optional SDK capability harness with primary and degraded contracts.
    requirement: GEN-03
    verification:
      - kind: unit
        ref: tests/fixtures/capability-harness.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Focused artifact policy rejects representative broad scope and authority-gap cases.
    requirement: GEN-02
    verification:
      - kind: unit
        ref: tests/policy/artifact-contract.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Design evidence binds the candidate, policy, fixture identities, and Phase 7 deferrals without production authority.
    requirement: SAFE-06
    verification:
      - kind: integration
        ref: bun run test:design-slice
        status: pass
    human_judgment: false
metrics:
  duration: 45m
  completed: 2026-08-03
status: complete
---

# Phase 1 Plan 06: Capability Policy and Design Evidence Summary

Public-SDK capability composition, representative napplet-only rejection policy, and a canonical design record now give downstream phases a fail-closed interface while accurately retaining the sealed native scaffold blocker.

## Accomplishments

- Added a `storage`-only hard capability fixture with primary optional `intent` SDK composition and an explicit no-intent degraded path.
- Added a version-bound upstream/CVM ownership inventory plus pure policy coverage for focused scope, direct authority, external assets, service workers, signer/relay code, and capability necessity.
- Added content-addressed design evidence and `test:design-slice`; the committed record is intentionally `blocked`, not a fabricated native/Chromium pass.

## Task Commits

1. **Task 1: Capability harness** - `5a8f4e2` (RED), `d873954` (implementation)
2. **Task 2: Artifact contract policy** - `07e49c1` (RED), `14f906d` (implementation)
3. **Task 3: Design verification record** - `3189389` (RED), `4a25f43` (implementation)

## Verification

- `bun test` — 52 passing tests.
- `bun run test:promotion --assert-hermetic` — passed.
- `bun run test:promotion --fixture minimal` and `--fixture capability-harness` — passed contract checks.
- `bun run test:design-slice` — emitted design evidence with `verdict: blocked` and no production authority.

## Decisions Made

- The capability harness uses `window.napplet?.intent` only as a presence read, then calls `requireDomain("intent")`; it never invokes `window.napplet` directly.
- Upstream scanner/conformance findings remain authoritative. CVM records and tests only the specifically inventoried policy gaps.
- The design record contains the owner-waiver shape but rejects any waiver; it lists exhaustive provenance, reproducibility, hostile matrices, goldens, waiver drills, SBOM enforcement, and production promotion as Phase 7 work.

## Deviations from Plan

### Auto-fixed Issues

1. [Rule 1 - Bug] Allowed structurally blocked harness reports to omit unproven capability observations.
- **Found during:** Task 3
- **Issue:** The registry required primary intent-use evidence even when the sealed native run had blocked before the fixture could execute, turning an honest blocked report into a parser error.
- **Fix:** Enforced the positive-mode capability observations only for passed native reports; blocked reports still require identity, ordered evidence, and a structured reason.
- **Files modified:** `src/fixtures/registry.ts`, `src/verification/design-evidence.ts`
- **Verification:** `bun test tests/fixtures tests/verification/design-evidence.test.ts`
- **Committed in:** `4a25f43`

## Known Stubs

| File | Reason |
| --- | --- |
| `infra/toolchain/fixture-runner.ts` | The published boilerplate generator clones GitHub, which is correctly denied in the sealed no-network path. A compatible content-addressed scaffold and real native/Chromium closure remain deferred to Phase 7. |

## Next Phase Readiness

Phase 2 can consume the focused-artifact policy and design-evidence interfaces now. Phase 7 must close the retained sealed native scaffold blocker and the explicitly listed launch-certification gates before any production promotion.

## Self-Check: PASSED

- Confirmed implementation commits `d873954`, `14f906d`, and `4a25f43` exist.
- Confirmed `fixtures/capability-harness/fixture.json`, `src/policy/artifact-contract.ts`, `src/verification/design-evidence.ts`, and `evidence/design/phase-01.json` exist.
