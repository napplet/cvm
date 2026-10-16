---
status: incomplete
task: 261015-o1z
date: 2026-10-15
commit: 1a850d5
remaining: Live generation to verified artifact blocked by ChatGPT account/app usage limit
---

# Automatic ChatGPT activation and truthful stopped-request feedback

Implementation is complete. Successful sign-in automatically discovers models and activates the saved choice when available, otherwise the first available model. Account/model dropdown changes apply directly; the redundant activation button is removed. Explicit default-provider selection persists. Catalog failures retain sign-in, and an attempted model change during generation preserves the current model and request.

The user's screenshot was not an active background build: SQL showed zero active metered actions, and its recorded operation was usage_unknown with CHATGPT_STREAM_REQUIRED in the gateway. Live diagnostics confirmed HTTP 200 SSE without Content-Type. The parser now accepts absent metadata while retaining bounded SSE parsing, terminal completion/schema, model and usage checks. Explicit non-SSE types, JSON, partial streams and malformed receipts cannot claim success.

Three short diagnostic requests were made using the app-owned selected account (no credential output). The first inspected headers only; the next inspected stream structure; the last confirmed error and response.failed events with subscription_sharing_usage_limit_exceeded. These were new diagnostics, not replays of the original uncertain operation. No successful live generated artifact is claimed. Further inference is deferred until the account/app usage limit changes.

The GUI now distinguishes a returned uncertain server result from a relay timeout: the former says Generation stopped and explains provider uncertainty/no automatic retry; the latter retains the warning that work may still be running. Provider explanations appear in Live execution and the generation error as well as model settings.

## Verification

- 33 OAuth/gateway unit tests, 139 assertions passed: activation, reauthorization preference, retained login on discovery failure, headerless completion/error events, strict receipt validation and replay fences.
- Browser progress checks passed for stale connections, late/foreign events, stopped server response versus unanswered request, and provider error visibility.
- Final composed OAuth browser journey passed with headerless fixture inference and real relay, PostgreSQL, Docker build, Chromium conformance and Paja preview. Verified automatic sign-in activation, dropdown switching, explicit fixture persistence, rejected busy selection, three successful versions with exactly three requests/observations/debits, revision replay, restart, interactive counter, credential isolation and sign-out. Fourth request deliberately fails TypeScript verification; fifth returns a usage-limit error with accurate stopped-state feedback. No redispatch.
- git diff --check passed; package.json and bun.lock retain their original SHA-256 digests.
- Default service restarted at http://127.0.0.1:49371 in chatgpt-oauth mode, selected gpt-6.1-sol, existing sign-in retained. Production behavior unchanged.

## Remaining live verification

Open Manage usage to inspect ChatGPT plan/app limits. After allowance is available, run the explicitly opted-in chatgpt-live browser smoke (a new request) and verify the generated preview. Do not redispatch the original uncertain action. Fixture success demonstrates the local path but does not certify a completed live ChatGPT generation.
