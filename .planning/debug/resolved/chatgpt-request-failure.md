---
status: resolved
trigger: "Revision unavailable: USAGE_UNKNOWN · CHATGPT_REQUEST_FAILED; how and why does this happen?"
created: 2026-10-16
updated: 2026-10-16
---

## Symptoms

Expected: An explicit revision completes or explains its actual failure and recovery path.
Actual: The workspace reports an unconfirmed provider outcome and advises signing in again.
Reproduction: User supplied screenshot after a revision in the local product workspace.
Related observation: No deployment control is visible.

## Current Focus

hypothesis: The two-minute local deadline interrupted a long revision; the timeout exception was flattened and mislabeled as an OAuth setup failure.
test: Compare durable dispatch/reconciliation timestamps; test timeout classification, persistence, browser feedback and replay fences.
expecting: New requests can complete beyond two minutes; failures preserve their actual classification and never trigger automatic inference retries.
next_action: None for the deadline/reporting fix. The historical revision remains usage_unknown; publication remains unavailable in the development UI.

## Evidence

- Selected gpt-6.1-sol account is currently signed in; sign-in failure is not established by this screenshot.
- Gateway catches arbitrary dispatch/stream/parser/persistence exceptions as CHATGPT_REQUEST_FAILED and records usage_unknown without error classification.
- UI fallback labels any unmapped diagnostic as setup failure and recommends Continue with ChatGPT.
- Local product and diagnostic console explicitly defer publication; no publication implementation is composed into this development server.
- Latest real start completed at 18:53:17Z; revision dispatched at 18:59:19.265Z and reconciliation line item committed at 19:01:19.281Z. Elapsed 120.015762 seconds matches the configured 120000 ms model deadline. Historical exception details were not retained, so attribution is a strong timing inference rather than a captured TimeoutError.
- The existing verified version remains; the failed revision has no confirmed receipt/settlement. No replay or mutation of its accounting was performed.
- Gateway/UI unit verification: 42 tests, 198 assertions passed. Browser bundle builds successfully.
- Timeout browser regression passed through real relay, Cashu and SQL: product/chat explanation, retained sign-in, private error redaction, persisted diagnostic, reload fence and SQL replay across gateway replacement without redispatch.
- Full product browser regression passed with fixture OAuth/inference and real local services, Docker build and Paja preview (five inference calls including intentional failure cases).
- Repository TypeScript baseline remains 426 diagnostics, with zero new normalized file/message diagnostics. No root dependency changes.
- Standard service restarted only after confirming zero active actions. Diagnostic migration applied, v2 profile has 300000 ms deadline, saved ChatGPT model/sign-in retained. No live model call or accounting mutation for the user's interrupted revision.

## Resolution

root_cause: Overly short local model deadline, generic exception sanitization and misleading OAuth fallback. Exact historical exception unavailable; durable timing strongly identifies the deadline.
fix: Five-minute versioned model profile, nine-minute browser action timeout, safe persisted failure classification, and visible product explanations. Preserve original usage-unknown fence and signed-in credentials.
verification: 42 unit tests; timeout browser/SQL regression; full product browser journey; browser bundle; no new TypeScript diagnostics; restarted local service health and saved sign-in verified.
