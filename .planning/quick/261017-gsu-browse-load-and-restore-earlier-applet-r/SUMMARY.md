---
task: 261017-gsu
status: complete
---

# Saved revision browsing and restoration

Users can open Version history in the preview, view any verified build, and restore it as the saved current source. Return to current exits comparison without changing the project. Current is marked independently from the numerically newest build. Restoration keeps later versions, draft text, receipts, and cumulative spend, and makes no model request or charge.

## Implementation

- Strict `projects restore` arguments over the existing signed CVM protocol. Ownership comes from the verified request identity; foreign projects/artifacts are denied.
- A row lock shared with generation admission, expected-session-version check, and idempotency record fence stale and active commands. Immutable restoration audit records are separate from metered actions and ledger entries.
- Existing current verified artifact pointer becomes authoritative for status, provider input and worker lineage. A restore advances the concurrency version without fabricating a new artifact; the next generated version can skip a number. Its persisted parent points to the restored artifact, not the concurrency counter.
- Reload and fresh-browser/service restart recover current selection. Older publications remain unchanged until explicit publishing; latest publication ordering now uses publication time, allowing restored older builds to become the newest publication.
- Responsive history, restore and return controls; no empty history section during initial generation. User documentation and contract catalog updated, with a new screenshot and regenerated affected screenshots.

## Verification

- `returning-projects.e2e.ts`: passed on final code through real relay, PostgreSQL, Docker build/conformance and fixture model. Proves preview-only selection, saved restore, unchanged inference count/spend, owner isolation, foreign artifact denial, busy/stale guards, replay/conflict behavior, draft preservation, restart persistence, subsequent GUI revision using restored source, and correct persisted parent version.
- `static-cvm-publication.e2e.ts`: passed, including restoring and publishing version 1 after version 2, then observing correct latest publication and project state with no model request.
- Responsive browser checks: 437 checks across 19 viewports from 280px through 2560px, including history and restore actions.
- Targeted core tests: 23 tests / 98 assertions (revision, session status, continuation status, SQL funding). Final SQL lineage adjustment: 20 tests / 86 assertions rerun for the affected three files; real-service test also passed afterward.
- Owner identity/cost tests: 5 tests / 27 assertions.
- Documentation: 18 user-guide captures; build passed; 38 HTML pages and 1326 links/assets/fragments checked; browser checks passed across 90 layouts and 155 images. Contract catalog current (16 tools).
- TypeScript remains at the established 425 diagnostics, with no new normalized diagnostics. Global typecheck is not clean.
- Local app refreshed only after checking no active generation or publication. Ready at http://127.0.0.1:49371, saved chatgpt-oauth mode preserved. Served bundle contains new revision controls. Docs refreshed at http://127.0.0.1:4173/docs/users/create-and-revise.

## Limits

Restoration applies to retained verified builds with their saved source. Active/unresolved actions must be settled before switching the current source. This does not automatically change an already published event. Production rollout remains deferred per the user’s standing direction.
