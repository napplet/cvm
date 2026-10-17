---
status: complete
description: Persist publication state and finish contextual publishing flow
---

# Publication tracking and final publishing step

Completed inline through the GSD quick workflow.

- Added signed-owner CVM publication lookup and signature saving before browser blob effects. File-copy results, relay confirmations, signed event, version, address and publication time survive reload and service restart. Re-preparing a signed artifact returns the existing publication.
- Added development migration 013, included in setup and readiness. Project projections count user publications made through a different signer without changing project ownership; newer verified versions expose unpublished changes. CVM previews remain excluded.
- Builder now shows Published / Continue publishing / Unpublished changes, offers the saved naddr, and restores the appropriate final step. Reloading from publishing returns to the saved builder instead of the homepage.
- Refined the final Publish step with responsive progress cards, destination receipts, recoverable failures and a completed-publication card. Project cards include the published version.
- Updated user and implementer docs, generated contract catalog, refreshed publication screenshots, and added a completed-publication screenshot. Documentation now has 13 user and 8 operator screenshots.

## Verification

- Real isolated static-origin → signed/encrypted CVM → PostgreSQL/worker/relay/Blossom browser journey passed. It covers failed copies before event publication; losing the browser journal and restoring the saved signature/failures; retry with exactly one applet signature; owner denial; tamper denial; exact event replay; repeat preparation; CVM restart; published project/builder; reopening the same address with no generation; and a second verified revision shown as unpublished changes. Two model-fixture invocations correspond exactly to the initial build and requested revision.
- Returning-projects real-service browser journey passed, including signed ownership, anonymous-then-signed-in visibility, fresh browser and service restart, and no inference on list/open.
- 12 targeted tests passed (10 publication/URL/TLS/adapter cases and 2 verified-project-identity cases; 77 assertions).
- Responsive workspace: 323 checks over 19 viewports, from 280px through desktop and short landscape. Includes publication preparation, review, failure and completion.
- Docs: build passed; 38 HTML pages and 1,300 local links/assets/fragments passed; generated catalog matches 16 tools. Browser check passed 90 layouts, 130 screenshot loads, full-size links, search, navigation, sidebar and deep reload.
- TypeScript 5.9.3 retains 424 existing diagnostics, with none reported in the changed publication/project modules or e2e test. Typecheck is not globally clean.
- `git diff --check` passed.

## Findings during verification

- Fixed Publish-step reload falling back to the homepage.
- The real NIP-46 test had a handshake race: `limit:0` subscriptions do not replay and the local relay does not send EOSE for them. A separate read barrier on the same test socket now waits for subscription readiness before delivering the fixture handshake. Product signer behavior was not changed.

## Local activation

Confirmed zero active generation actions, restarted only the local CVM, and ran the existing setup/readiness path. Migration 013 is installed. Workspace remains at http://127.0.0.1:49371, mode chatgpt-oauth, with the existing worker image. Verified the served bundle contains the updated publication controls. No live subscription generation or user publication was performed. Docs preview remains at http://127.0.0.1:4173/docs/.

Production remains deferred. Unrelated untracked research, design evidence, Playwright output and deno.lock were left untouched.
