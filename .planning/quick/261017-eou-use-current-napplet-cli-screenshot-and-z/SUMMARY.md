---
status: complete
---
# Screenshot and Zapstore publication

Publication tooling now uses official CLI 0.10.0, pinned to source 67d0e814100b9b54654168e525bfef74eff08c04 and the Linux ARM64 release SHA-256. A separate image prewarms private Node/Paja/Chromium during development setup. Generation's existing sealed worker remains unchanged.

- Isolated offline CLI screenshot captures verified bytes, including previously generated artifacts; retains a 1200×750 PNG and checks the CLI --zapstore dry-run output. Uses the standalone screenshot command, the same capture engine as --screenshot, because the inline flag deletes temporary PNGs before client signing/mirroring.
- Artifact-bound screenshot cache validates hashes/no-follow reads and is reused across edits/retries. Container has no keys/network, read-only root/cache, dropped capabilities, resource limits, an 85-second in-container timeout and a 90-second host deadline.
- Final application metadata comes from the unchanged upstream CLI implementation. User signs both applet and kind-32267 listing in the client. Both signatures and separate delivery receipts persist. Browser mirrors screenshot with the applet; two complete servers suffice. CVM sends listing before applet; one applet relay confirmation suffices independently of listing delivery. Republish reuses both signatures.
- Review includes screenshot and two-signature explanation; result reports listing status, with per-relay details collapsed. NIP-46 permission requests include kind 32267. Docs and exported contract refreshed.

## Verification

- Real CLI screenshot plus --zapstore dry run passed in the offline restricted Docker image, including the final timeout entrypoint.
- Full static-CVM publication journey assertions passed: real SQL/relay/NIP-46/Docker, screenshot loaded at 1200×750, correct kind-32267 event and naddr, hash-verified PNG on two destinations, extra 401/relay failure, both saved signatures, retry/republication/restart, tampered/missing listing signatures rejected, old envelopes retained. Test's services/containers/sockets were torn down; its leftover relay timer kept Bun alive and the completed fixture process was terminated explicitly.
- 6 targeted tests, 54 assertions passed (cache integrity/artifact binding/symlink denial, destination validation, TLS pinning and actual republication).
- 380 responsive layout checks passed across 19 sizes, 280–2560 pixels and short landscape, including screenshot review and listing result.
- Screenshot guide regenerated and visually reviewed; docs build, schema drift check, 1,311 links, 90 browser layouts and 140 image checks passed.
- TypeScript 5.9.3 baseline remains 424 existing diagnostics, no new diagnostic signatures.
- Live http://127.0.0.1:49371 restarted only after zero active generation/publication jobs; saved chatgpt-oauth mode and generation worker digest retained. Served bundle contains screenshot/listing UI and NIP-46 listing permission. No live user applet was signed or published.

## Compatibility and limits

- Existing published envelopes remain byte-identical on Republish. New publications of existing un-published builds get screenshots/listings without a model call.
- Current generation/preview use legacy manifests, so no proposed current-format app tag is added. The listing description includes the napplet naddr. Full current-format build/verifier/shell migration remains separate work.
- A relay confirmation means metadata is shared, not that Zapstore has admitted it into its catalog. Production certification remains deferred.
- Official reference: https://napplet.run/docs/packages/cli.html#screenshots-and-optional-zapstore-metadata
