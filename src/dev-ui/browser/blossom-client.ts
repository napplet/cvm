import { SimplePool } from "nostr-tools/pool";
import { verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { createUploadAuthorization } from "../../../infra/vendor/napplet-cli/bundle/entry.js";

export type BlobFile = { path: string; sha256: string; bytes: number; url: string; type: string };
export type Propagation = { server: string; file: string; state: "checking" | "signing" | "mirroring" | "uploading" | "verified" | "failed"; detail?: string };
export function blossomServer(value: string): string {
  const raw = value.trim();
  if (raw.length > 512 || /[\s\\]/u.test(raw)) throw new Error("Enter one Blossom server address, such as https://blossom.example.com.");
  let url: URL; try { url = new URL(raw); } catch { throw new Error("Enter a Blossom server address, such as https://blossom.example.com."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Enter a Blossom server address, such as https://blossom.example.com.");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Use HTTPS for a public Blossom server.");
  return url.origin;
}
export async function discoverBlossom(pubkey: string, relays: string[]): Promise<string[]> {
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays, { kinds: [10063], authors: [pubkey], limit: 5 }, { maxWait: 6000 });
    const latest = events.filter(event => event.kind === 10063 && event.pubkey === pubkey && event.created_at <= Date.now() / 1000 + 60 && verifyEvent(event)).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
    const servers: string[] = [];
    for (const tag of latest?.tags ?? []) if (tag[0] === "server" && tag[1]) { try { const url = blossomServer(tag[1]); if (!servers.includes(url)) servers.push(url); } catch { /* Invalid list entry is not a destination. */ } }
    return servers.slice(0, 5);
  } finally { pool.close(relays); pool.destroy(); }
}
async function bytes(response: Response, expected: BlobFile): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`Blob unavailable (${response.status})`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > expected.bytes || size > 2000000) throw new Error("Blob size did not match"); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (size !== expected.bytes || digest !== expected.sha256) throw new Error("Blob integrity check failed"); return data;
}
const request = (url: string, options: RequestInit = {}) => fetch(url, { ...options, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(20000) });
/** Runs in the user's client. The CVM never receives user upload authorizations.
 * Verify destination bytes, not just upload acknowledgements or HEAD responses. */
export async function propagateBlobs(files: BlobFile[], servers: string[], signer: { sign(template: EventTemplate): Promise<Event> }, progress: (event: Propagation) => void): Promise<boolean> {
  let complete = true; const source = new Map<string, Uint8Array>();
  for (const raw of servers) {
    const server = blossomServer(raw); let authorization: string | undefined;
    for (const file of files) {
      const report = (state: Propagation["state"], detail?: string) => progress({ server, file: file.path, state, detail });
      try {
        report("checking");
        try { await bytes(await request(`${server}/${file.sha256}`), file); report("verified"); continue; } catch { /* Missing or damaged destination: copy verified source bytes. */ }
        if (!authorization) { report("signing"); authorization = await createUploadAuthorization(signer, files.map(file => file.sha256), undefined, new URL(server).hostname); }
        report("mirroring"); let mirrored = false;
        try {
          const result = await request(`${server}/mirror`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ url: file.url }) });
          if ([401, 402, 403, 413, 415, 429].includes(result.status)) throw new Error(`Server declined copy (${result.status})`);
          if (result.ok) { await bytes(await request(`${server}/${file.sha256}`), file); mirrored = true; }
        } catch (error) { if (error instanceof Error && error.message.startsWith("Server declined")) throw error; }
        // Public servers cannot fetch loopback development URLs. The browser
        // can upload the same hash-verified bytes when /mirror is unavailable.
        if (!mirrored) {
          report("uploading");
          let data = source.get(file.sha256); if (!data) { data = await bytes(await request(file.url), file); source.set(file.sha256, data); }
          const result = await request(`${server}/upload`, { method: "PUT", headers: { authorization, "content-type": file.type, "x-sha-256": file.sha256 }, body: new Uint8Array(data).buffer });
          if (!result.ok) throw new Error(`Server declined upload (${result.status})`);
          await bytes(await request(`${server}/${file.sha256}`), file);
        }
        report("verified");
      } catch (error) { complete = false; report("failed", error instanceof Error ? error.message : "Server unavailable"); }
    }
  }
  return complete;
}
