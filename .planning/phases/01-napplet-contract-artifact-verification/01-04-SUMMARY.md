---
phase: 01-napplet-contract-artifact-verification
plan: 04
subsystem: sealed-toolchain
tags: [bun, docker, pnpm, hermetic-runner, supply-chain, egress-control]
requires:
  - phase: 01-03
    provides: Human-approved immutable package, CLI, and provenance candidate
provides:
  - Digest-pinned, two-stage napplet toolchain image with frozen package inputs
  - Strict default-deny Docker policy and a single promotion command adapter
  - Executed DNS, HTTP, HTTPS, TCP, secret-canary, and resource-boundary evidence
affects: [01-05, 01-06, 01-07, promotion, sealed-builds]
tech-stack:
  added: [Docker BuildKit, pnpm 10.24.0]
  patterns: [reviewed-intake-to-sealed-image, policy-derived-literal-docker-argv, mandatory-denial-probes]
key-files:
  created:
    - infra/toolchain/Dockerfile
    - infra/toolchain/egress-policy.json
    - infra/toolchain/denial-probe.ts
    - src/runner/sealed-toolchain.ts
    - toolchains/locks/initial/pnpm-lock.yaml
  modified:
    - src/promotion/run-promotion.ts
    - scripts/build-toolchain-image.ts
    - scripts/test-promotion.ts
    - tests/runner/sealed-toolchain.test.ts
    - tests/tracer.test.ts
key-decisions:
  - "Only the integrity-checked intake stage has network access; the sealed stage receives frozen node_modules, a pinned standalone CLI, and no runtime package resolver."
  - "Every promotion invokes egress denial probes through the same runSealedToolchain adapter before its actual stages."
  - "BuildKit provenance emission is disabled for the local sealed image so identical inputs retain a stable content-addressed image digest."
patterns-established:
  - "Parse one closed Docker policy schema before constructing literal Docker argv; callers cannot supply security flags, mounts, or environments."
  - "Treat a missing or ambiguous denial-probe marker as a blocker, never as a successful network denial."
requirements-completed: [GEN-01, GEN-04, SAFE-05]
coverage:
  - id: D1
    description: Reviewed candidate materializes into a deterministic image with frozen package integrities and image-local CLI/conformance binaries.
    requirement: GEN-01
    verification:
      - kind: integration
        ref: bun run toolchain:image-build -- --candidate toolchains/candidates/initial.json
        status: pass
      - kind: unit
        ref: tests/runner/sealed-toolchain.test.ts#image inputs bind the reviewed candidate to a frozen offline lock
        status: pass
    human_judgment: false
  - id: D2
    description: Promotion stages and denial probes share a strict Docker boundary with egress, privilege, environment, and resource controls.
    requirement: SAFE-05
    verification:
      - kind: unit
        ref: tests/runner/sealed-toolchain.test.ts#runSealedToolchain
        status: pass
      - kind: integration
        ref: bun run test:promotion --assert-hermetic
        status: pass
    human_judgment: false
duration: 99 min
completed: 2026-08-03
status: complete
---

# Phase 01 Plan 04: Sealed Toolchain and Promotion Boundary Summary

**A digest-stable, reviewed napplet toolchain image and one policy-enforced Docker path for every promotion command and network-denial probe.**

## Performance

- **Duration:** 99 min
- **Started:** 2026-08-03T08:07:03Z
- **Completed:** 2026-08-03T09:46:08Z
- **Tasks:** 2/2
- **Files modified:** 12
- **Verification:** 26 Bun tests, hermetic promotion suite, two deterministic image rebuilds, and executed egress denials.

## Accomplishments

- Materialized the Plan 03-approved candidate through an integrity-checked intake stage into a pinned Bun 1.3.14 image with an exact pnpm lock, standalone CLI checksum, image-local conformance binary, and no `npx` fallback.
- Added a closed policy schema and `runSealedToolchain`, which emits only literal `docker run` argv with `--network=none`, read-only root, dropped capabilities, no-new-privileges, non-root UID/GID, tmpfs mounts, bind-read-only input, scrubbed environment, and resource ceilings.
- Routed promotion through the sealed adapter and made DNS, HTTP, HTTPS, and raw TCP denials mandatory, explicit evidence before any stage can become review-ready.

## Task Commits

1. **Task 1: Materialize the exact reviewed image and frozen inputs (RED)** — `c9859af` (test)
2. **Task 1: Materialize the exact reviewed image and frozen inputs (GREEN)** — `4e04e93` (feat)
3. **Task 2: Route promotion and denial probes through one sealed Docker wrapper (RED)** — `e367ede` (test)
4. **Task 2: Route promotion and denial probes through one sealed Docker wrapper (GREEN)** — `4390643` (feat)

## Files Created/Modified

- `infra/toolchain/Dockerfile` and `toolchains/locks/initial/` — reviewed intake and sealed image inputs.
- `infra/toolchain/egress-policy.json` and `src/runner/sealed-toolchain.ts` — closed isolation policy, literal Docker argv, and evidence contract.
- `infra/toolchain/denial-probe.ts` — image-local DNS/HTTP/HTTPS/TCP checks that produce explicit denial markers.
- `src/promotion/run-promotion.ts` — mandatory shared wrapper and probe wiring for every candidate run.
- `scripts/build-toolchain-image.ts` and `scripts/test-promotion.ts` — deterministic materialization/verification and no-bypass promotion test command.

## Decisions Made

- The final image receives only frozen, script-free package material from intake; it cannot resolve packages or fall back to `npx` at runtime.
- A non-zero process alone is not proof of egress denial: all four probes must emit their exact `CVM_DENIAL_PROBE:<protocol>:denied` marker.
- The image digest is stable across identical builds by disabling nondeterministic BuildKit provenance annotations for this local artifact identity.

## TDD Gate Compliance

- **RED:** `c9859af` and `e367ede` added missing-module image/policy and sealed-wrapper tests, both observed failing before implementation.
- **GREEN:** `4e04e93` and `4390643` implemented the materialization and wrapper paths; all tests pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added a frozen toolchain package manifest and image-local denial executable**
- **Found during:** Tasks 1 and 2
- **Issue:** A lockfile alone could not produce a frozen install, and a missing denial executable could be misread as a rejected network request.
- **Fix:** Added the pinned toolchain package manifest plus an image-local probe that emits explicit per-protocol denial evidence.
- **Files modified:** `toolchains/locks/initial/package.json`, `infra/toolchain/Dockerfile`, `infra/toolchain/denial-probe.ts`, `src/runner/sealed-toolchain.ts`
- **Verification:** Real image build and executed DNS/HTTP/HTTPS/TCP denials passed.
- **Committed in:** `4e04e93`, `9398aa7`

**2. [Rule 3 - Blocking] Bootstrapped pnpm without Corepack or curl in the pinned Bun base image**
- **Found during:** Task 1
- **Issue:** The pinned base image lacked Corepack, curl, user-management helpers, and a directly reusable pnpm executable path.
- **Fix:** Downloaded pnpm only from its integrity-pinned tarball via Bun, copied its exact runtime data into the sealed stage, and used numeric ownership rather than unavailable user-management commands.
- **Files modified:** `infra/toolchain/Dockerfile`, `scripts/build-toolchain-image.ts`
- **Verification:** The real Docker build completed with a frozen script-free installation.
- **Committed in:** `4e04e93`

**3. [Rule 1 - Bug] Stabilized the reported image digest**
- **Found during:** Overall verification
- **Issue:** BuildKit provenance metadata changed the manifest digest for otherwise identical local builds.
- **Fix:** Disabled provenance emission for this local deterministic artifact build and verified two consecutive builds returned the same digest.
- **Files modified:** `scripts/build-toolchain-image.ts`
- **Verification:** Both rebuilds returned `sha256:1de9323f6953405948f66b3c7aba8eea8b60d84c561d0e72d93112c9a4ec39dd` before the subsequent probe-only image update.
- **Committed in:** `c18d8f5`

---

**Total deviations:** 3 auto-fixed (Rule 1, Rule 2, Rule 3)
**Impact on plan:** All changes enforce the planned sealed-build boundary; no protocol, publication, or promotion-pointer authority was added.

## Issues Encountered

- The pinned Bun base has a minimal userspace. The final image therefore uses numeric `65532:65532` ownership and user selection, which remains the required non-root runtime boundary.
- The latest materialized image digest after adding executed denial probes is `sha256:38df5fcdef0399dbbc4ded884c7fe15ddabc106662acd7572cfa6be02b742666`.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 01-05 onward can run approved fixture stages only through the image-local CLI/conformance toolchain and `runSealedToolchain`.
- The D-04 promotion manifest still requires later phase pins for NAP revisions, fixtures, goldens, and final review; this plan cannot mutate a current promoted pointer.

## Self-Check: PASSED

- Confirmed all sealed-image, lock, policy, wrapper, and test files exist.
- Confirmed task commits `c9859af`, `4e04e93`, `e367ede`, `4390643`, `c18d8f5`, and `9398aa7` are present in git history.
