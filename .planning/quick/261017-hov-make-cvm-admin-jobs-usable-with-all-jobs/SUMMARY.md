---
task: 261017-hov
status: complete
---

# Usable operator jobs and preserved usage evidence

Jobs are now the first admin surface, with All selected, counted filters, search, pagination, readable request summaries, status badges, confirmed charges and outstanding reservations. Billing uncertainty is separated into Needs review. Details show the prompt, costs, token usage and worker results, with identifiers/ledger collapsed. Provider configuration remains private and remembers its expanded state through OAuth. Responsive cards replace the table on small screens.

## Accounting

- Added append-only development_usage_evidence migration 016. Valid correlated receipts are recorded before source parsing/persistence and deduplicated by operation and provider receipt identity.
- ChatGPT and configured API gateways preserve known usage through malformed generated JSON, source validation/storage errors and completion-record failures. Receipt-only replay never redispatches inference. Conflicting evidence stays unresolved.
- Operator-only check_receipt settles saved matching evidence exactly once with the action’s original pinned profile/card. It cannot redispatch, invent usage, or release missing/conflicting evidence. Missing receipts remain reserved. Development interruption waiver excludes journaled receipts.
- Inspected two historical subscription actions from the screenshot: each lacks saved provider usage and retains 395 test sats. They remain Needs review with 790 test sats reserved; no historical charge was invented or waived. Their exact upstream usage cannot be reconstructed from retained evidence.
- Existing development-only interrupted-subscription waiver remains explicitly labelled Operator absorbed, separate from confirmed provider usage. Production reconciliation remains deferred; this is not a guarantee that every remote provider delivers a recoverable receipt.

## Verification

- Gateway/operator units: 27 passed, 159 assertions. Covers authorization, lost-stream fences, preserved receipt before source failure, crash/restart recovery and conflicting evidence.
- SQL proposal/provider integration: 4 passed, 47 assertions. Includes malformed API output retaining usage, replay without a second provider request, owner binding, receipt uniqueness and append-only protection.
- interrupted-generation.e2e.ts: passed through real PostgreSQL; concurrent recovery debits exactly three sats once, retains missing-receipt reservations, preserves development waiver boundaries and exercises All/search/review/detail queries.
- static-cvm-publication.e2e.ts: passed through real relay, SQL, isolated worker and browser with fixture provider. Private admin OAuth, price versions, active/pending/finished details, static-origin publication and revision restoration preserved. A fixture HTTP timeout warning occurred but the complete journey passed.
- Browser screenshot/interaction checks: 11 operator captures; default All, search/no results, pagination, failed-refresh usability, mobile cards/details at 320/375/768/1280px; no browser errors or horizontal overflow.
- Docs build, link/fragment checks (38 HTML pages, 1329 links/assets/fragments) and generated contract verification (16 tools) passed. Operator guide/screenshots updated.
- Docs browser checks: 90 layouts and 165 screenshot loads passed, plus search/navigation/deep reload and full-size images.
- Typecheck: 411 existing diagnostics versus 425 baseline; no added normalized diagnostics. Global typecheck is still not clean.
- Live read/check: 43 jobs, 344 test sats charged, 790 test sats reserved for two historical missing receipts. Authenticated receipt check retained those funds and started no model request. Zero browser errors.
- Local CVM refreshed only while generation/publication were idle, preserving saved ChatGPT OAuth mode. App/admin: http://127.0.0.1:49371; illustrated operations guide: http://127.0.0.1:4173/docs/operators/operations.
