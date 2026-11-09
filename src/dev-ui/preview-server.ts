import { extname } from "node:path";
import type { LocalArtifactRepository, SealedArtifact } from "../dev/local-artifact-repository";
import type { LocalPreviewGrantStore } from "../dev/local-preview-grant-store";

const mime = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"]]);
const pajaRoutes = new Set(["/", "/__kehto/config.json", "/__kehto/target.html", "/__kehto/target-cors.json", "/__kehto/browser-host.js"]);
// Paja owns the drawer and its chevron. Seed a compact first visit without
// overriding a viewer who has deliberately expanded or collapsed it before.
const initialConsolePreference = `<script>try { const key = 'kehto:paja:console:v1'; if (localStorage.getItem(key) === null) localStorage.setItem(key, 'collapsed'); } catch {}</script>`;
type PajaWindowIdentity = Readonly<{ id: string; dTag: string; aggregateHash: string }>;

function pajaWindowIdentity(artifact: SealedArtifact): PajaWindowIdentity {
  // The record identity commits the verified owner and artifact facts, while the
  // aggregate preserves the exact sealed byte identity Paja uses for isolation.
  const artifactDigest = artifact.artifactId.slice("artifact:sha256:".length);
  return Object.freeze({ id: `cvm-preview-${artifactDigest}`, dTag: `preview-${artifactDigest}`, aggregateHash: artifact.aggregateSha256 });
}
function targetPajaWindowIdentity(targetUrl: string): PajaWindowIdentity {
  const digest = new Bun.CryptoHasher("sha256").update(targetUrl).digest("hex");
  return Object.freeze({ id: `cvm-preview-target-${digest}`, dTag: `preview-target-${digest}`, aggregateHash: digest });
}
function withPajaWindowIdentity(value: unknown, identity: PajaWindowIdentity): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAJA_CONFIG_INVALID");
  const config = value as Record<string, unknown>; const window = config.window;
  if (!window || typeof window !== "object" || Array.isArray(window)) throw new Error("PAJA_CONFIG_INVALID");
  return { ...config, window: { ...(window as Record<string, unknown>), ...identity } };
}
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
  async function openTarget(targetUrl: string, identity = targetPajaWindowIdentity(targetUrl)): Promise<string> {
    // Keep Paja's concrete default host composition: it performs its own
    // browser/service availability checks and presents its own permission UI.
    const host = await input.paja.startPajaServer({ options: { host: "127.0.0.1", port: 0, targetUrl } });
    const upstream = new URL(host.url);
    if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") { await host.close(); throw new Error("PAJA_LOOPBACK_REQUIRED"); }
    const minimized = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const requestUrl = new URL(request.url);
      const path = requestUrl.pathname;
      if (request.method !== "GET" || !pajaRoutes.has(path)) return new Response("not found", { status: 404 });
      try {
        const response = await fetch(new URL(path, upstream), { redirect: "error" });
        if (path === "/__kehto/config.json" && response.ok) {
          return Response.json(withPajaWindowIdentity(await response.json(), identity), { status: response.status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        }
        const forwarded = new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        if (path !== "/" || !response.ok) return forwarded;
        return new HTMLRewriter().on("head", { element(element) { element.prepend(initialConsolePreference, { html: true }); } }).transform(forwarded);
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
  async function openPaja(token: string): Promise<string> {
    const grant = await input.grants.authorize({ token, path: "index.html" }); const artifact = grant && await input.repository.get(grant.artifactId);
    if (!artifact) throw new Error("PREVIEW_GRANT_UNAVAILABLE");
    return openTarget(`${url}/preview/${encodeURIComponent(token)}/index.html`, pajaWindowIdentity(artifact));
  }
  return Object.freeze({ url, openTarget, handlePublic, openPaja, async close(): Promise<void> { await Promise.all(hosts.map((host) => host.close())); server.stop(true); } });
}
