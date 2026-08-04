---
phase: 03-contextvm-funding-funded-admission
plan: 03
subsystem: api
tags: [contextvm, cep-8, nostr, funding, replay, redaction]
requires:
  - phase: 03-01
    provides: transport-neutral FundingService and canonical funding commands
  - phase: 03-02
    provides: serializable funding-store seam and package intake evidence
provides:
  - truthfully canonical ContextVM v1 discovery and top-up PMI metadata
  - SDK-confined signed transport bridge and project-owned transport port
  - verified-sender ContextVM funding adapter with durable replay and correlated redacted replies
affects: [03-04-lightning-top-up, 03-05-cashu-top-up, 03-06-funded-core-composition]
tech-stack:
  added: []
  patterns: [SDK-boundary bridge, verified-principal normalization, durable-domain-replay, protected-bearer-reference]
key-files:
  created: [src/contextvm/announcement.ts, src/contextvm/sdk-bridge.ts, src/contextvm/adapter.ts, tests/contextvm/adapter.test.ts, tests/fixtures/contextvm-phase-03.json]
  modified: []
key-decisions:
  - "ContextVM SDK delivery and correlation state are transport conveniences only; FundingService durable command records determine business replay."
  - "The v1 announcement advertises only top-up range metadata, never generation price, account authority, or a public x402/L402 surface."
  - "Cashu direct-payment bytes enter only an injected protected-material port and never a response, notification, or funding command."
patterns-established:
  - "Adapters derive Principal only from a strict SDK-verified clientPubkey and strict-parse all tool arguments before invoking the core."
  - "Responses and notifications are explicitly correlated to the original request event and are constructed from redacted result allowlists."
requirements-completed: [CTX-01, CTX-02, CTX-03, CTX-04, PAY-01, PAY-04, BILL-01]
coverage:
  - id: D1
    description: Truthful, deterministic ContextVM v1 announcement exposes required product surfaces and the two supported top-up PMIs only.
    requirement: CTX-01
    verification:
      - kind: integration
        ref: tests/contextvm/adapter.test.ts#announcement is canonical, truthful, and limited to the two v1 top-up PMIs
        status: pass
    human_judgment: false
  - id: D2
    description: Verified signed ContextVM requests normalize to transport-neutral funding commands with durable replay, exact PMI negotiation, correlation, and redaction.
    requirement: CTX-02
    verification:
      - kind: integration
        ref: tests/contextvm/adapter.test.ts#verified ContextVM funding adapter
        status: pass
    human_judgment: false
metrics:
  duration: 29min
  completed: 2026-08-04
status: complete
---

# Phase 3 Plan 03: Signed ContextVM Funding Adapter Summary

**A pinned ContextVM/CEP-8 boundary now maps only SDK-verified Nostr identity into durable funding commands while publishing truthful v1 discovery and redacted correlated results.**

## Accomplishments

- Added a canonical announcement that declares the full product surface but exposes only current account status, top-up, and funded-admission tools as invocable.
- Confined the pinned SDK, CEP-8 tags, payment-interaction modes, and canonical invocation identity to `src/contextvm/`.
- Added strict request/tag parsing, verified-principal normalization, durable core replay, protected Cashu bearer intake, and request-event-correlated safe responses.

## Task Commits

1. Task 1 RED announcement fixture — `0e65bfe` (`test`)
2. Task 1 announcement implementation — `c9a5d7c` (`feat`)
3. Task 2 RED signed-adapter fixture — `cd998fa` (`test`)
4. Task 2 adapter implementation — `de099a3` (`feat`)

## Verification

- `bun test tests/contextvm/adapter.test.ts` — 5 pass
- `bun test` — 217 pass, 0 fail
- `node /Users/sandwich/.codex/gsd-core/bin/gsd-tools.cjs check api-coverage.verify-pre .planning/phases/03-contextvm-funding-funded-admission` — pass (36 capabilities, 23 integrated, 13 explicit opt-outs)

## Files Created

- `src/contextvm/announcement.ts` — strict canonical discovery projection.
- `src/contextvm/sdk-bridge.ts` — sole pinned SDK transport bridge and public project-owned transport seam.
- `src/contextvm/adapter.ts` — verified-sender-only funding translator.
- `tests/fixtures/contextvm-phase-03.json` — pinned discovery, PMI, correlation, and direct-payment fixtures.
- `tests/contextvm/adapter.test.ts` — deterministic adapter contract and import-firewall tests.

## Decisions Made

- The adapter does not receive an SDK authorization, event, or session cache as financial authority; all repeated effects go through `FundingService` and its store.
- CEP-8 top-up negotiation is separate from generation usage pricing. The funded-admission waiver is an informational wire signal only after the core reservation result.
- Missing live relay/signer configuration remains outside this deterministic adapter path and is neither selected nor certified here.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Used the SDK's exported canonical-identity subpath.**

- **Found during:** Task 2 verification.
- **Issue:** The payments barrel does not export `computeCanonicalInvocationIdentity` in `@contextvm/sdk@0.13.10`.
- **Fix:** Imported the documented package export subpath, then exercised it through the bridge test.
- **Files modified:** `src/contextvm/sdk-bridge.ts`, `tests/contextvm/adapter.test.ts`.
- **Verification:** Focused adapter suite passes with the real SDK canonical identity implementation.
- **Committed in:** `de099a3`.

**Total deviations:** 1 auto-fixed (Rule 1).

## Issues Encountered

- The first full-suite run observed a concurrent Cashu test expectation mismatch; its owning plan corrected it. The final full suite passes.

## Next Phase Readiness

- Lightning/Cashu coordinators can consume the narrow protected-material and FundingService seams without importing ContextVM wire types into core modules.
- Live relay/signer credentials remain intentionally unconfigured and must produce blocked/unselected evidence in later certification work.

## Self-Check: PASSED

- All five owned implementation, fixture, and test files exist.
- Task commits `0e65bfe`, `c9a5d7c`, `cd998fa`, and `de099a3` exist.
