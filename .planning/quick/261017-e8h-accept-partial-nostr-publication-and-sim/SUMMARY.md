---
id: 261017-e8h
status: complete
completed: 2026-10-17
---

# Partial Nostr delivery and clear publication success

Executed through gsd-quick inline.

## Changes

- Development publication succeeds when any selected relay confirms the signed event. Other relay failures remain receipts, not blockers. Zero confirmations remain retryable. The existing two complete verified Blossom copies policy stays in place.
- Submission and reconciliation use the same one-relay condition. Previously published attempts do not lose their confirmation because an optional relay is later unavailable.
- On startup and owner lookup/status, old unconfirmed records with positive selected-relay receipts and enough verified files are durably corrected to published. Superseded drafts and CVM previews are excluded. This uses stored evidence only, without upload, signing, generation or relay publication.
- Success is now a prominent Published heading, applet name, confirmed delivery counts, Copy naddr and Open applet. Address, destination receipts and advanced details are collapsed. Finished progress cards and duplicate paragraphs are hidden; normal text is 16–18px with larger headings and share action. Expanded receipts use separate Files/Relays columns and short statuses.
- Refreshed publication screenshots, user recovery instructions and implementer protocol behavior.

## Verification

- Real static CVM publication e2e passed: isolated SQL, relay, NIP-46, Docker build and Blossom services; external model fixture only. Includes actual one-good/one-failed relay success, old partial-success repair on lookup and restart, zero-confirmation retry, exact saved signature reuse, owner isolation, edits and two-copy threshold.
- 8 focused tests / 48 assertions passed, including TLS relay checks and destination/copy policies.
- 361 responsive checks passed across 19 viewports from 280px to 2560px, with collapsed success and expanded delivery details.
- 15 offline screenshot illustrations regenerated; success screenshot visually inspected. Docs build, 1,310 local links/assets, 90 browser layouts, 140 image checks, search/navigation/deep reload and generated-contract drift check passed.
- TypeScript 5.9.3: 424 existing diagnostics unchanged in signature; no new errors. Full repository type checking remains a known baseline limitation.
- git diff --check passed.

## Local activation

After confirming zero active generation and publication, restarted the CVM with saved chatgpt-oauth configuration and unchanged worker image. Read-only database check now shows the user's latest saved publication as published with three of four relays confirmed. No live model request, user signing, blob upload or relay publication was performed. Live served-bundle markers verified at http://127.0.0.1:49371; reload the workspace for the simplified UI. Docs preview restarted at http://127.0.0.1:4173/docs/.

Production remains deferred. Existing unrelated local files were preserved.
