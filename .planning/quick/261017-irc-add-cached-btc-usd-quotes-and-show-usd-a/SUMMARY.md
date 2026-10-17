---
task: 261017-irc
status: complete
---
# Sats and indicative USD in private admin

Added a free, unauthenticated Kraken BTC/USD ticker reader inside the CVM. The existing signed/encrypted `cvm_admin` tool exposes `exchange_rate` only to the operator. No new HTTP surface, browser exchange request, API key, dependency or migration. Reader coalesces concurrent requests, caches five minutes, limits responses to 16 KiB and requests to five seconds, backs off failures for one minute and expires last-known quotes after one hour.

Admin pricing rows, the example request, job totals, rows, details and ledger entries show both sats and approximate USD. Quote source, observation time and stale/unavailable states are visible. BigInt conversion preserves rational rates and handles sub-cent amounts. Refresh never changes saved rates, active edits or settlement; test-sat equivalents are explicitly illustrative and old jobs use the current quote, not a historical USD receipt.

Reviewed official OpenAI Models, Pricing and Costs documentation: no documented model list-price API found; Models is metadata and Costs is incurred spend. Added this distinction to the operator guide, documented the CVM quote response and regenerated the downloadable schema catalog and affected screenshots.

## Verification

- Eight unit/operator tests, 94 assertions passed: conversion, large integers, sub-cent/rational display, coalescing/cache, invalid/oversized responses, stale expiry/backoff, actual five-second timeout and authorization.
- Rate editor browser test passed: live quote refresh during unsaved edit and after save, stale/unavailable states, exact save payload, validation and four responsive widths.
- Eleven operator screenshot captures passed with read-only fixture CVM calls; job totals/rows/details USD assertions, search/pagination/error behavior and responsive layouts passed.
- Docs built; 38 pages and 1,331 links/assets/fragments checked. Live guide passed three widths and screenshot-dimension validation. Contract catalog verified.
- Typecheck has zero added normalized diagnostics versus the existing 411-diagnostic baseline; full typecheck remains non-clean.
- Live CVM refreshed after generation and publication were confirmed idle. Real signed `exchange_rate` request returned fresh Kraken BTC/USD. Browser confirmed USD output, zero exchange HTTP requests, unchanged saved rates and three responsive widths; no page errors.
- No model request, live rate mutation, ledger settlement change or publication was performed.

Local admin: http://127.0.0.1:49371/admin (CVM PID 84393, saved ChatGPT OAuth retained).
Guide: http://127.0.0.1:4173/docs/operators/providers.

Sources: https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/reference/resources/models/methods/list ; https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs ; https://docs.kraken.com/api-reference/market-data/get-ticker-information ; https://support.kraken.com/articles/360000919986-public-endpoint-examples-you-can-try-them-directly-in-a-web-browser-
