---
task: 261017-gsu
status: complete
---

# Browse and restore previous revisions

Allow the owner to load any verified revision, compare it in the live preview, and restore it as the saved source for subsequent edits. Restoring preserves later versions, publication records, and all costs, and makes no model request.

1. Add an authenticated, idempotent CVM restore command. Lock the session, reject stale/busy or foreign requests, advance its concurrency version, and save the selected verified artifact pointer plus a restoration audit record. Generation and session status must use that pointer.
2. Add integrated revision history, clear Current/Viewing labels, a Restore this version action, and Return to current. Keep browsing available without accidentally changing the saved current version. After restore, the composer edits that source; reload recovers the selection. Show no-charge guidance and preserve draft text.
3. Verify signed-owner isolation, stale commands, retry idempotence, no added spend/provider calls, durable reload, and next generation using restored source. Cover responsive history controls and document the workflow with a screenshot.

Run targeted real-service/browser checks, compare TypeScript diagnostics with the existing baseline, update GSD state, refresh idle local preview, and commit/push to main under standing authorization.
