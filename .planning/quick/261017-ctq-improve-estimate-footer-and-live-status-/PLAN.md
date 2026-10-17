---
id: 261017-ctq
status: complete
---

Polish GUI estimates and move detailed build status into the empty preview pane.

1. Replace the bulky revision estimate card with a compact, aligned footer. Format ranges with shared units and prevent orphaned units; keep sample provenance and maximum available without dominating the chat.
2. Render the real current stage, activity, elapsed time and remaining-time estimate prominently inside the empty preview. Preserve the top stage progress bar and existing verified previews during revisions. Handle waiting, stale, failed and recovery states honestly with reduced-motion support.
3. Publishing: require complete, hash-verified copies on two distinct Blossom servers, allow additional destination failures as warnings, and persist/report the actual verified server count. Keep the same signed manifest on retry. Show the current destination/operation and explain insufficient copies. Enforce the receipt threshold in the CVM submit path as well as the browser; CVM previews retain their own single-server flow.
4. Verify presentation states with the controlled browser clock and responsive suite, plus real publication failure/retry coverage; refresh illustrated user docs. Safely activate the service, record evidence and commit/push main.

No CVM estimation/accounting or model behavior changes. Follow gsd-quick inline.

Observed saved attempt: nostr.download and cdn.hzrd149.com verified index.html; blssm.us declined upload with HTTP 401. Relays were not attempted. User explicitly requested that two verified destinations suffice despite an additional failure.
