---
phase: 07-admission-slo-resilience-launch-safety
plan: "52"
subsystem: payments-ui
tags: [contextvm, nostr, cashu, nwc, postgres, playwright]
requires:
  - phase: 07-51
    provides: local Cashu, NWC, relay, PostgreSQL, and durable funding composition
provides:
  - Browser-owned disposable ContextVM identity over encrypted Nostr relay transport
  - Real Cashu and NWC browser funding with durable SQL reconciliation
affects: [07-53, 07-54, 07-55, 07-56]
tech-stack:
  added: [playwright-1.62.1-isolated]
  patterns: [request-scoped CEP-8 tags, loopback-only dev bootstrap, durable pending NWC observation]
key-files:
  created: [src/dev-ui/contextvm-server.ts, src/dev-ui/browser/contextvm-client.ts, src/dev/dev-funding-reconciler.ts, tests/dev-ui/contextvm-funding.e2e.ts]
  modified: [src/contextvm/sdk-bridge.ts]
key-decisions:
  - "Browser payment tags are frozen and retained only for the matching SDK request."
  - "NWC reconciliation scans durable pending top-ups and observes the original invoice identity."
requirements-completed: [DEV-GUI-01, DEV-GUI-02]
requirements-partial: [DEV-GUI-03, DEV-GUI-04, DEV-GUI-09, DEV-GUI-10, DEV-GUI-12]
production-requirements-deferred: [SESS-02, OPS-02, OPS-03]
coverage:
  - id: D1
    description: Browser-owned disposable identity traverses encrypted ContextVM lifecycle and tools calls through the local relay.
    requirement: DEV-GUI-01
    verification:
      - kind: automated_ui
        ref: tests/dev-ui/contextvm-funding.e2e.ts --case=cashu-wire
        status: pass
    human_judgment: false
  - id: D2
    description: Cashu replay and NWC restart observation credit the SQL account exactly once and update the browser projection.
    requirement: DEV-GUI-02
    verification:
      - kind: e2e
        ref: tests/dev-ui/contextvm-funding.e2e.ts --case=both-rails-restart-replay
        status: pass
    human_judgment: false
metrics:
  duration: 47min
  completed: 2026-10-15
status: complete
---

# Phase 07 Plan 52: Browser ContextVM Funding Tracer Summary

**Real Chromium funding through encrypted ContextVM events credits the durable PostgreSQL ledger once for Cashu replay and restart-aware local NWC settlement.**

## Performance

- **Duration:** 47 min
- **Started:** 2026-10-15T14:09:00Z
- **Completed:** 2026-10-15T14:56:42Z
- **Tasks:** 2/2
- **Files modified:** 10

## Accomplishments

- Added official SDK browser transport with a browser-memory-only disposable signer, request-local CEP-8 payment tags, and no HTTP product command path.
- Extended the server bridge for initialize, tools discovery, notifications, safe metadata variants, and asynchronous parse-error containment while preserving signed event attribution.
- Added a responsive connection/funding workspace that projects only signed ContextVM account data, plus durable pending NWC settlement observation after a reconciler restart.
- Proved Cashu replay and both payment rails in Chromium against disposable real relay, Cashu, NWC, and PostgreSQL services; root package and lockfile hashes stayed unchanged.

## Task Commits

1. **Task 1: Drive one Cashu credit from a real browser through encrypted ContextVM into SQL** - `f432c33` (test RED), `e3eeec0` (feat GREEN)
2. **Task 2: Expose durable Cashu/NWC funding, balance, reserve, and ceiling in the workspace** - `56710ef` (feat)

## Files Created/Modified

- `src/contextvm/sdk-bridge.ts` - SDK lifecycle, notification, metadata, and error-safe bridge handling.
- `src/dev-ui/contextvm-server.ts` - loopback static/bootstrap/faucet surface and real ContextVM service composition.
- `src/dev-ui/browser/contextvm-client.ts` - browser-only signer and immutable per-request payment tags.
- `src/dev/dev-funding-reconciler.ts` - bounded durable NWC observation.
- `src/dev-ui/browser/index.html` and `main.ts` - accessible connection and funding workspace.
- `tests/dev-ui/` - self-contained Playwright 1.62.1 package, lockfile, and browser evidence.

## Verification

- `bun install --cwd tests/dev-ui --frozen-lockfile`
- `bun run tests/dev-ui/contextvm-funding.e2e.ts --case=cashu-wire`
- `bun run tests/dev-ui/contextvm-funding.e2e.ts --case=both-rails-restart-replay`
- `bun test tests/contextvm/*.test.ts tests/dev/funding.test.ts` — 16 tests passed.
- `sha256sum package.json bun.lock` matched the locked baseline hashes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added a browser-only Pino shim for the installed SDK bundle**
- **Found during:** Task 1
- **Issue:** Bun's browser build followed Pino's Node transport dependencies despite the SDK's browser logger branch.
- **Fix:** Resolved `pino` to a silent browser logger shim only while bundling the official SDK client transport.
- **Files modified:** `src/dev-ui/browser/pino-browser-shim.ts`, `src/dev-ui/contextvm-server.ts`
- **Verification:** Browser Chromium cases passed through the official encrypted SDK transport.
- **Committed in:** `e3eeec0`

**2. [Rule 1 - Bug] Prevented local NWC reconciliation from treating invoice payment as proof**
- **Found during:** Task 2
- **Issue:** A proactive payment attempt delayed durable observation of the local receiver's original invoice.
- **Fix:** The reconciler now only scans durable pending rows and calls the existing settlement observer; it remains bounded and restart-aware.
- **Files modified:** `src/dev/dev-funding-reconciler.ts`
- **Verification:** `both-rails-restart-replay` passed with a reconciler stop/restart between NWC begin and credit.
- **Committed in:** `56710ef`

**Total deviations:** 2 auto-fixed (Rule 1: 1, Rule 3: 1).

## Known Stubs

None. Generation, worker, preview, continuation, revision, and publication remain explicitly owned by Plans 53–56 and are not represented as ready controls here.

## Next Phase Readiness

Plans 53–56 can use the exported local server entry point after `bun scripts/dev-payments.ts up`:

`bun src/dev-ui/contextvm-server.ts`

It prints a loopback workspace URL. The default five payment containers remain running; disposable test stacks are removed after each browser case. Production SESS-02 and OPS-02/03 obligations remain deferred and are not completed by this local evidence.

## Self-Check: PASSED

All committed application/test files exist, all three task commits are present, and no task commit deleted tracked files.
