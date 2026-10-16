---
status: passed
---

# Verification

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Warm light guided creation with one decision at a time | PASS | Product browser journey; 390/768/1440 screenshots visually inspected |
| Saved sign-in and drafts survive OAuth/reload | PASS | Fixture OAuth round trip, setup draft restoration, revision draft/conversation restoration; real running service retains ChatGPT/gpt-6.1-sol |
| Top progress is real, granular details accessible | PASS | Model-stream gate before completion; controlled-clock stale/recovery test; no time-driven progress; signed request correlation tests |
| Preview and revision chat work together | PASS | Interactive nested counter, new immutable versions, historical preview selection, latest-version edit guard, preserved preview on failure |
| In-flight reload cannot dispatch a duplicate paid request | PASS | Reload while first inference is gated, explicit exact-request recovery; one inference; SQL counts remain exact |
| Failed build can be followed by another explicit revision | PASS | Real SQL/Docker failure then successful version 3; unit tests verify preserved artifact and exact replay |
| Unknown usage remains blocked, including reload | PASS | Terminal usage-limit fixture; no automatic retry, revision disabled, saved session notice, progress does not claim completion |
| Original console still works | PASS | OAuth console journey: generation, revisions, replay, server restart, failures, usage uncertainty and logout |
| Boundaries and accessibility retained | PASS | Console security/accessibility journey: opaque allow-scripts frame, no private key leakage, forbidden fetch/storage blocked, no public HTTP generation routes; product text-only rendering, focus, dialog Escape, 44px targets, reduced motion and width checks |
| Future brand/package scope documented | PASS | README and development GUI runbook; no production deployment or package publication performed |

## Executed checks

- `bun tests/dev-ui/product-workspace.e2e.ts`: PASS. Fixture OAuth/inference with real local services. Five inference calls: creation, revision, intentional validation failure, explicit recovery revision, terminal usage-unknown fixture. Four settled requests produced four owner debits; uncertainty retained its fence.
- `bun tests/dev-ui/product-view.e2e.ts`: PASS. Unsafe-text rendering, auth-error settings visibility, budget validation/focus, explicit fixture mode, stale clock, stage-driven progress, uncertain recovery, responsive touch targets, reduced motion, modal focus.
- `bun tests/dev-ui/chatgpt-oauth.e2e.ts`: PASS. Original console compatibility, including replay and restart.
- `bun tests/dev-ui/security-accessibility.e2e.ts --case=security-accessibility`: PASS. No canary requests, no authority leakage; responsive console preserved.
- `bun tests/dev-ui/progress-view.e2e.ts`: PASS. Existing progress behavior and diagnostics retained.
- `bun test tests/dev-ui/development-progress.test.ts`: **6 passed, 72 assertions**.
- `bun test tests/phase-04 tests/continuity`: **19 passed, 103 assertions** (five matching Phase 4 test files).
- All 26 test files importing `TransactionalMemoryFundingStore`, run in separate Bun processes with `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny`: **164 passed, 866 assertions**. Initial combined runs surfaced test scheduling races under workstation load; the capacity-entry barrier/watchdog was corrected, and the final isolated runs all passed.
- `bunx --no-install tsc --noEmit`: current and isolated pre-change HEAD both report **426 existing errors**, **zero new normalized diagnostics**. This is a baseline comparison, not a green global typecheck.
- Browser bundle built successfully; `git diff --check` clean. Root package.json and bun.lock SHA-256 values unchanged.
- Final launcher readiness: local service on port 49371, `chatgpt-oauth`, original worker image digest unchanged. Redacted status confirms account signed in and model `gpt-6.1-sol`; latest product bundle and `/dev` both served.

## Local evidence

Screenshots: `.local/development-gui-evidence/applet-{idea,setup,workspace}-{390,768,1440}.png`, plus generating/failure screenshots and the final running-service setup screenshot. Automated-test screenshots deliberately show a fixture applet inside the real sandbox.

Logs: `/tmp/applet-broker-product-e2e.log`, `/tmp/applet-broker-product-view.log`, `/tmp/applet-broker-console-e2e.log`, `/tmp/applet-broker-security-e2e.log`, `/tmp/applet-broker-store-tests.log`, and the baseline/current TypeScript logs. These local paths are ephemeral evidence, not published build artifacts.
