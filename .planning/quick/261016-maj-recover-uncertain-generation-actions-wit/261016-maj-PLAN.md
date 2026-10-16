---
status: complete
---

# Recover interrupted development generation

GSD quick with validation, executed inline. User explicitly requires continued revisions without an operator and without silent token-wasting retries.

Evidence: the current version-5 session stopped with CHATGPT_RESPONSE_TOO_LARGE after 155599 ms and approximately 2 MB of SSE traffic. The stream-wide limit measures repeated delta envelopes, not generated source. No completed response or receipt exists for this operation. The gateway has finished and durably recorded usage_unknown; it is not running.

1. Bound individual SSE events, accumulated completed output, total traffic and time independently. Accept a valid small completed response after more than 2 MB of delta traffic. Preserve mandatory terminal completion/usage and source size gates.
2. Add development-only automatic recovery for conclusively ended ChatGPT requests with no recoverable source/receipt. Retain the immutable provider dispatch fence and original uncertain observation, explicitly waive the local test charge, release its action reservation, and preserve the verified version. Do not claim provider usage was zero. Do not resolve live requests or real API accounting this way. Never dispatch inference during status/recovery.
3. Recover old ended requests on authenticated status access and new interruptions on completion. Show plain actionable copy; preserve drafts and let a new explicit revision proceed. Cover replay, owner isolation, live-request exclusion, exact-once release and next revision with SQL/browser tests; run existing gateway/accounting checks. Restart only while idle, document and push.

The separate naddr remix/outbox browsing request remains active under quick task 261016-m8c.
