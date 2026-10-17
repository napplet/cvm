# Publication metadata, capabilities and editing

Completed 2026-10-17 through gsd-quick, inline.

- New model responses include bounded, data-only `src/capabilities.json`. Both model routes, immutable proposal storage, prior-source revision loading and the isolated worker preserve it. Required domains enter the pinned build configuration; both lists enter standard artifact HTML metadata. No executable generated configuration is accepted.
- Publication loads owner/action-bound, hash-verified declarations and uses the unmodified pinned CLI 0.10.0 current-format template helper. Actual user/CVM events have distinct R/O tags, the verified index.html hash and description content. Older signed events remain immutable; missing historical optional declarations are disclosed, not guessed.
- Hashtag chips support normalization, validation, deduplication, ten topics, pending input on Review, and signed t tags on both applet and application listing.
- View publication → Edit publication opens title, description, hashtags and destinations. A replacement uses fresh signatures and a newer timestamp at the same address, retains previous published history and reusable copy receipts, and uses no model call. Republish still reuses original signatures.
- Corrected upstream optional-declaration guidance in https://github.com/napplet/web/pull/254 (open, not merged). Installed six skills using pinned `npx skills add` at a958687c5a93449c950ef32cdf169ad100c9ed63. Worker readiness binds the new parser, runner and skill hashes.
- Updated illustrated user guide, current contract catalog and operator runbook. Added an edit-publication screenshot and refreshed four publishing screenshots.

## Verification

- Full local browser/service journey passed: signed/encrypted CVM, SQL, relay, OAuth fixture, real NIP-46, isolated worker and Chromium, capability HTML and signed R/O, hashtags on both events, two-server/one-relay threshold, ownership/tamper rejection, retries, restart, revision, published metadata update, same address, new signatures, no extra generation, and reload persistence.
- 40 targeted tests / 226 assertions passed. Responsive browser: 399 view/viewport checks, including 280px and ten long hashtags. The first run exposed wrapping in review chips; corrected and rerun green.
- Docs build, link check, contract freshness and browser layout/image/navigation checks passed. Screenshots use labeled offline fixtures without user credentials.
- TypeScript retains 424 pre-existing diagnostics; normalized comparison shows no new diagnostics. Vendored CLI source hashes all verified.
- Upstream skills: build, type-check, recursive unit suite and 11 skills contracts passed. AI-slop 98/100, zero errors, one external dependency advisory; above CI threshold 70.
- Local service restarted only after confirming zero active model actions and publishing attempts. http://127.0.0.1:49371 is ready with saved chatgpt-oauth configuration; docs at http://127.0.0.1:4173/docs/. No live user signing, model calls or public user publications were performed.

The composed test caught a prior-source allowlist that rejected the new metadata file during revision. The server-side restore path was corrected; the complete journey then passed. Production verification remains deferred.
