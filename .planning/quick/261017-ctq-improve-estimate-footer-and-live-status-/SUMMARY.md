---
id: 261017-ctq
status: complete
---

# Estimate footer, preview status and resilient publishing

The revision composer now has a compact cost/time footer with shared time units (for example, 1.5–3 min), a separate maximum and expandable history explanation. The empty preview shows the actual stage, operation, elapsed time, historical remaining-time range and cost with a quiet geometric loader. Stale, failed and recovery states stop the animation; reduced motion is honored. The top stage strip stays in place, and verified previews remain available during revisions.

Publishing now requires complete verified copies on two distinct Blossom origins. Additional destination failures remain warnings and do not prevent relay publication. Per-file successes or duplicate URLs cannot inflate the count. The client still reads and hashes destination bytes; the CVM enforces the corresponding durable receipt threshold before submission, without adding server-side fetches of user destinations. This is a development publication policy, not an independently attested storage-availability guarantee. CVM-owned previews keep their existing single-server path. New user publications require two to five destinations; existing published records remain readable.

The publishing flow names the current destination and operation, keeps failed destinations visible after success, counts only verified complete servers, and restores the same signature and warnings from CVM records. Signed manifests and their destination tags are not changed to hide failures. Failed copy attempts can be retried without model generation or a new applet signature.

## Evidence

- Reported real attempt: nostr.download and cdn.hzrd149.com verified index.html; blssm.us declined upload with HTTP 401. The old all-destinations condition stopped relay submission. No automatic signing or publication of the user's saved event was performed.
- 7 focused tests / 38 assertions passed, including complete-copy counting, split-file and duplicate rejection, URL normalization and latest-receipt semantics.
- Controlled-clock product view passed: empty preview status/estimates, stale pause, recovery, restored verified preview, compact estimate placement, touch targets and reduced motion.
- Full static-origin publication e2e passed using real local SQL, Nostr relay, NIP-46 signer, isolated worker and two Blossom stores plus a third destination returning HTTP 401. One verified server blocked browser/CVM submission; retry with two verified servers published the same event. Warnings/counts survived reload and CVM restart; no duplicate model call/signature/publication was created. External model only was a fixture.
- Responsive suite: 323 layout checks at 19 viewport sizes, including 280px wide and short landscape, passed.
- User screenshot capture: 14 illustrations. Added preview-status image and refreshed estimate/publication screenshots. Visually inspected preview, composer and partial-success publication.
- Docs build and 1,306 links/assets/fragments passed; browser checks passed 90 layouts, 135 image renders, both image catalogs, search, navigation, sidebar and deep reload.
- TypeScript 5.9.3: 424 existing diagnostics, unchanged in kind from baseline; no new diagnostics. The unpinned global tsc was 7.0.2; final comparison used 5.9.3 explicitly.
- git diff --check passed.

## Activation

Checked zero active generation and publication jobs, then restarted the local service. http://127.0.0.1:49371 is ready (PID 56869), preserves chatgpt-oauth and the existing pinned worker image. Served bundle includes the new status and publication UI; health is 200. Docs are refreshed at http://127.0.0.1:4173/docs/.

Refresh the workspace and use Retry remaining steps on the saved publication. Existing verified copies are checked/reused, and the extra failed server no longer blocks once two complete copies are verified. Relays still require their existing confirmation policy. No live subscription generation was used for verification. Production remains deferred.
