---
status: resolved
trigger: "ChatGPT setup could not complete (CHATGPT_RESPONSE_TOO_LARGE). I can sign in, but I cannot reload the models."
created: 2026-10-15
updated: 2026-10-15
---

## Symptoms

expected: Signed-in users can reload their account's available models.
actual: Reload models returns CHATGPT_RESPONSE_TOO_LARGE after successful sign-in.
reproduction: POST the running local service's /dev/chatgpt/models control with the existing signed-in account.
started: First live use of the newly implemented OAuth integration.

## Current Focus

hypothesis: Confirmed: the shared 256,000-byte token-response limit rejects the verbose live model catalog.
test: Regression failed before the fix; all 26 OAuth/gateway tests pass. Real endpoint and Chromium reload both return seven models after restart.
next_action: Complete; user refreshes the open GUI tab to use the restarted service.

## Evidence

- The live account is signed in and plan-enabled. The local models control returns HTTP 400 with CHATGPT_RESPONSE_TOO_LARGE. No credentials or account identifiers were printed.
- ChatGptOAuth.models calls boundedJson(response) with its default 256,000-byte limit before selecting model slug/display name.
- Graph search returned no matching nodes for the new OAuth code; inspected the known implementation directly.
- New regression: a 680 KB catalog returns HTTP 400 before the fix. Token response limit regression already passes and must remain unchanged.
- Fix: only model catalogs receive a 4 MB allowance; over-limit catalogs cancel the reader and emit a model-specific error. The GUI explains that sign-in is still valid instead of asking for another login.

## Resolution

root_cause: Model discovery reused the 256 KB OAuth credential-response limit, but the live catalog includes more metadata than the tiny fixture.
fix: A bounded 4 MB allowance applies only to catalogs, plus a model-specific error and appropriate UI recovery guidance.
verification: Red/green regressions, full 26-test OAuth/gateway suite (106 assertions), actual account catalog request, and actual browser Reload models all pass. Seven real models loaded and reloaded with zero page errors. No generation was requested.
files_changed: src/dev/chatgpt-oauth.ts; src/dev-ui/browser/chatgpt-settings.ts; tests/dev/chatgpt-oauth.test.ts; development runbook and GSD records.

Logs: `.local/chatgpt-catalog-red.log`, `.local/chatgpt-catalog-green.log`, `.local/chatgpt-catalog-live-browser.log`. Launcher reports ready at http://127.0.0.1:49371; restart preserved the real account. No state reset or production change occurred.
