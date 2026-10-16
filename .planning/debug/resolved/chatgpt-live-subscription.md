---
status: resolved
trigger: "Ok. Well I wanted active generation actions. Fix it."
created: 2026-10-16T00:38:00Z
updated: 2026-10-16T00:57:00Z
---

## Symptoms

Expected: Real generation using the user's ChatGPT subscription, with live GUI progress through a verified interactive preview.
Actual: Sign-in/model catalog succeed; inference stops. The user reports the supplied usage link shows credit/API data rather than subscription settings.
Errors: Prior live SSE reported subscription_sharing_usage_limit_exceeded; original operation remains usage_unknown and must not be redispatched.
Timeline: Initially no completed live artifact; resolved after subscription stream assembly fix and a passing real interactive preview test.
Reproduction: Select the signed-in ChatGPT account/model, fund local test sats, submit Generate.

## Current Focus

hypothesis: Confirmed: the parser discarded completed message events because it used only the empty terminal output list.
test: Sparse terminal regression tests, composed OAuth browser journey, and a real subscription generation through an interactive preview.
expecting: Achieved: completed source reaches the isolated worker and verified preview.
next_action: None for this bug. Production certification remains independently deferred.

## Evidence

- Official Errors and recovery: this code can represent an app-specific cap; it does not prove the whole plan is exhausted. Do not switch billing paths or loop through OAuth.
- Installed gateway uses the app-owned OAuth bearer with resource.invoke and chatgpt.tokens.use.direct, public /v1/responses, stream:true and store:false. API keys are separate.
- Browser automation cannot inspect signed-in ChatGPT settings: its separate profile receives an HTTP 403 challenge. Do not bypass it.
- The usage link matches the URL in official SIWC docs/devkit. Kept it and added explicit account-menu/App limits navigation; removed misleading test-credits terminology.
- A live GUI attempt during reauthorization failed before dispatch because the saved account had no tokens. Added a client-side fresh sign-in check before admission/funds reservation. Fixture browser journey passes, including signed-out rejection without admission or model request.
- User then completed sign-in with a new app registration. Cache-busted local status confirms selected, signed-in, plan-enabled account. The user's new real generation streamed a completed response: 211 input / 398 output tokens; gateway returned CHATGPT_SOURCE_INVALID. Subscription inference now works. The old usage-limit condition is no longer the immediate blocker.
- Private diagnostic capture showed valid JSON source files in response.output_item.done message events and output:[] in response.completed. The assistant source had both allowed paths; no schema/prompt change was necessary.
- Parser now retains validated completed items by output_index and assembles them only after a valid terminal completion. Terminal response identity, usage and model checks remain. Conflicting duplicate items, interrupted streams and partial deltas cannot claim success; complete terminal output remains authoritative.
- OAuth/gateway unit suite: 35 pass, 0 fail, 148 assertions. Composed browser regression passed with headerless sparse-terminal fixture responses, three successful requests/observations/debits, revision replay/restart, intentional TypeScript failure, usage-limit feedback, and signed-out rejection before admission.
- Live browser smoke passed against the restarted standard service using the user's saved gpt-6.1-sol subscription selection. Real source completed Docker build/verification, ledger settlement and sandboxed preview; clicking Add produced visible count 1. No automatic retries or API-key billing fallback.

## Resolution

root_cause: Subscription SSE completed output items were discarded when the terminal response output list was empty.
fix: Assemble validated output_item.done events at terminal completion; retain receipt/replay validation. Clarify subscription/local-test-sats language and reject signed-out new actions before admission.
verification: 35 unit tests, composed OAuth/real-worker browser journey, and one successful live subscription generation with interactive counter assertion.
