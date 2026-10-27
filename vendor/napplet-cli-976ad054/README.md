# Pinned napplet CLI network functions

`network-helpers.mjs` contains the upstream `uploadFilesToServers` and
`publishEventWithSimplePool` functions from napplet/web commit
`976ad0549c38f93d4ed418d3ea59a615a7e5fd7f`, bundled with its frozen root lockfile.
It exports no manifest discovery, CLI entry point, filesystem reader or signer
factory. The service supplies exact sealed bytes and externally signed events.

This is a separately measured source helper. It does not replace the historical
CLI binary's provenance or promote the source-build candidate. Production still
requires matching authorization and release evidence. See `provenance.json` for
the exact input/output digests and included licenses for dependencies.

Reproduce with the clean pinned source checkout and the verified Deno 2.9.6
Linux AMD64 runtime from the standalone CLI source-build recipe:

```sh
bun scripts/rebuild-napplet-upload-helper.ts /absolute/source /absolute/runtime /absolute/new-output
```

The script verifies source revision, tracked cleanliness, lockfile and runtime
binary; bundles twice at fixed container paths; disables network on the second
build; and requires both outputs to match the reviewed digest. It writes only
to the supplied new output directory. Runtime loading rechecks the bundle hash.
