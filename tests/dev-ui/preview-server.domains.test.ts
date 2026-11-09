import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { PAJA_SIMULATION_DOMAINS, startPajaServer } from "@kehto/paja";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { createPreviewServer } from "../../src/dev-ui/preview-server";
import { discoveryRelay } from "../fixtures/discovery-relay";

const tokenOne = "1".repeat(64);
const tokenTwo = "2".repeat(64);
const aggregate = "c".repeat(64);
const artifactOne = { artifactId: `artifact:sha256:${"a".repeat(64)}`, ownerId: "d".repeat(64), aggregateSha256: aggregate };
const artifactTwo = { artifactId: `artifact:sha256:${"b".repeat(64)}`, ownerId: "e".repeat(64), aggregateSha256: aggregate };
const note = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [["t", "preview-fixture"]], content: "sealed preview relay note" }, generateSecretKey());
const previewDocument = `<!doctype html><html><body><script>
  (async () => {
    try {
      await window.napplet.shell.ready();
      const filter = { kinds: [1], since: Math.floor(Date.now() / 1000) - 86400 };
      const timeoutMs = 1000;
      const result = await window.napplet.outbox.query(filter, { timeoutMs });
      const ranking = await window.napplet.outbox.query({ kinds: [7], since: filter.since }, { timeoutMs });
      document.body.dataset.outbox = JSON.stringify({
        injected: typeof window.napplet.outbox?.query === "function",
        filter,
        timeoutMs,
        events: result.events.map(({ event }) => ({ id: event.id, kind: event.kind, content: event.content })),
        rankingCount: ranking.events.length,
        error: result.error ?? null,
      });
    } catch (error) {
      document.body.dataset.outbox = JSON.stringify({ error: String(error) });
    }
  })();
</script></body></html>`;

test("Paja preview exposes its real host controls, artifact-scoped identity, and live outbox query", async () => {
  const relay = discoveryRelay(); relay.events.push(note);
  const artifacts = new Map([[artifactOne.artifactId, artifactOne], [artifactTwo.artifactId, artifactTwo]]);
  const bytes = new TextEncoder().encode(previewDocument);
  let productionPajaOptions: any;
  const preview = await createPreviewServer({
    repository: {
      get: async (artifactId: string) => artifacts.get(artifactId),
      read: async ({ artifactId, path }: { artifactId: string; path: string }) => artifacts.has(artifactId) && path === "index.html" ? { bytes, file: { path } } : undefined,
    } as any,
    grants: { authorize: async ({ token, path }: { token: string; path: string }) => path === "index.html" && token === tokenOne ? { artifactId: artifactOne.artifactId } : path === "index.html" && token === tokenTwo ? { artifactId: artifactTwo.artifactId } : undefined } as any,
    paja: { domains: PAJA_SIMULATION_DOMAINS, async startPajaServer(input: any) {
      productionPajaOptions = input.options;
      return startPajaServer({ options: { ...input.options, simulation: { ...(input.options.simulation ?? {}), relay: { mode: "live", urls: [relay.url] } } } });
    } },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const [firstUrl, repeatedFirstUrl, secondUrl, genericOneUrl, genericTwoUrl] = await Promise.all([
      preview.openPaja(tokenOne),
      preview.openPaja(tokenOne),
      preview.openPaja(tokenTwo),
      preview.openTarget(`${preview.url}/preview/${tokenOne}/index.html?generic=one`),
      preview.openTarget(`${preview.url}/preview/${tokenTwo}/index.html?generic=two`),
    ]);
    expect(productionPajaOptions).toMatchObject({ host: "127.0.0.1", port: 0 });
    expect(productionPajaOptions).not.toHaveProperty("simulation");
    const [firstConfig, repeatedFirstConfig, secondConfig, genericOneConfig, genericTwoConfig] = await Promise.all([firstUrl, repeatedFirstUrl, secondUrl, genericOneUrl, genericTwoUrl].map((url) => fetch(new URL("__kehto/config.json", url)).then((response) => response.json())));
    expect(firstConfig.window).toMatchObject({ id: `cvm-preview-${"a".repeat(64)}`, dTag: `preview-${"a".repeat(64)}`, aggregateHash: aggregate });
    expect(secondConfig.window).toMatchObject({ id: `cvm-preview-${"b".repeat(64)}`, dTag: `preview-${"b".repeat(64)}`, aggregateHash: aggregate });
    expect(firstConfig.window.dTag).not.toBe(secondConfig.window.dTag);
    expect(repeatedFirstConfig.window).toEqual(firstConfig.window);
    expect(genericOneConfig.window).not.toMatchObject({ dTag: "dev-target", aggregateHash: "paja" });
    expect(genericTwoConfig.window).not.toEqual(genericOneConfig.window);

    const page = await browser.newPage();
    await page.goto(firstUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const consoleToggle = page.locator("#paja-console-toggle");
    await consoleToggle.waitFor({ state: "visible", timeout: 15_000 });
    expect(await consoleToggle.isVisible()).toBe(true);
    if (await consoleToggle.getAttribute("aria-expanded") !== "true") await consoleToggle.click();
    expect(await page.locator('[data-interface-domain="outbox"]').isVisible()).toBe(true);
    const frame = await (await page.locator("#napplet-frame").elementHandle())?.contentFrame();
    if (!frame) throw new Error("PAJA_PREVIEW_FRAME_MISSING");
    await frame.waitForFunction(() => Boolean(document.body.dataset.outbox), undefined, { timeout: 15_000 });
    const result = JSON.parse(await frame.locator("body").getAttribute("data-outbox") ?? "{}") as { injected?: boolean; filter?: { kinds?: number[]; since?: number }; timeoutMs?: number; events?: Array<{ id: string; kind: number; content: string }>; rankingCount?: number; error?: string | null };
    expect(result.injected).toBe(true);
    expect(result.filter?.kinds).toEqual([1]);
    expect(result.filter?.since).toBeGreaterThan(Math.floor(Date.now() / 1000) - 86_500);
    expect(result.timeoutMs).toBe(1000);
    expect(result.events).toEqual([{ id: note.id, kind: note.kind, content: note.content }]);
    expect(result.rankingCount).toBe(0);
    expect(relay.requests.some((filters) => filters.some((filter) => filter.kinds?.includes(1)))).toBe(true);
    expect(relay.requests.some((filters) => filters.some((filter) => filter.kinds?.includes(7)))).toBe(true);
  } finally {
    await browser.close(); await preview.close(); relay.close();
  }
}, 30_000);
