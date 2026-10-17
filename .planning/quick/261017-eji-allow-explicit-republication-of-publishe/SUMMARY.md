---
id: 261017-eji
status: complete
completed: 2026-10-17
---

# Explicit applet republication

Executed through gsd-quick inline.

- Added Republish beside View publication in the builder and in the publication result. The action shows Republishing progress and confirmed-relay feedback, with controls disabled while active.
- New owner-authorized development_publication republish command resends the saved signed event to saved relays. No caller-supplied event or destination override is accepted. Preview/unfinished records are rejected.
- Relay worker has an explicit always-send mode. Ordinary submit/retry behavior still observes before deciding to send; explicit republish sends even if the event already exists.
- The event ID, naddr, signature, uploaded files, publication record and original publication timestamp remain unchanged. A failed resend cannot revoke published status or previous positive receipts. Last attempted time and results are retained under republication and restored through CVM lookup/status.
- Updated user/implementer documentation, generated contract and completion screenshot.

## Verification

- Full static CVM publication e2e passed with isolated real relay, SQL, Docker worker, Blossom stores and NIP-46 plus model fixture. Both Republish buttons work; ownership and unfinished-state refusals, unchanged address/event, no duplicate records, no extra inference/upload/signature, saved last results and failed-resend preservation are covered.
- Relay TLS/socket test passed: 18 assertions including observing an actual EVENT resend for an already-stored event; ordinary retry does not resend. DNS pinning, hostname checks and redirect refusal remain covered.
- 380 responsive checks across 19 sizes passed, including published builder actions and publication result/delivery details down to 280px.
- 15 offline screenshots captured; completion image visually checked. Docs build, 1,310 links/assets, 90 browser layouts, 140 image checks, search/navigation/deep reload and generated-contract drift checks passed.
- TypeScript 5.9.3 has the same 424 baseline diagnostics; no new diagnostic signatures. Full repository type checking remains a pre-existing limitation.
- git diff --check passed.

## Activation

Confirmed zero active generation/publication operations before restarting the exact local CVM process. Saved chatgpt-oauth configuration and worker image are preserved. Read-only served-bundle checks confirm both Republish controls. Local preview: http://127.0.0.1:49371; docs: http://127.0.0.1:4173/docs/.

No live user republication, signing, model call or blob upload was performed by the agent. Production remains deferred. Unrelated local files preserved.
