import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { z } from "zod";

const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const limit = 2_000_000;
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "Authorization, Content-Type, X-SHA-256, Range, *", "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS", "access-control-expose-headers": "Content-Length, Content-Type, Content-Range, Accept-Ranges, X-Reason", "access-control-max-age": "86400" };
const descriptor = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative().max(limit), type: z.string().max(128), uploaded: z.number().int().positive() }).strict();
export async function boundedBytes(body: ReadableStream<Uint8Array> | null, maximum = limit) {
  if (!body) return new Uint8Array(); const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maximum) throw new Error("BLOB_TOO_LARGE"); chunks.push(part.value); } return new Uint8Array(Buffer.concat(chunks)); }
  finally { await reader.cancel().catch(() => undefined); }
}
/** BUD-01/02/04/11. No public write credential: only this CVM's key may upload
 * or mirror. Generated applets never receive it. Immutable bytes by sha256. */
export class CvmBlossom {
  constructor(private readonly root: string, readonly pubkey: string, private readonly origin: () => string) {}
  private response(body: BodyInit | null, status = 200, headers: Record<string,string> = {}) { return new Response(body, { status, headers: { ...cors, ...headers, "x-content-type-options": "nosniff" } }); }
  private failure(status: number, reason: string) { return this.response(JSON.stringify({ message: reason }), status, { "content-type": "application/json", "x-reason": reason }); }
  private authorize(request: Request, digest?: string): Event | undefined {
    try {
      const encoded = /^Nostr ([A-Za-z0-9_+/=-]{1,32000})$/.exec(request.headers.get("authorization") ?? "")?.[1]; if (!encoded) return;
      const event = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Event;
      const now = Math.floor(Date.now() / 1000);
      if (event.pubkey !== this.pubkey || event.kind !== 24242 || !verifyEvent(event) || !Number.isSafeInteger(event.created_at) || event.created_at > now || event.created_at < now - 86400) return;
      const tags = (name: string) => event.tags.filter(tag => tag[0] === name).map(tag => tag[1]);
      const expiry = tags("expiration");
      if (tags("t").length !== 1 || tags("t")[0] !== "upload" || expiry.length !== 1 || !/^\d+$/.test(expiry[0] ?? "") || Number(expiry[0]) <= now) return;
      const servers = tags("server"); if (servers.length && !servers.includes(new URL(this.origin()).hostname)) return;
      if (!tags("x").some(value => /^[a-f0-9]{64}$/.test(value ?? "")) || (digest && !tags("x").includes(digest))) return;
      return event;
    } catch { return; }
  }
  private async store(bytes: Uint8Array, type: string) {
    const sha256 = hash(bytes); const directory = resolve(this.root, "blobs"); await mkdir(directory, { recursive: true, mode: 0o700 });
    let exists = false; let meta: z.infer<typeof descriptor>;
    try { meta = descriptor.parse(JSON.parse(await readFile(resolve(directory, `${sha256}.json`), "utf8"))); exists = true; }
    catch (error) { if ((error as any).code !== "ENOENT") throw error; meta = { sha256, size: bytes.length, type: /^[\w.+-]+\/[\w.+-]+(?:;[\w= .-]+)?$/.test(type) ? type : "application/octet-stream", uploaded: Math.floor(Date.now() / 1000) }; }
    const temp = resolve(directory, `${sha256}.${crypto.randomUUID()}.tmp`);
    await writeFile(temp, bytes, { flag: "wx", mode: 0o400 }); await rename(temp, resolve(directory, sha256));
    const metaTemp = `${temp}.json`; await writeFile(metaTemp, JSON.stringify(meta), { flag: "wx", mode: 0o400 }); await rename(metaTemp, resolve(directory, `${sha256}.json`));
    const extension = ({ "text/html": "html", "text/javascript": "js", "text/css": "css", "application/json": "json", "image/svg+xml": "svg" } as Record<string,string>)[meta.type.split(";")[0]!] ?? "bin";
    return this.response(JSON.stringify({ ...meta, url: `${this.origin()}/${sha256}.${extension}` }), exists ? 200 : 201, { "content-type": "application/json" });
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return this.response(null, 204);
    try {
      if ((url.pathname === "/upload" && ["PUT", "HEAD"].includes(request.method)) || (url.pathname === "/mirror" && request.method === "PUT")) {
        const supplied = request.headers.get("x-sha-256") ?? undefined;
        const auth = this.authorize(request, supplied);
        if (!auth) return this.failure(403, "Only the CVM may upload or mirror here");
        if (request.method === "HEAD") return this.response(null);
        if (Number(request.headers.get("content-length") ?? "0") > limit) return this.failure(413, "Blob exceeds size limit");
        let bytes: Uint8Array; let type = request.headers.get("content-type") ?? "application/octet-stream";
        if (url.pathname === "/mirror") {
          const body = z.object({ url: z.string().url().max(2048) }).strict().parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body, 4096))));
          const source = new URL(body.url); const expected = /(?:^|\/)([a-f0-9]{64})(?:\.[a-z0-9]+)?$/.exec(source.pathname)?.[1];
          if (!["http:", "https:"].includes(source.protocol) || source.username || source.password || !expected || !auth.tags.some(tag => tag[0] === "x" && tag[1] === expected)) return this.failure(400, "Invalid mirror URL or hash");
          const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(15000) });
          if (!response.ok) return this.failure(502, "Source blob unavailable");
          type = response.headers.get("content-type") ?? "application/octet-stream"; bytes = await boundedBytes(response.body);
          if (hash(bytes) !== expected) return this.failure(409, "Source hash mismatch");
        } else bytes = await boundedBytes(request.body);
        const digest = hash(bytes);
        if ((supplied && supplied !== digest) || !auth.tags.some(tag => tag[0] === "x" && tag[1] === digest)) return this.failure(409, "Blob hash mismatch");
        return await this.store(bytes, type);
      }
      const match = /^\/([a-f0-9]{64})(?:\.[a-zA-Z0-9]+)?$/.exec(url.pathname);
      if (match && ["GET", "HEAD"].includes(request.method)) {
        const digest = match[1]!; const meta = descriptor.parse(JSON.parse(await readFile(resolve(this.root, "blobs", `${digest}.json`), "utf8")));
        const bytes = await readFile(resolve(this.root, "blobs", digest)); if (hash(bytes) !== digest || bytes.length !== meta.size) return this.failure(503, "Blob unavailable");
        const headers = { "content-type": meta.type, "content-length": String(bytes.length), "accept-ranges": "bytes", "cache-control": "public, max-age=31536000, immutable", "content-security-policy": "sandbox allow-scripts; default-src 'self' blob: data:; connect-src 'none'" };
        const range = request.headers.get("range");
        if (range && request.method === "GET") {
          const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!parts || (!parts[1] && !parts[2])) return this.failure(416, "Invalid range");
          const start = parts[1] ? Number(parts[1]) : Math.max(0, bytes.length - Number(parts[2]));
          const end = parts[1] && parts[2] ? Math.min(Number(parts[2]), bytes.length - 1) : bytes.length - 1;
          if (start > end || start >= bytes.length) return this.response(null, 416, { "content-range": `bytes */${bytes.length}` });
          return this.response(bytes.subarray(start, end + 1), 206, { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${bytes.length}` });
        }
        return this.response(request.method === "HEAD" ? null : bytes, 200, headers);
      }
      if (url.pathname === "/" && request.method === "GET") return this.response(JSON.stringify({ name: "applet.broker CVM Blossom", supported_buds: [1, 2, 4, 11], pubkey: this.pubkey }), 200, { "content-type": "application/json" });
      return this.failure(404, "Not found");
    } catch (error) { return this.failure((error as Error).message === "BLOB_TOO_LARGE" ? 413 : (error as any).code === "ENOENT" ? 404 : 400, "Blob request rejected"); }
  }
}
