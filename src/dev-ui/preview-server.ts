import { extname } from "node:path";
import type { LocalArtifactRepository } from "../dev/local-artifact-repository";
import type { LocalPreviewGrantStore } from "../dev/local-preview-grant-store";

const mime = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"]]);
const pajaRoutes = new Set(["/", "/__kehto/config.json", "/__kehto/target.html", "/__kehto/target-cors.json", "/__kehto/browser-host.js"]);
const collapsedConsole = `<script>try { localStorage.setItem('kehto:paja:console:v1', 'collapsed'); } catch {} window.addEventListener('load', () => { const toggle = document.getElementById('paja-console-toggle'); if (toggle?.getAttribute('aria-expanded') === 'true') toggle.click(); }, { once: true });</script>`;
// A presentation switch for the product workspace. It changes no sandbox,
// simulation, grant, capability or message policy; /dev keeps Paja controls.
const workspaceChrome = `<style>html[data-preview-presentation="workspace"] body { grid-template-rows: minmax(0, 1fr); } html[data-preview-presentation="workspace"] .bar, html[data-preview-presentation="workspace"] .console { display: none !important; } html[data-preview-presentation="workspace"] main { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }</style>`;
export type PreviewServer = Readonly<{ url: string; openPaja(token: string): Promise<string>; openTarget(targetUrl: string): Promise<string>; handlePublic(request: Request): Promise<Response | undefined>; close(): Promise<void> }>;
/** Static/opaque-grant boundary only. There are deliberately no application commands here. */
export async function createPreviewServer(input: Readonly<{ publicOrigin?: string; repository: LocalArtifactRepository; grants: LocalPreviewGrantStore; paja: Readonly<{ startPajaServer(options: unknown): Promise<{ url: string; close(): Promise<void> }>; domains: readonly string[] }> }>): Promise<PreviewServer> {
  const publicHosts = new Map<string, { url: string; targetUrl: string }>();
  const hosts: Array<{ close(): Promise<void> }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); if (url.pathname === "/health") return Response.json({ status: "ok" });
    const match = /^\/preview\/([A-Za-z0-9]+)\/(.+)$/u.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    try {
      const grant = await input.grants.authorize({ token: match[1]!, path: decodeURIComponent(match[2]!) }); if (!grant) return new Response("not found", { status: 404 });
      const stored = await input.repository.read({ artifactId: grant.artifactId, path: decodeURIComponent(match[2]!) }); if (!stored) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(stored.bytes), { headers: { "content-type": mime.get(extname(stored.file.path)) ?? "application/octet-stream", "cache-control": "private, no-store", "access-control-allow-origin": "null", "cross-origin-resource-policy": "cross-origin", "x-content-type-options": "nosniff" } });
    } catch { return new Response("not found", { status: 404 }); }
  } });
  const url = `http://127.0.0.1:${server.port}`;
  async function openTarget(targetUrl: string): Promise<string> {
    const host = await input.paja.startPajaServer({ options: { host: "127.0.0.1", port: 0, targetUrl, simulation: { capabilities: { domains: Object.fromEntries(input.paja.domains.map((domain) => [domain, false])) }, acl: { mode: "deny" }, firewall: { mode: "deny" }, identity: { mode: "anonymous" }, relay: { mode: "disabled" }, storage: { mode: "disabled" }, cache: { mode: "disabled" }, upload: { mode: "disabled" }, media: { enabled: false }, notifications: { enabled: false, grant: false }, intent: { enabled: false }, cvm: { enabled: false } } } });
    // Paja 0.19 has a persisted drawer preference but no initial-state option.
    // Initialize it before its module runs, on a separate loopback preview origin.
    const upstream = new URL(host.url);
    if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") { await host.close(); throw new Error("PAJA_LOOPBACK_REQUIRED"); }
    const minimized = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const requestUrl = new URL(request.url);
      const path = requestUrl.pathname;
      const workspace = requestUrl.searchParams.get("presentation") === "workspace";
      if (request.method !== "GET" || !pajaRoutes.has(path)) return new Response("not found", { status: 404 });
      try {
        const response = await fetch(new URL(path, upstream), { redirect: "error" });
        const forwarded = new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        if (path !== "/" || !response.ok) return forwarded;
        return new HTMLRewriter().on("html", { element(element) { element.setAttribute("data-paja-console", "collapsed"); if (workspace) element.setAttribute("data-preview-presentation", "workspace"); } }).on("head", { element(element) { element.prepend(collapsedConsole + (workspace ? workspaceChrome : ""), { html: true }); } }).transform(forwarded);
      } catch { return new Response("preview unavailable", { status: 502 }); }
    } });
    hosts.push({ async close() { minimized.stop(true); await host.close(); } });
    const localUrl = `http://127.0.0.1:${minimized.port}`;
    if (!input.publicOrigin) return localUrl;
    const id = crypto.randomUUID();
    publicHosts.set(id, { url: localUrl, targetUrl });
    return `${input.publicOrigin}/cvm-preview/${id}/`;
  }
  async function handlePublic(request: Request): Promise<Response | undefined> {
    if (!input.publicOrigin) return;
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname.startsWith('/cvm-artifacts/')) {
      if (request.method !== 'GET') return new Response('not found', { status: 404 });
      const response = await fetch(`${url}/preview/${requestUrl.pathname.slice('/cvm-artifacts/'.length)}`, { redirect: 'error' });
      const headers = new Headers(response.headers); headers.set('content-security-policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:");
      return new Response(response.body, { status: response.status, headers });
    }
    if (!requestUrl.pathname.startsWith('/cvm-preview/')) return;
    const match = /^\/cvm-preview\/([a-f0-9-]{36})(\/.*)$/.exec(requestUrl.pathname);
    const host = match && publicHosts.get(match[1]!);
    if (!match || !host || request.method !== 'GET' || !pajaRoutes.has(match[2]!)) return new Response('not found', { status: 404 });
    const target = new URL(match[2]!, host.url); target.search = requestUrl.search;
    const response = await fetch(target, { redirect: 'error' });
    if (match[2] === '/__kehto/target.html') { const headers = new Headers(response.headers); headers.set('content-security-policy', 'sandbox allow-scripts'); return new Response(response.body, { status: response.status, headers }); }
    if (match[2] !== '/__kehto/config.json' || !host.targetUrl.startsWith(`${url}/preview/`)) return response;
    const externalTarget = `${input.publicOrigin}/cvm-artifacts/${host.targetUrl.slice(`${url}/preview/`.length)}`;
    return new Response((await response.text()).replaceAll(host.targetUrl, externalTarget), { status: response.status, headers: response.headers });
  }
  return Object.freeze({ url, openTarget, handlePublic, openPaja: (token: string) => openTarget(`${url}/preview/${encodeURIComponent(token)}/index.html`), async close(): Promise<void> { await Promise.all(hosts.map((host) => host.close())); server.stop(true); } });
}
