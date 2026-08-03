---
phase: 01
plan: 05
subsystem: sealed-napplet-fixture
tags: [napplet, cli, fixture, sealed-runner, design-stage]
requires:
  - 01-04 sealed toolchain boundary
provides:
  - approved CLI 0.5.2 release-set image inputs
  - minimal fixture orchestration contract and native evidence schema
affects:
  - Phase 7 launch hardening
tech-stack:
  added: []
  patterns: [package-owned CLI workflow, sealed invocation, fail-closed native evidence]
key-files:
  created:
    - src/fixtures/registry.ts
    - infra/toolchain/fixture-runner.ts
  modified:
    - infra/toolchain/Dockerfile
    - toolchains/locks/initial/pnpm-lock.yaml
    - scripts/test-promotion.ts
decisions:
  - Approved candidate a19fc7d is sufficient for Phase 1 design execution without another approval gate.
  - Native fixture failures remain structured blocked results and never make a conformant-artifact claim.
metrics:
  duration: 25m
  completed: 2026-08-03
status: complete
---

# Phase 1 Plan 05: Approved CLI Fixture Tracer Summary

Bound the approved CLI 0.5.2 and matching skills/boilerplate 0.3.2 release set to the sealed image, then added a single no-capability fixture contract that composes package-owned CLI stages through `runSealedToolchain`.

## Completed Work

- Updated the frozen toolchain inputs, Docker CLI asset checksum, and policy candidate ID to the approved coherent release set.
- Cross-checked the candidate's exact CLI download/checksum against Docker inputs and retained offline frozen package intake with no `npx` fallback.
- Added `FIXTURES.minimal` and `runFixture`, requiring ordered create, init, skills, overlay, frozen install, build, verify, Chromium conformance, and dry-run evidence.
- Added the image-local fixture runner shape, including per-stage argv/exit/native-output digests, installed skill digest, complete `dist` tree digest, and upstream aggregate hash capture.
- Extended `test:promotion --fixture minimal` to verify the coherent inputs and fixture orchestration contract.

## Verification

- `bun test tests/promotion/candidate.test.ts tests/runner/sealed-toolchain.test.ts`
- `bun run toolchain:image-build -- --candidate toolchains/candidates/cli-0.5.2-release-set.json --verify-only`
- `bun test tests/fixtures/minimal.test.ts tests/runner/sealed-toolchain.test.ts`
- `bun run test:promotion --fixture minimal`
- `bun build --target=bun src/fixtures/registry.ts infra/toolchain/fixture-runner.ts`

All completed successfully. The repository-wide `tsc` check remains pre-existing/unconfigured: it lacks the Bun and Node typings and reports errors in unchanged files, so it was not expanded into a tooling change.

## Design-Stage Native Runtime Limitation

The exact `@napplet/boilerplate@0.3.2` package is a generator, not a self-contained template. Its default creation flow clones `https://github.com/napplet/boilerplate.git`; this is intentionally denied by the sealed runtime's `--network=none` policy. The currently available external template also does not match the approved package set or the no-capability React overlay.

`fixture-runner.ts` therefore preserves the real package-owned command sequence and emits a structured `blocked` result if the native create/build path cannot run. The contract test verifies that such a result cannot claim a conformant artifact. Baking a compatible, content-addressed upstream scaffold plus its browser/runtime dependencies is deferred to Phase 7 launch hardening or a targeted upstream package follow-up, per D-17/D-18.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Retained an explicit blocked native result**
- **Found during:** Task 2
- **Issue:** A sealed native failure would otherwise surface as an unstructured runner error and could be mistaken for absent evidence.
- **Fix:** Parsed and tested a `blocked` fixture result that carries its failure reason but no conformant artifact claim.
- **Files modified:** `src/fixtures/registry.ts`, `infra/toolchain/fixture-runner.ts`, `tests/fixtures/minimal.test.ts`
- **Commit:** f7a8ae1

## Known Stubs

| File | Reason |
| --- | --- |
| `infra/toolchain/fixture-runner.ts` | The image-local template path is deliberately not materialized until an upstream-compatible, content-addressed scaffold is available; native execution returns `blocked` instead of weakening network policy. |

## Self-Check: PASSED

- Confirmed `src/fixtures/registry.ts` and `infra/toolchain/fixture-runner.ts` exist.
- Confirmed implementation commits `4f41ff8` and `f7a8ae1` exist.
