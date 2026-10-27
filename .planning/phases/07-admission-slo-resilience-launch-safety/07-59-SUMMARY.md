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

Payment run `40509872748` passed all 138 tests / 923 assertions at source `1442809`, including both previously failing worker flows. GUI run `40509872944` then timed out in the remix journey: its selector still expected the old `Version N · latest` label, while version restoration now renders `Version N · current`. Updated the exact selectors in both affected browser journeys and added bounded failure-state diagnostics to the remix wait. Full GUI verification remains pending; no journey was skipped.

At `7db29af`, payment run `40512008210` passed again. GUI run `40512008420` passed remix, product-view and responsive flows, then exposed another stale older-version assertion. The product journey now requires the current restore-or-return explanation, an enabled restore control, and the current-version return button; direct edits to an older preview must remain disabled. Full GUI verification is still pending.

At `f041e7b`, payment run `40513639887` passed. GUI run `40513639935` passed the full product journey and OAuth flow, then exposed a real timeout presentation defect: cost receipts replaced the detailed failure message with a generic outcome. Failure messages now retain their request key and enrich only the matching unresolved receipt. A browser regression failed before the fix and passes after it, including repeated refresh, saved workspace reconstruction, text-only rendering, and suppression after successful reconciliation. Full remote GUI verification remains required.

At `5499e7d`, payment run `40516163304` passed. GUI run `40516163434` passed the timeout, interrupted-generation, static publication, returning-project, and both-rail funding flows; the latter then failed its evidence check because it retained old root dependency hashes. Both that check and the later full-flow check now use the launcher’s existing approved pin set from one shared verifier. Three local checks prove the current manifests pass and changing either file is refused. No pin was loosened or dropped.

At `58cb406`, the payment workflow passes 141 tests / 926 assertions. The GUI run `40518538358` stalled for its existing ten-minute process limit in static publication, a journey that passed at `5499e7d`; its bounded stderr only showed relay liveness recovery. Added fixed stage labels and periodic stage-only diagnostics to identify whether a subsequent stall is in browser work, restart, or cleanup. No timeout or acceptance check changed. Full GUI verification remains pending.

At `5ec6c1c`, GUI run `40522167383` passed publication/restart/revision/metadata assertions but the child stayed alive after cleanup. A focused subprocess regression reproduced the SDK relay pool rebuilding after a liveness ping completed past disconnect, retaining its timer (exit 137 after the test deadline). The pinned `@contextvm/sdk@0.13.10` patch fences terminal disconnect against late liveness/rebuild/publish/subscribe work; the same process now exits normally in about 220 ms. The root verifier pins the patch bytes as well as both dependency manifests, and the homelab image copies patches before frozen installation. Five focused checks pass. Full remote CI remains required.

## Next Phase Readiness

PR #5 is open. Do not mark OPS-04 complete until the retained payment and GUI workflows pass remotely.

## Self-Check: PASSED

- Task commits `86512c9`, `7e25a40`, and `467f70a` exist locally.
- The three new source/test artifacts named in frontmatter exist.
