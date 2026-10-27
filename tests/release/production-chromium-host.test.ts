import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
// The maintained package exposes its working Bun ESM entrypoint without a
// declaration file; production uses the same runtime entrypoint.
// @ts-expect-error nested Playwright ESM entrypoint has no declaration file
import { chromium } from "../dev-ui/node_modules/playwright/index.mjs";

import { ProductionChromiumCompatibleHost } from "../../src/production/chromium-host";

const digest = (letter: string) => letter.repeat(64);
const identifiers = [
  ["aggregate_hash", "Aggregate hash", "Full aggregate hash:", "Copy full aggregate hash", "5f9b1e27b7a24d7a90ea"] ,
  ["normalized_d_tag", "d-tag", "Full normalized d-tag:", "Copy full normalized d-tag", "napplet-verified-release"] ,
  ["capability_digest", "Capability digest", "Full capability digest:", "Copy full capability digest", "516b9d6cedd840c78eef"] ,
  ["admission_reference", "Admission reference", "Full admission reference:", "Copy full admission reference", "admission-9f2c03"] ,
  ["publication_intent", "Publication intent", "Full publication intent:", "Copy full publication intent", "intent-692d0e"] ,
  ["publication_operation", "Publication operation", "Full publication operation:", "Copy full publication operation", "operation-4db33c"] ,
  ["owner_manifest_event", "Your manifest event", "Full owning manifest event identifier:", "Copy full manifest event identifier", "nevent1manifest3e1a"] ,
  ["cvm_attestation", "CVM build attestation", "Full CVM build attestation identifier:", "Copy full CVM build attestation identifier", "nevent1attestationa9"] ,
  ["deployment", "Deployment", "Full deployment identifier:", "Copy full deployment identifier", "https://napplet.example/verified"] ,
  ["evidence_reference", "Evidence reference", "Full evidence reference:", "Copy full evidence reference", "evidence-53ea74"] ,
] as const;
const requiredStateCopy = [
  "Starting isolated workspace…", "Capacity is temporarily unavailable.", "No session was started and no funds were reserved.", "Try admission again",
  "Checking verified artifact…", "Preview not started", "Open the exact verified artifact before preparing publication.", "Preview verified napplet",
  "Opening sealed preview…", "Preview ready", "Review capabilities", "This runtime cannot run the verified napplet.",
  "Choose a compatible runtime to preview and publish this artifact.", "Preview access expired.", "Request a new preview for this same verified artifact. No publication was started.",
  "Preview is unavailable for this artifact.", "Return to the verified artifact and review its status.", "Checking runtime compatibility…",
  "No manifest capabilities were returned.", "Publication cannot continue until the verified manifest is available.", "Required — unavailable in this runtime.",
  "Optional — unavailable in this runtime.", "Ready for publication approval.", "Publish napplet", "Review changed — publication approval was cleared.",
  "Artifact, capability, compatibility, d-tag, or policy details changed. Review the exact current details before signing.", "Publish this verified napplet?",
  "You are approving deployment of the sealed artifact shown here and publication of your signed manifest. You will sign next.", "Approve and continue to signing", "Return to review",
  "Waiting for host signer…", "Waiting for external signer…", "Cancel signing", "The manifest was not accepted.",
  "Review the manifest and sign the exact current publication intent again.", "Review manifest", "The signature is no longer valid for this publication.",
  "The publication intent expired or changed. Start a new review and signing step.", "Signature verified. Preparing the original publication operation…",
  "Deploying sealed bytes", "Publishing your manifest", "Publishing CVM attestation", "Closing this surface does not cancel reconciliation.",
  "Publication status is being reconciled.", "The service is checking the original publication operation. Do not sign or publish again.", "Reconcile publication",
  "This publication was already processed.", "View publication details", "Napplet published.", "Copy publication details", "Publication is not complete.",
  "Some results are confirmed; reconciliation will determine the remaining result.", "Not yet confirmed", "This publication request conflicts with an existing intent.",
  "Review the current artifact and create a new publication only if you intend to publish a different verified artifact.", "Publication could not be completed.",
  "The exact operation was recorded. Review its status before taking another action.", "View publication status", "Launch certification is blocked.",
  "Required live evidence is missing, stale, failed, skipped, or not observed. Production promotion is unavailable.", "View release evidence",
] as const;
const abbreviated = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;
const fixture = (input: Readonly<{ dialog?: boolean; targetPx?: number; foreground?: string; states?: boolean }> = {}) => {
  const dialog = input.dialog ?? true;
  const targetPx = input.targetPx ?? 48;
  const foreground = input.foreground ?? "#172033";
  const identifierRows = identifiers.map(([kind, label, accessiblePrefix, copyLabel, value]) => `<div class="identifier" data-cvm-identifier-kind="${kind}" aria-label="${accessiblePrefix} ${value}"><span data-cvm-identifier-label>${label}</span><code data-cvm-identifier-display>${abbreviated(value)}</code><button data-cvm-copy-kind="${kind}" aria-label="${copyLabel}">${copyLabel}</button></div>`).join("");
  const stateRows = input.states === false ? "" : requiredStateCopy.map(copy => `<li>${copy}</li>`).join("");
  return `<!doctype html>
<html><head><style>
:root { --surface: #ffffff; --raised: #edf2f7; --accent: #005fcc; --text: ${foreground}; --target: ${targetPx}px; font-family: system-ui, sans-serif; color: var(--text); background: var(--surface); }
* { box-sizing: border-box; }
html, body { margin: 0; min-width: 0; background: var(--surface); }
body { font-size: 16px; line-height: 1.5; overflow-x: hidden; }
[data-cvm-host-contract] { min-width: 0; padding: 16px; background: var(--surface); }
h1 { margin: 0 0 16px; font-size: 28px; font-weight: 600; } h2 { margin: 0 0 8px; font-size: 20px; font-weight: 600; } p, button { font-size: 16px; font-weight: 400; } small, li { font-size: 14px; font-weight: 400; }
button { min-width: var(--target); min-height: var(--target); padding: 8px 12px; border: 1px solid #334155; border-radius: 4px; color: var(--text); background: var(--raised); cursor: pointer; }
button:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
[data-cvm-layout-grid] { display: grid; grid-template-columns: minmax(0, 62fr) minmax(0, 38fr); gap: 32px; min-width: 0; }
[data-cvm-preview-well] { min-width: 0; aspect-ratio: 16 / 10; padding: 16px; border: 1px solid #64748b; background: var(--surface); }
[data-cvm-inspector] { min-width: 0; padding: 16px; background: var(--raised); }
[data-cvm-semantic-status] { display: flex; gap: 4px; align-items: center; color: var(--text); }
[data-cvm-status-shape] { width: 12px; height: 12px; border: 2px solid currentColor; border-radius: 50%; }
[data-cvm-step-section] { padding: 8px 0; border-block-end: 1px solid #94a3b8; }
[data-cvm-step-section][aria-hidden="true"] { display: block; }
[data-cvm-next-action] { display: block; margin-block-start: 16px; }
.identifier { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 1fr) auto; gap: 8px; align-items: center; min-width: 0; margin-block: 8px; }
[data-cvm-identifier-display] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-cvm-state-inventory] { margin: 16px 0; padding-inline-start: 20px; }
dialog { max-width: min(560px, calc(100vw - 32px)); border: 1px solid #334155; color: var(--text); background: var(--surface); padding: 24px; }
dialog::backdrop { background: rgb(15 23 42 / 0.35); }
[data-cvm-motion] { transition: opacity 150ms ease, transform 150ms ease; }
@media (min-width: 768px) and (max-width: 1023px) { [data-cvm-layout-grid] { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 767px) { [data-cvm-layout-grid] { grid-template-columns: minmax(0, 1fr); } [data-cvm-step-section] { display: none; } [data-cvm-step-section][data-cvm-current-section] { display: block; } [data-cvm-next-action] { width: 100%; } .identifier { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { [data-cvm-motion] { transition-duration: 100ms; animation-duration: 0ms; } }
</style></head><body>
<main data-cvm-host-contract aria-label="Sealed napplet publication workflow">
  <header><h1 data-cvm-readable>Verified napplet</h1></header>
  <nav aria-label="Publication progress"><span data-cvm-step-label aria-current="step">Preview</span><span id="future-step-reason">Complete the verified preview before publishing.</span><span aria-disabled="true" aria-describedby="future-step-reason">Publish</span></nav>
  <section data-cvm-layout-grid>
    <section data-cvm-preview-well aria-label="Sealed preview of verified napplet">
      <p data-cvm-semantic-status data-cvm-contrast><span data-cvm-status-shape aria-hidden="true"></span><span>Preview ready</span></p>
      <p id="fixture-live" data-cvm-live-region aria-live="polite"></p><span id="fixture-live-count" data-cvm-live-count>0</span>
      <button data-cvm-live-trigger data-cvm-focus-target data-cvm-motion>Preview verified napplet</button>
    </section>
    <section data-cvm-inspector>
      <section data-cvm-step-section data-cvm-current-section><h2 data-cvm-readable>Capability review</h2><p data-cvm-readable>Required capabilities are reviewed before publication.</p></section>
      <section data-cvm-step-section><h2 data-cvm-readable>Publication approval</h2><p data-cvm-readable>Review the current verified artifact.</p></section>
      ${dialog ? `<button data-cvm-dialog-open data-cvm-motion>Publish napplet</button><dialog data-cvm-dialog role="dialog" aria-labelledby="fixture-dialog-title" aria-describedby="fixture-dialog-description"><h2 id="fixture-dialog-title">Publish this verified napplet?</h2><p id="fixture-dialog-description">You are approving deployment of the sealed artifact shown here and publication of your signed manifest. You will sign next.</p><button data-cvm-dialog-initial>Return to review</button><button>Approve and continue to signing</button></dialog>` : ""}
      <button data-cvm-next-action>Review capabilities</button>
    </section>
  </section>
  <section data-cvm-state-inventory aria-label="Release states"><ul>${stateRows}</ul></section>
  <section aria-label="Identifiers">${identifierRows}<p data-cvm-copy-status aria-live="polite"></p></section>
</main>
<script>
  const live = document.querySelector('#fixture-live'); const count = document.querySelector('#fixture-live-count'); let announced = false;
  document.querySelector('[data-cvm-live-trigger]').addEventListener('click', () => { if (!announced) { announced = true; live.textContent = 'Preview ready'; count.textContent = '1'; } });
  const opener = document.querySelector('[data-cvm-dialog-open]'); const dialog = document.querySelector('[data-cvm-dialog]');
  if (opener && dialog) { opener.addEventListener('click', () => dialog.showModal()); dialog.addEventListener('close', () => opener.focus()); }
  document.querySelectorAll('[data-cvm-copy-kind]').forEach(button => button.addEventListener('click', () => { document.querySelector('[data-cvm-copy-status]').textContent = 'Copied ' + button.getAttribute('data-cvm-copy-kind'); }));
</script></body></html>`;
};
const sha256 = (body: string) => createHash("sha256").update(body).digest("hex");
const installedHeadlessShell = async (): Promise<string> => {
  const server = await chromium.launchServer({ headless: true });
  try {
    const executable = server.process()?.spawnfile;
    if (!executable) throw new Error("Playwright did not expose its headless-shell executable");
    return executable;
  } finally {
    await server.close();
  }
};
const startFixture = async (body = fixture()) => {
  let responseBody = body;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "null" });
    response.end(responseBody);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    setBody: (next: string) => { responseBody = next; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

test("pinned Chromium measures the local Paja presentation fixture while unavailable signer paths stay blocked", async () => {
  const body = fixture();
  const server = await startFixture(body);
  try {
    const browser = new ProductionChromiumCompatibleHost({ hostUrl: server.url, hostSha256: sha256(body), chromiumExecutable: await installedHeadlessShell(), timeoutMs: 10_000 });
    const raw = await browser.observe({ sealedArtifactSha256: digest("a"), aggregateSha256: digest("b"), viewports: [{ name: "desktop", width: 1280 }, { name: "tablet", width: 768 }, { name: "mobile", width: 375 }], interactions: ["keyboard", "touch", "focus", "dialog", "live_region", "capability_mediation"] });
    expect(raw.hostPreview).toBe("pass");
    expect(raw.consoleErrors).toEqual([]);
    expect(raw.hostSigner).toBe("blocked");
    expect(raw.externalSigner).toBe("blocked");
    expect(raw.reconciliation).toBe("blocked");
    expect(raw.launchCertificationBlockedState).toBe("not_observed");
    expect(raw.observations).toHaveLength(3);
    for (const observation of raw.observations) {
      expect(observation.minimumMeasuredTargetPx).toBeGreaterThanOrEqual(44);
      expect(observation.noClippedStepLabels).toBe(true);
      expect(observation.noNestedHorizontalScroll).toBe(true);
      expect(observation).toMatchObject({
        layout: "pass",
        targets: "pass",
        accessibility: "pass",
        keyboardFocus: "pass",
        dialog: "pass",
        liveRegion: "pass",
        contrast: "pass",
        reducedMotion: "pass",
        stateInventory: "pass",
        identifierCoverage: "pass",
      });
    }
  } finally { await server.close(); }
}, 30_000);

test("the production probe rejects a pinned-byte mutation before Chromium starts", async () => {
  const body = fixture();
  const server = await startFixture(body);
  try {
    const browser = new ProductionChromiumCompatibleHost({ hostUrl: server.url, hostSha256: sha256(body), chromiumExecutable: chromium.executablePath() });
    server.setBody(`${body}<!-- pinned bytes changed -->`);
    await expect(browser.observe({ sealedArtifactSha256: digest("a"), aggregateSha256: digest("b"), viewports: [{ name: "desktop", width: 1280 }], interactions: [] })).rejects.toThrow("COMPATIBLE_HOST_PIN_MISMATCH");
  } finally { await server.close(); }
});

test("the browser probe blocks an absent dialog instead of treating the fixture contract as sufficient", async () => {
  const body = fixture({ dialog: false });
  const server = await startFixture(body);
  try {
    const browser = new ProductionChromiumCompatibleHost({ hostUrl: server.url, hostSha256: sha256(body), chromiumExecutable: await installedHeadlessShell(), timeoutMs: 10_000 });
    const result = await browser.observe({ sealedArtifactSha256: digest("a"), aggregateSha256: digest("b"), viewports: [{ name: "desktop", width: 1280 }], interactions: ["dialog"] });
    expect(result.observations[0]?.dialog).toBe("blocked");
    expect(result.observations[0]?.layout).toBe("pass");
  } finally { await server.close(); }
}, 30_000);

test("the browser probe rejects a rendered action smaller than the 44px contract", async () => {
  const body = fixture({ targetPx: 40 });
  const server = await startFixture(body);
  try {
    const browser = new ProductionChromiumCompatibleHost({ hostUrl: server.url, hostSha256: sha256(body), chromiumExecutable: await installedHeadlessShell(), timeoutMs: 10_000 });
    await expect(browser.observe({ sealedArtifactSha256: digest("a"), aggregateSha256: digest("b"), viewports: [{ name: "desktop", width: 1280 }], interactions: [] })).rejects.toThrow("COMPATIBLE_HOST_LAYOUT_MEASUREMENT_FAILED");
  } finally { await server.close(); }
}, 30_000);

test("the browser probe blocks a measured contrast failure instead of defaulting it to pass", async () => {
  const body = fixture({ foreground: "#777777" });
  const server = await startFixture(body);
  try {
    const browser = new ProductionChromiumCompatibleHost({ hostUrl: server.url, hostSha256: sha256(body), chromiumExecutable: await installedHeadlessShell(), timeoutMs: 10_000 });
    const result = await browser.observe({ sealedArtifactSha256: digest("a"), aggregateSha256: digest("b"), viewports: [{ name: "desktop", width: 1280 }], interactions: [] });
    expect(result.observations[0]?.contrast).toBe("blocked");
    expect(result.observations[0]?.layout).toBe("pass");
  } finally { await server.close(); }
}, 30_000);

test("the browser probe blocks an incomplete state inventory", async () => {
  const body = fixture({ states: false });
  const server = await startFixture(body);
  try {
    const browser = new ProductionChromiumCompatibleHost({ hostUrl: server.url, hostSha256: sha256(body), chromiumExecutable: await installedHeadlessShell(), timeoutMs: 10_000 });
    const result = await browser.observe({ sealedArtifactSha256: digest("a"), aggregateSha256: digest("b"), viewports: [{ name: "desktop", width: 1280 }], interactions: [] });
    expect(result.observations[0]?.stateInventory).toBe("blocked");
    expect(result.observations[0]?.layout).toBe("pass");
  } finally { await server.close(); }
}, 30_000);
