---
id: 261017-gev
status: complete
---

# Request costs and project spending

Added signed, owner-scoped `projects costs` reads with stable paging and cumulative committed session spend. Project cards return the same spend summary. Every request is shown with its outcome and actual charge; optional details show token categories, pinned rational rates, integer-rounded charges, and the approved maximum. Totals appear above the builder/publication workspace, in the conversation, and in Your applets.

The total includes charged failures and all pages, and excludes explicitly pending charges. A confirmed zero is distinct from unknown. Read/replay never creates another debit. Prompt text is saved at the authorized provider-dispatch boundary (including resumed work), so conflicting replays cannot overwrite it. Migration 014 is additive and applies automatically through the development launcher. Older prompts and unavailable token breakdowns are labelled unavailable; actual recorded charges remain visible.

Public data travels exclusively through signed CVM. No provider account identifiers, credentials, raw responses, or protected evidence references are exposed. Costs use development test sats, not subscription billing amounts. The existing rough cost/time estimates remain separate.

Validation:

- 8 focused tests / 36 assertions: pinned rounding, large integers, breakdown mismatch, zero versus null, ownership/schema and canonical price-card checks.
- Real returning-projects e2e with relay, SQL, Cashu, Docker workers and deterministic subscription protocol fixture: active costs, owner denial, actual creation/revision costs, pagination, idempotent replay, paid build failure, interrupted confirmed-zero result, fresh browser/CVM restart, and no inference on reads.
- 418 responsive layout checks over 19 viewport sizes, down to 280px, including expanded cost details, large amounts, pending charges and project cards; long conversation pending-message regression included.
- 17 screenshot captures, user cost guide and implementer/tool schema updates. Docs build, generated contract check, 1,320 links, 90 browser layouts and 150 screenshot checks passed.
- TypeScript: 425 diagnostics in both the current tree and a clean HEAD archive under the same installed compiler; no added diagnostics. Repository-wide typechecking remains blocked by existing errors.
- Live service restarted with saved OAuth intact at http://127.0.0.1:49371. Signed cost-tool smoke passed. Existing local session totals match summed committed action charges (zero mismatches). Illustrated docs preview at http://127.0.0.1:4173/docs/users/costs-and-limits.

No live model request or user publication was made. Production deployment remains deferred as previously requested.
