import { extname } from "node:path";
import type { LocalArtifactRepository } from "../dev/local-artifact-repository";
import type { LocalPreviewGrantStore } from "../dev/local-preview-grant-store";

const mime = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"]]);
export type PreviewServer = Readonly<{ url: string; openPaja(token: string): Promise<string>; close(): Promise<void> }>;
/** Static/opaque-grant boundary only. There are deliberately no application commands here. */
export async function createPreviewServer(input: Readonly<{ repository: LocalArtifactRepository; grants: LocalPreviewGrantStore; paja: Readonly<{ startPajaServer(options: unknown): Promise<{ url: string; close(): Promise<void> }>; domains: readonly string[] }> }>): Promise<PreviewServer> {
  const hosts: Array<{ close(): Promise<void> }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); if (url.pathname === "/health") return Response.json({ status: "ok" });
    const match = /^\/preview\/([A-Za-z0-9]+)\/(.+)$/u.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    const grant = await input.grants.authorize({ token: match[1]!, path: decodeURIComponent(match[2]!) }); if (!grant) return new Response("not found", { status: 404 });
    const stored = await input.repository.read({ artifactId: grant.artifactId, path: decodeURIComponent(match[2]!) }); if (!stored) return new Response("not found", { status: 404 });
    return new Response(stored.bytes, { headers: { "content-type": mime.get(extname(stored.file.path)) ?? "application/octet-stream", "cache-control": "private, no-store", "access-control-allow-origin": "null", "cross-origin-resource-policy": "cross-origin", "x-content-type-options": "nosniff" } });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  return Object.freeze({ url, async openPaja(token: string): Promise<string> {
    const targetUrl = `${url}/preview/${encodeURIComponent(token)}/index.html`;
    const host = await input.paja.startPajaServer({ options: { host: "127.0.0.1", port: 0, targetUrl, simulation: { capabilities: { domains: Object.fromEntries(input.paja.domains.map((domain) => [domain, false])) }, acl: { mode: "deny" }, firewall: { mode: "deny" }, identity: { mode: "anonymous" }, relay: { mode: "disabled" }, storage: { mode: "disabled" }, cache: { mode: "disabled" }, upload: { mode: "disabled" }, media: { enabled: false }, notifications: { enabled: false, grant: false }, intent: { enabled: false }, cvm: { enabled: false } } } });
    hosts.push(host);
    return host.url;
  }, async close(): Promise<void> { await Promise.all(hosts.map((host) => host.close())); server.stop(true); } });
}
