These are local compatibility fixtures captured on 2026-10-28. They are not
protected production evidence and do not demonstrate a completed authoring flow.

- `cli-current.json`: actual offline `napplet deploy --dry-run --json --name
  cvm-capability-intake --no-zapstore --non-interactive`, using CLI 0.13.0 built
  from upstream commit `3c6e3ae33fea425b2f151740c0bd8c02f509ef7b`.
- `manifest-current.json`: actual unsigned Vite-plugin 0.16.1 sidecar for that
  build, using SDK 0.30.0 and boilerplate commit
  `cbbebe9bd56271277b054535c0a8d720a588f61d`.
- `conformance-current.json`: actual conformance CLI 0.4.0 JSON output from a
  network-blocked Chromium run against the same build. Six checks passed; the
  manifest checks and lifecycle measurement were skipped as recorded. This
  standalone result does not certify the real publication host or teardown.

The raw HTML hash in the captured CLI and sidecar is
`47c19988a3498e97601768116092afd614615b6730a2a2987e9fa67ee251b067`.
Unit tests replace the HTML and its corresponding hashes with small synthetic
bytes. The recorded declaration demonstrates metadata propagation only; it
does not prove application use of either declared capability.
