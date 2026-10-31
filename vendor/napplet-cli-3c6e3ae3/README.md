# Direct CLI network helper

This separately measured source helper comes from `napplet/web` commit
`3c6e3ae33fea425b2f151740c0bd8c02f509ef7b` (`0.13.0`). It exports exactly the
upstream `createUploadAuthorization`, `uploadFilesToServers` and
`publishEventWithSimplePool` functions. It exposes no manifest constructor,
filesystem discovery, CLI entry point or signer factory.

The actual three-export bundle SHA256 is
`2e50a73810bf8017b9569dd771842326b8ecc254dd912e92aaf9a43ab3a1a756`.
Two clean checkouts each produced two matching fixed-path builds; each second
build disabled networking. Both upstream and separately frozen build locks,
source-file hashes and the exact runtime are retained in `provenance.json`.

```sh
bun scripts/rebuild-napplet-upload-helper.ts --profile capabilities \
  /absolute/verified-source /absolute/runtime /absolute/new-output
```

The historical two-export helper, its loader and provenance remain unchanged.
An initial two-export build at this newer commit reproduced those historical
bytes exactly. The additional authorization export allows callers to use the
actual CLI's authorization builder. Included dependency licenses consequently
remain the same; the upstream license is copied from the exact new checkout.

The upload function contains upstream scoped-to-unscoped authorization fallback.
An exact approved signer must reject that downgrade. Loading this primitive
provides no provider authorization, caller ownership, exact-artifact validation,
operation fence or safe retry authority; those belong to the production adapter.
No network/signing effect happens at import. This source helper is unpromoted,
does not select an image/toolchain or replace a CLI binary identity, and is not
protected production certification evidence.
