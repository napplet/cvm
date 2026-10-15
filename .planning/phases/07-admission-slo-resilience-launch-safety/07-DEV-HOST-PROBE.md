# Official development host probe

Date: 2026-10-15. Scope: real-browser feasibility of the compatible preview host.

## Package and API

The official napplet source's `packages/conformance-cli/src/screenshot-preview.ts` uses `@kehto/paja` to host a local artifact. Its concrete adapter calls:

```ts
const host = await startPajaServer({
  options: { host: "127.0.0.1", port: 0, targetUrl },
});
// host.url, host.hostConfig, host.updateTargetUrl(targetUrl), host.close()
```

The registry supplied `@kehto/paja@0.19.0`; its tarball integrity was independently checked as `sha512-UCUwER9thz/sP3B1BPhM/QkymesjnFKGfeNLtuIX0lT1xPH+q8Tbl149U7P2OdgAWt+p5n8p/T/WIOXTFE1CBQ==`. This is a published package, so development launch need not depend on a sibling source checkout. Its transitive dependencies must be locked in the development tooling package when integrated.

Paja's own loader injects the runtime into a `srcdoc` document. This is the maintained compatible runtime, not a substitute handwritten iframe. The host must retain that runtime injection and its sandbox boundary. The target asset route needs CORS for the iframe's opaque (`null`) origin.

## Executed Chromium probe

Temporary probe: `/tmp/napplet-cvm-host-probe-20261015/probe.ts`. Its isolated package pins Paja `0.19.0` and Playwright `1.62.1`; it leaves the root manifest/lock untouched. Chromium and headless shell revision `1234` were installed for macOS arm64 through Playwright's pinned installer.

The probe served an explicit small fixture from an ephemeral loopback target and started the actual Paja server. It configured every optional capability false, anonymous identity, disabled relay/storage/cache/upload, denied ACL/firewall, and disabled media/notifications/intent/CVM. The fixture included a trusted CSP with `connect-src 'none'`.

Actual browser results:

```json
{
  "host": "@kehto/paja@0.19.0",
  "sandbox": "allow-scripts",
  "count": "1",
  "isolation": {
    "origin": "null",
    "hostStorageBlocked": true,
    "directFetchBlocked": true,
    "nostr": "undefined",
    "domains": ["shell"]
  },
  "errors": []
}
```

The browser awaited the real `window.napplet.shell.ready()` handshake, clicked the applet's counter button, inspected the actual iframe attributes, and attempted prohibited parent-storage and direct-fetch access. Both temporary servers and Chromium were closed after the probe.

## Limits and integration requirements

This proves the maintained host can run locally with the mandatory shell and restricted capabilities. It does not prove generated source, worker isolation, build/conformance, artifact ownership/hash verification, expiring grants, or the finished GUI. Plan 07-56 must supply those.

In particular, the probe's network denial came from its explicit trusted CSP. The actual artifact/host integration must enforce equivalent policy independently of generated source, including after Paja's runtime injection; an HTTP response header discarded by a fetch-to-srcdoc transformation is insufficient. Default Paja live relays and broad developer capabilities must not be used for the read-only preview.

The final preview tests must inspect the generated napplet iframe inside the trusted host, verify immutable artifact identity before rendering, and exercise actual grant expiry and cross-owner denial. Temporary probe files are references, not launch dependencies or acceptance substitutes.
