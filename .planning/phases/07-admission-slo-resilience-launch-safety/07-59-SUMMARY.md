---
phase: 07-admission-slo-resilience-launch-safety
plan: "59"
subsystem: testing
tags: [ci, docker, payments, playwright, nostr-relay]
requires:
  - phase: 07-57
    provides: development payment and GUI CI gates
provides:
  - run-owned payment test configuration and explicit retained test discovery
  - native AMD64 relay readiness preflight for payment and GUI workflows
affects: [OPS-04, development-payments, development-gui]
tech-stack:
  added: []
  patterns: [run-owned test fixtures, digest-pinned relay probe]
key-files:
  created: [tests/dev/payment-config.ts, tests/dev/payment-config.test.ts, scripts/probe-development-relay.ts]
  modified: [scripts/dev-payments.ts, tests/dev/funding.e2e.test.ts, .github/workflows/development-payments.yml, .github/workflows/development-gui.yml]
key-decisions:
  - "Payment tests receive only a mode-0600 config owned by their generated run identity."
  - "Required CI uses native AMD64 rather than ARM emulation for the pinned relay."
requirements-completed: []
coverage:
  - id: D1
    description: Run-owned payment config rejects ambient, non-loopback, malformed, symlinked, and cross-run inputs.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: bun test tests/dev/payment-config.test.ts --timeout 10000
        status: pass
    human_judgment: false
  - id: D2
    description: Pinned relay preflight starts the AMD64 image and establishes a loopback WebSocket.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: bun scripts/probe-development-relay.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Full retained payment and GUI CI suites run with their prerequisites.
    requirement: OPS-04
    verification:
      - kind: integration
        ref: bun scripts/dev-payments.ts test
        status: unknown
    human_judgment: true
    rationale: Local Docker address pools were exhausted before the isolated stack could start; clean remote CI remains required.
metrics:
  duration: partial
  completed: 2026-10-27
status: verification_pending
---

# Phase 07 Plan 59: Development CI Prerequisites Summary

**Run-owned payment fixtures and native AMD64 relay preflight are implemented; clean remote CI must verify the retained full suites.**

## Accomplishments

- Replaced ambient primary-workspace payment reads with a strict, mode-checked, loopback-only resolver that also rejects symlinked ancestor directories.
- Made payment test selection explicit across `tests/dev` and `tests/dev-ui`, while provisioning browser, Chromium, and native worker prerequisites.
- Replaced the stale migration count with exact ordered migration names and source SHA-256 values.
- Added a uniquely named digest-pinned relay probe and moved the required GUI job to native AMD64.

## Task Commits

1. **Task 1 RED: strict payment config coverage** — `86512c9` (test)
2. **Task 1: self-contained payment suite** — `7e25a40` (feat)
3. **Task 2: native relay preflight and CI runner** — `467f70a` (ci)

## Verification

- Passed: `bun test tests/dev/payment-config.test.ts --timeout 10000` (6 tests), including Cashu v4 `cashuB` format and failure cleanup.
- Passed: `bun scripts/probe-development-relay.ts` — exact pinned relay reported `amd64` and `websocket: ready`.
- Pending: `bun scripts/dev-payments.ts test` installed/built the browser and native worker prerequisites, then failed before the isolated stack started because the local Docker daemon reported `all predefined address pools have been fully subnetted` while creating `napplet-cvm-payments-test-4509bf873cbe7cfe_default`.
- Pending: clean remote payment and GUI workflow runs. GUI run `40507779530` passed the pinned relay probe but failed building the ARM64-default worker on the AMD64 runner. Both jobs now set `NAPPLET_CVM_WORKER_PLATFORM=linux/amd64`; Compose configuration checks confirm both worker images select that platform. No remote CI has been claimed as green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected a syntax error in the new relay probe before verification.**
- **Found during:** Task 2 local probe run.
- **Fix:** Repaired the malformed Docker image-inspect format argument.
- **Verification:** The relay probe passed after the correction.
- **Committed in:** `467f70a`.

**2. [Rule 3 - Verification reference] The planned `tests/dev-ui/launcher.test.ts` does not exist in this checkout.**
- **Found during:** Task 2 verification.
- **Fix:** Updated the plan to its existing isolated launcher flow: `bun run tests/dev-ui/launcher.e2e.ts --case=clean-up-idempotent-down-persist-reset`.
- **Impact:** Clean remote GUI CI remains required.

## Issues Encountered

The local Docker daemon had exhausted its predefined address pools. The executor did not prune networks or alter shared/operator Docker state. The isolated test command's `finally` cleanup targeted only its generated project; subsequent `docker ps` and network checks found no `napplet-cvm-payments-test-*` or relay-probe resource.

Remote payment run `40508257133` completed all 138 selected tests: 135 passed and three failed. The real worker result test exposed native-Linux bind-mount ownership (`EACCES` removing a worker-owned directory); the development worker now matches a non-root launcher's numeric identity and retains UID/GID 65532 for root launchers, with network/capability/read-only controls intact. The authoring assertion was stale after the supported data-only `src/capabilities.json` surface was added; it now asserts that exact surface and the protected manifest/dependency/toolchain prohibition. Six focused lifecycle/authoring tests pass. The pre-admission real-worker failure requires the next full run to establish whether the ownership correction also resolves it; it has not been waived.

## Next Phase Readiness

PR #5 is open. Do not mark OPS-04 complete until the retained payment and GUI workflows pass remotely.

## Self-Check: PASSED

- Task commits `86512c9`, `7e25a40`, and `467f70a` exist locally.
- The three new source/test artifacts named in frontmatter exist.
