---
status: complete
task: 261015-o1z
date: 2026-10-15
commit: 1a850d5
remaining: None; live interactive verification completed by chatgpt-live-subscription debug follow-up
---

# Automatic ChatGPT activation and truthful stopped-request feedback

Implementation is complete. Successful sign-in automatically discovers models and activates the saved choice when available, otherwise the first available model. Account/model dropdown changes apply directly; the redundant activation button is removed. Explicit default-provider selection persists. Catalog failures retain sign-in, and an attempted model change during generation preserves the current model and request.

The user's screenshot was not an active background build: SQL showed zero active metered actions, and its recorded operation was usage_unknown with CHATGPT_STREAM_REQUIRED in the gateway. Live diagnostics confirmed HTTP 200 SSE without Content-Type. The parser now accepts absent metadata while retaining bounded SSE parsing, terminal completion/schema, model and usage checks. Explicit non-SSE types, JSON, partial streams and malformed receipts cannot claim success.

Three initial diagnostic requests were made using the app-owned selected account (no credential output). The first inspected headers only; the next inspected stream structure; the last confirmed error and response.failed events with subscription_sharing_usage_limit_exceeded. These were new diagnostics, not replays of the original uncertain operation. Live artifact verification was initially deferred; the follow-up below completed it after the user signed in again.

The GUI now distinguishes a returned uncertain server result from a relay timeout: the former says Generation stopped and explains provider uncertainty/no automatic retry; the latter retains the warning that work may still be running. Provider explanations appear in Live execution and the generation error as well as model settings.

## Verification

- 33 OAuth/gateway unit tests, 139 assertions passed: activation, reauthorization preference, retained login on discovery failure, headerless completion/error events, strict receipt validation and replay fences.
- Browser progress checks passed for stale connections, late/foreign events, stopped server response versus unanswered request, and provider error visibility.
- Final composed OAuth browser journey passed with headerless fixture inference and real relay, PostgreSQL, Docker build, Chromium conformance and Paja preview. Verified automatic sign-in activation, dropdown switching, explicit fixture persistence, rejected busy selection, three successful versions with exactly three requests/observations/debits, revision replay, restart, interactive counter, credential isolation and sign-out. Fourth request deliberately fails TypeScript verification; fifth returns a usage-limit error with accurate stopped-state feedback. No redispatch.
- git diff --check passed; package.json and bun.lock retain their original SHA-256 digests.
- Default service restarted at http://127.0.0.1:49371 in chatgpt-oauth mode, selected gpt-6.1-sol, existing sign-in retained. Production behavior unchanged.

## Completed live verification

After the user signed in again, real inference completed but exposed a stream assembly bug: source arrived in response.output_item.done events while the terminal output list was empty. The debug follow-up fixed that parser and passed the live browser smoke with gpt-6.1-sol: real source, isolated Docker build, verification, ledger settlement and interactive sandboxed preview. Clicking Add changed the count to 1. The provider reported 220 input and 705 output tokens. No original uncertain action was replayed.

The expanded suite passed 35 unit tests (148 assertions) and the composed browser journey with sparse terminal responses, revision replay/restart, failed-build feedback, usage-limit feedback and signed-out preflight rejection. Details: [resolved debug record](../../debug/resolved/chatgpt-live-subscription.md).
