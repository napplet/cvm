import { z } from "zod";
import { DirectArtifactDeliverySchema } from "../../src/publication/direct-delivery";
import { createProductionDirectPreviewAssets } from "../../src/production/direct-preview-assets";

const Driver = String.raw`
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
const require = createRequire('/toolchain/package.json');
const { chromium } = require(require.resolve('playwright', { paths: [realpathSync('/toolchain/node_modules/@napplet/conformance-cli')] }));
let raw = ''; for await (const part of process.stdin) { raw += part; if (raw.length > 4_000_000) throw Error('PREVIEW_INPUT_LIMIT'); }
const input = JSON.parse(raw);
let browser, server, canaries = 0;
const check = (condition, label) => { if (!condition) throw Error(label); };
try {
  server = createServer((req, res) => {
    if (req.url === '/host.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(input.bundle); }
    if (req.url === '/canary') canaries++;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(async source => {
    window.host = await import('/host.js'); window.previewSource = source;
    window.expected = { sessionId: source.artifact.sessionId, artifactId: source.artifact.artifactId };
    window.review = await window.host.reviewDirectPreview(source, window.expected);
    window.fresh = () => { const frame = document.createElement('iframe'); frame.name = 'preview'; document.body.append(frame); return frame; };
    window.preview = await window.host.mountDirectPreview({ iframe: window.fresh(), source, expected: window.expected,
      approval: { reviewSha256: window.review.reviewSha256, domains: ['storage'] } });
  }, input.delivery);
  let frame = page.frame({ name: 'preview' }); check(frame, 'PREVIEW_FRAME_MISSING');
  await frame.getByRole('button', { name: 'Count: 0', exact: true }).waitFor();
  const environment = await frame.evaluate(async () => { await window.napplet.shell.ready(); return { storage: window.napplet.shell.supports('storage'), identity: window.napplet.shell.supports('identity'), signer: typeof window.nostr }; });
  check(environment.storage && !environment.identity && environment.signer === 'undefined', 'PREVIEW_ENVIRONMENT_FALSE');
  check(await page.evaluate(() => localStorage.length) === 0, 'PREVIEW_HOST_STORAGE_USED');
  await frame.getByRole('button', { name: 'Count: 0', exact: true }).click();
  await frame.getByRole('button', { name: 'Count: 1', exact: true }).waitFor();
  await frame.waitForFunction(async () => await window.napplet.storage.getItem('counter') === '1');
  const boundary = await frame.evaluate(async () => {
    let local = false, parentDenied = false, networkDenied = false;
    try { localStorage.setItem('escape', '1'); } catch { local = true; }
    try { void parent.document.body; } catch { parentDenied = true; }
    try { await fetch('/canary'); } catch { networkDenied = true; }
    return { local, parentDenied, networkDenied };
  });
  check(boundary.local && boundary.parentDenied && boundary.networkDenied, 'PREVIEW_BOUNDARY_OPEN');
  await page.evaluate(() => {
    window.sibling = document.createElement('iframe'); window.sibling.sandbox = 'allow-scripts';
    window.sibling.srcdoc = '<script>parent.postMessage({type:"storage.set", id:"sibling", key:"counter", value:"99"}, "*")<\/script>';
    document.body.append(window.sibling);
    window.dispatchEvent(new MessageEvent('message', { source: document.querySelector('iframe[name=preview]').contentWindow,
      origin: 'https://foreign.example', data: { type: 'storage.set', id: 'foreign-origin', key: 'counter', value: '88' } }));
  });
  check(await frame.evaluate(() => window.napplet.storage.getItem('counter')) === '1', 'PREVIEW_SOURCE_BINDING_FAILED');
  await frame.evaluate(() => parent.postMessage({ type: 'storage.set', id: 'invalid-value', key: 'invalid-value', value: { nested: 'untrusted' } }, '*'));
  check(await frame.evaluate(() => window.napplet.storage.getItem('invalid-value')) === null, 'PREVIEW_STORAGE_VALUE_TYPE_BYPASS');
  const quota = await frame.evaluate(async () => {
    let refused = false;
    for (let index = 0; index < 24; index++) { try {
      await window.napplet.storage.setItem('quota-' + index, 'x'.repeat(16000));
      if (await window.napplet.storage.getItem('quota-' + index) === null) { refused = true; break; }
    } catch { refused = true; break; } }
    return refused;
  });
  check(quota, 'PREVIEW_STORAGE_UNBOUNDED');
  await page.evaluate(() => { window.oldChild = document.querySelector('iframe[name=preview]').contentWindow; window.preview.close(); window.sibling.remove(); });
  check(await page.locator('iframe').count() === 0, 'PREVIEW_TEARDOWN_FAILED');
  const denials = await page.evaluate(async () => {
    let count = 0;
    for (const approval of [{ reviewSha256: '0'.repeat(64), domains: ['storage'] }, { reviewSha256: window.review.reviewSha256, domains: [] },
      { reviewSha256: window.review.reviewSha256, domains: ['storage', 'identity'] }]) {
      const frame = window.fresh();
      try { await window.host.mountDirectPreview({ iframe: frame, source: window.previewSource, expected: window.expected, approval }); }
      catch { if (!frame.srcdoc) count++; }
      frame.remove();
    }
    const unsupported = structuredClone(window.previewSource);
    unsupported.capabilities.required = ['intent'];
    unsupported.ownerManifestTemplate.tags = unsupported.ownerManifestTemplate.tags.map(tag => tag[0] === 'R' ? ['R', 'intent'] : tag);
    const unavailable = await window.host.reviewDirectPreview(unsupported, window.expected), missing = window.fresh();
    try { await window.host.mountDirectPreview({ iframe: missing, source: unsupported, expected: window.expected,
      approval: { reviewSha256: unavailable.reviewSha256, domains: ['intent'] } }); }
    catch { if (!missing.srcdoc && unavailable.missingRequired.includes('intent')) count++; }
    missing.remove();
    window.preview = await window.host.mountDirectPreview({ iframe: window.fresh(), source: window.previewSource, expected: window.expected,
      approval: { reviewSha256: window.review.reviewSha256, domains: ['storage'] } });
    return count;
  });
  check(denials === 4, 'PREVIEW_CONSENT_BYPASS');
  frame = page.frame({ name: 'preview' });
  await frame.getByRole('button', { name: 'Count: 0', exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { source: window.oldChild, origin: 'null', data: { type: 'storage.set', id: 'stale', key: 'counter', value: '77' } })));
  check(await frame.evaluate(() => window.napplet.storage.getItem('counter')) === null, 'PREVIEW_STORAGE_LEAKED');
  await page.evaluate(() => document.querySelector('iframe[name=preview]').setAttribute('sandbox', 'allow-scripts allow-same-origin'));
  await page.waitForFunction(() => document.querySelectorAll('iframe').length === 0);
  check(canaries === 0, 'PREVIEW_NETWORK_CANARY_REACHED');
  check(await page.evaluate(() => localStorage.length) === 0, 'PREVIEW_HOST_STORAGE_PERSISTED');
  console.log(JSON.stringify({ version: 1, bundleSha256: input.bundleSha256, kernel: '@kehto/runtime@0.24.1', sandbox: 'allow-scripts', storage: true, sourceBinding: true,
    privateEphemeralState: true, quota: true, consentDenials: denials, networkCanaries: canaries, teardown: true, releaseEvidence: false }));
} finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
`;

/** Run the actual browser consumer only inside the existing bounded, non-root,
 * network-denied local worker. This is mechanism proof, never live evidence. */
export async function proveDirectPreviewBrowser(input: Readonly<{ worker: Readonly<{ exec(command: readonly string[], stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> }>; delivery: unknown }>) {
  const delivery = DirectArtifactDeliverySchema.parse(input.delivery);
  const assets = await createProductionDirectPreviewAssets();
  const response = await assets.handle(new Request(`https://static.example${assets.metadata.assetPath}`)), bundle = await response.text();
  if (!response.ok || new Bun.CryptoHasher("sha256").update(bundle).digest("hex") !== assets.metadata.sha256) throw new Error("DIRECT_PREVIEW_BROWSER_BUNDLE_REQUIRED");
  const result = await input.worker.exec(["node", "--input-type=module", "--eval", Driver], JSON.stringify({ bundle, bundleSha256: assets.metadata.sha256, delivery }));
  if (result.exitCode !== 0) throw new Error(`DIRECT_PREVIEW_BROWSER_FAILED:${result.stderr.slice(0, 4000)}`);
  return z.object({ version: z.literal(1), bundleSha256: z.literal(assets.metadata.sha256), kernel: z.literal("@kehto/runtime@0.24.1"), sandbox: z.literal("allow-scripts"), storage: z.literal(true),
    sourceBinding: z.literal(true), privateEphemeralState: z.literal(true), quota: z.literal(true), consentDenials: z.literal(4), networkCanaries: z.literal(0), teardown: z.literal(true), releaseEvidence: z.literal(false) }).strict().parse(JSON.parse(result.stdout));
}
