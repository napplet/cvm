# Isolated development worker and generated preview probe

Date: 2026-10-15. This records an executed feasibility probe for Plan 07-56, not completed GUI integration.

## Pinned inputs

- Official boilerplate commit `cbbebe9bd56271277b054535c0a8d720a588f61d`: `https://codeload.github.com/napplet/boilerplate/tar.gz/cbbebe9bd56271277b054535c0a8d720a588f61d`, archive SHA-256 `7d66183c30454ec40ca2458d38dedde827fa1f8b58a2fbcd25a3b7d1c3bf538b`.
- Official CLI 0.5.2 Linux ARM64: `https://github.com/napplet/web/releases/download/%40napplet/cli%400.5.2/napplet-linux-aarch64`, binary SHA-256 `35ffb0d21e75877e749d63569b4369e5b467967e48034c2ee7d0ae958ed5ee54`.
- Unmodified upstream package/lock/scripts/Vite configuration: SDK 0.24.4, conformance CLI 0.2.15, Vite plugin 0.11.2, TypeScript 5.9.3, Vite 6.4.3, pnpm 10.8.0. This is a separately tested development set, not promotion of a production toolchain.
- Playwright base `mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`; Bun 1.3.14 image digest `sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`. The worker installs the template lock's Playwright 1.61.0 Chromium revision 1228 rather than assuming the base browser revision matches.
- Temporary resulting image `napplet-cvm/dev-worker-probe:upstream`, image ID `sha256:abb85e1801ac75c8fb6deae17c4bb14c2af366ac464826c95efb4c0bf0e16f53`.

The temporary image borrows the pinned skills installer from an existing local toolchain image. Final integration must intake and verify the official skills package independently; this temporary local image is not a launch prerequisite.

## Actual pipeline

The probe ran under Docker with network disabled, read-only root, UID/GID 65532, all capabilities dropped, no-new-privileges, 2 CPUs, 2 GiB memory, 256 PID limit, and bounded temporary filesystems. No model, wallet, database, signer, or cloud credentials entered the container. Only trusted probe input and the output collector were mounted.

All eight stages exited zero:

1. `napplet create /work/project --template /opt/template`
2. `napplet init --root --force --source-dir dist --title "Local execution probe"`
3. Pinned `@napplet/skills` installation in `/work`, inherited by the project before source authoring.
4. `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /opt/pnpm-store`
5. `pnpm build`
6. `pnpm verify`
7. `pnpm test:conformance`
8. `napplet deploy --dry-run --json --root`

The source overlay was a functional counter in vanilla TypeScript, importing the template's styles and protected optional-domain helper. Template guidance and type checking passed. Guidance requires skills outside the project rather than copied skill bodies inside it. The CLI has neither a `skills` subcommand nor a working `--version` flag in this release.

The actual browser conformance result was **5 passed, 0 failed, 5 skipped**. Manifest checks had no supplied manifest; wire and lifecycle checks were also skipped. This is not evidence that all ten checks ran. CLI-derived manifest/hash validation and a separate compatible-host interaction were therefore also performed.

The CLI dry run resolved **one deployment item and one unsigned manifest**, for `/index.html`. Its source directory must be `dist`: a wrong source directory can produce zero items with exit code zero. Vite logs intermediate external assets before the plugin inlines and removes them, so inspect final output rather than treating those log lines as proof of external assets.

Final HTML: 7,558 bytes, SHA-256 `7b1a5100994f92d43cc2f6327abb86a32dd024507ae48bb3172d838b12e6302b`. The CLI's aggregate hash was `7de015ea615543e30855219fd7c99119a4e1a12b6ddf5755d7ff2ccad37a1a2b`. These hashes identify this probe only. The plugin did not emit a separate unsigned manifest file; use the actual CLI dry-run template and file list, not a manually reconstructed protocol document.

## Actual compatible-host interaction and network denial

The real emitted HTML was served to `@kehto/paja@0.19.0` with anonymous identity, optional domains disabled, denied ACL/firewall, and no relay/storage/cache/upload/signing capabilities. Chromium clicked the counter and inspected the applet iframe.

Denied host capabilities alone did **not** stop browser fetch: an initial test reached a controlled loopback endpoint once. A trusted CSP was then inserted into the template before build and hashing:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'
```

The rebuilt artifact passed both the complete command pipeline and the compatible-host probe:

```json
{"host":"@kehto/paja@0.19.0","sandbox":"allow-scripts","count":"1","isolation":{"origin":"null","hostStorageBlocked":true,"nostr":"undefined","domains":["shell"]},"errors":[],"artifactBytes":7558,"directFetchBlocked":true,"egressRequests":0}
```

The CSP must be verified in the actual immutable HTML. A response header alone is insufficient because Paja fetches the target and injects it into its own sandboxed `srcdoc` document.

## Integration limits

Probe sources and reports live under `/tmp/napplet-cvm-worker-probe-20261015`; the generated-artifact host probe is `/tmp/napplet-cvm-host-probe-20261015/artifact-probe.ts`. Temporary files are not application dependencies or acceptance artifacts. One stale `.nip5a-manifest.json` from a separate package experiment exists in the temporary collector directory and must not be used; the report's actual CLI output identifies the current artifact.

Plan 07-56 still must implement source-proposal ownership binding, bounded output collection, independent artifact verification, durable artifact/grant persistence, revocation/expiry and cross-owner denial, and the complete signed ContextVM GUI flow. This probe proves the local toolchain and host path are viable; it does not prove those application integrations or production readiness.
