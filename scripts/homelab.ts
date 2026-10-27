import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Private homelab runtime, retaining the existing test-credit composition.
// Only this service's dedicated engine is reachable through DOCKER_HOST.
const root = resolve(import.meta.dir, "..");
await mkdir(process.env.TMPDIR ?? "/scratch", { recursive: true, mode: 0o700 });
const publicOrigin = new URL(process.env.NAPPLET_CVM_PUBLIC_ORIGIN!);
const previewOrigin = new URL(process.env.NAPPLET_CVM_PREVIEW_PUBLIC_ORIGIN!);
const blossomOrigin = new URL(process.env.NAPPLET_CVM_BLOSSOM_PUBLIC_URL!);
if (publicOrigin.protocol !== "https:" || blossomOrigin.protocol !== "https:") throw new Error("HOMELAB_HTTPS_REQUIRED");
let record: { url: string; pid: number } | undefined;
let config: { relayUrl: string } | undefined;
let blossomPort: number | undefined;
type Peer = { upstream?: WebSocket; pending: Array<string | Buffer> };
const gateway = Bun.serve<Peer>({
  hostname: "0.0.0.0", port: 8080,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (!record || !config) return new Response("CVM is starting", { status: 503 });
    const previewPath = url.pathname.startsWith('/cvm-preview/') || url.pathname.startsWith('/cvm-artifacts/');
    if ((url.hostname === previewOrigin.hostname) !== previewPath) return new Response('not found', { status: 404 });
    if (url.pathname === "/relay" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (server.upgrade(request, { data: { pending: [] } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    const blob = url.hostname === blossomOrigin.hostname;
    const base = blob ? `http://127.0.0.1:${blossomPort}` : record.url;
    // The request URL and Host are rebuilt from a fixed loopback listener.
    const headers = new Headers(request.headers); headers.delete("host"); headers.delete("connection"); headers.delete("upgrade");
    try {
      return await fetch(new URL(url.pathname + url.search, base), { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    } catch { return new Response("CVM unavailable", { status: 502 }); }
  },
  websocket: {
    open(socket) {
      const upstream = new WebSocket(config!.relayUrl); socket.data.upstream = upstream;
      upstream.onopen = () => { for (const message of socket.data.pending) upstream.send(message); socket.data.pending.length = 0; };
      upstream.onmessage = event => socket.send(typeof event.data === "string" ? event.data : Buffer.from(event.data));
      upstream.onclose = () => socket.close(); upstream.onerror = () => socket.close(1011, "relay unavailable");
    },
    message(socket, message) {
      if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(message);
      else if (socket.data.pending.length < 32) socket.data.pending.push(message);
      else socket.close(1009, "relay starting");
    },
    close(socket) { socket.data.upstream?.close(); },
    maxPayloadLength: 2_000_000,
  },
});
const child = Bun.spawn([process.execPath, "scripts/dev.ts", "up"], { cwd: root, stdout: "pipe", stderr: "inherit" });
const output = await new Response(child.stdout).text();
if (await child.exited !== 0) process.exit(1);
record = JSON.parse(output.trim().split("\n").at(-1)!);
config = await Bun.file(resolve(root, ".local/napplet-cvm-dev-payments/payments.json")).json();
blossomPort = (await Bun.file(resolve(root, ".local/development-published/origin.json")).json()).port;
console.log(JSON.stringify({ ready: true, origin: publicOrigin.origin, mode: "private-homelab-test-credits" }));
const timer = setInterval(async () => {
  try { process.kill(record!.pid, 0); if (!(await fetch(record!.url + "/health", { signal: AbortSignal.timeout(5000) })).ok) process.exit(1); }
  catch { process.exit(1); }
}, 15_000);
async function stop() { clearInterval(timer); gateway.stop(true); if (record?.pid) process.kill(record.pid, "SIGTERM"); process.exit(0); }
process.once("SIGTERM", stop); process.once("SIGINT", stop);
