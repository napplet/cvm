# Publication metadata and recovery

Completed 2026-10-17 through gsd-quick inline.

## Delivered

- Owner-authorized `development_publication.metadata` returns title/description suggestions from hash-bound verified manifest metadata, with bounded saved-project fallback for older generic builds. No model call, public HTTP API, or provider-account exposure.
- Editable title and description are shown in review, prepared through the existing CLI contract, signed and persisted. Missing descriptions in older editable drafts can receive CVM suggestions without overwriting input.
- Advanced applet details exposes required/optional declarations and read-only manifest/file data. Older builds explicitly say optional capabilities are not declared; this is a pinned-toolchain limitation, not proof that no optional calls exist.
- Saved complete copies on two distinct origins enable **Continue publishing with 2 verified copies**. This sends the saved event to relays without re-uploading or signing again. Extra server failures remain warnings.
- **Edit details and destinations** creates an unsigned replacement for an unfinished signed draft. The owner re-signs; retained destinations keep their receipts. Prior signed envelopes are retained and superseded submissions/saves are rejected. Conditional replacement and submission claims prevent replacing an actively sending draft.
- Updated user and implementer docs, generated contract catalog and publication screenshots; added advanced-details screenshot.

## Verification

- 11 focused tests / 47 assertions passed: suggestions, capability declarations, owner schema, copy counting and destination policies.
- Full static CVM publication e2e passed through isolated real SQL, relay, NIP-46, Blossom and Docker worker with a model fixture. Covers metadata ownership, signed description, 1-copy refusal, 2-copy + HTTP 401 success, saved-copy continuation with no new upload/signature, owner-only replacement, prior signature history, stale submission rejection and successful edited destination recovery. Exactly two fixture generation calls across initial build/revision; no extra generation for publishing.
- 342 responsive checks passed across 19 sizes (280 px through 2560 px, including short landscape); includes advanced manifest and legacy missing-description edit.
- Documentation: 15 offline user screenshots, build, 1,310 links/assets, 90 browser layouts, 140 image checks, search/navigation/deep reload passed. Initial browser check found the old preview process caching removed asset names; restarting that exact process resolved it.
- TypeScript 5.9.3: 424 baseline diagnostics remain, no added diagnostic signatures. Repository-wide type checking is not clean; this pre-existing limit remains flagged.
- `git diff --check` and generated-contract checks passed.

## Activation

Confirmed zero active generation/publication operations before restarting only the local CVM. http://127.0.0.1:49371 is ready with chatgpt-oauth preserved and unchanged pinned worker image. Read-only served-bundle checks confirm new recovery/metadata UI. Refresh an already-open browser tab to load it. Docs preview at http://127.0.0.1:4173/docs/ was restarted after build.

No live user generation, signing, upload or publication was performed during this task. Production gates remain deferred.
