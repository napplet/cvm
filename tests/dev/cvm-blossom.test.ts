import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { CvmBlossom } from "../../src/dev/cvm-blossom";
import { createUploadAuthorization } from "../../infra/vendor/napplet-cli/bundle/entry.js";

test("Blossom serves exact bytes, MIME, HEAD/ranges and CORS; only the CVM can upload or mirror", async () => {
  const root = await mkdtemp(join(tmpdir(), "cvm-blossom-")); const key = generateSecretKey(); const other = generateSecretKey();
  const service = new CvmBlossom(root, getPublicKey(key), () => "http://127.0.0.1:50000");
  const data = new TextEncoder().encode("<h1>Applet</h1>"); const digest = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  const auth = async (secret = key, hashes = [digest]) => createUploadAuthorization({ sign: async template => finalizeEvent(template, secret) }, hashes, undefined, "127.0.0.1");
  const upload = (authorization?: string, bytes = data) => service.handle(new Request("http://127.0.0.1:50000/upload", { method: "PUT", headers: { ...(authorization ? { authorization } : {}), "content-type": "text/html", "x-sha-256": digest }, body: bytes }));
  let origin: ReturnType<typeof Bun.serve> | undefined;
  try {
    expect((await upload()).status).toBe(403); expect((await upload(await auth(other))).status).toBe(403);
    expect((await upload(await auth(key, ["a".repeat(64)]))).status).toBe(403);
    expect((await upload(await auth(), new TextEncoder().encode("different"))).status).toBe(409);
    const first = await upload(await auth()); expect(first.status).toBe(201); const meta = await first.json(); expect(meta.sha256).toBe(digest); expect(meta.url).toEndWith(".html");
    expect((await upload(await auth())).status).toBe(200);
    const response = await service.handle(new Request(`http://127.0.0.1:50000/${digest}.txt`)); expect(await response.text()).toBe("<h1>Applet</h1>"); expect(response.headers.get("content-type")).toBe("text/html");
    const head = await service.handle(new Request(`http://127.0.0.1:50000/${digest}`, { method: "HEAD" })); expect(head.headers.get("content-length")).toBe(String(data.length)); expect(await head.text()).toBe("");
    const range = await service.handle(new Request(`http://127.0.0.1:50000/${digest}`, { headers: { range: "bytes=4-9" } })); expect(range.status).toBe(206); expect(await range.text()).toBe("Applet");
    const options = await service.handle(new Request("http://127.0.0.1:50000/mirror", { method: "OPTIONS" })); expect(options.headers.get("access-control-allow-origin")).toBe("*"); expect(options.headers.get("access-control-allow-methods")).toContain("PUT");
    const missing = await service.handle(new Request(`http://127.0.0.1:50000/${"b".repeat(64)}`)); expect(missing.status).toBe(404); expect(missing.headers.get("access-control-allow-origin")).toBe("*");
    const mirrorData = new TextEncoder().encode("mirrored bytes"); const mirrorHash = new Bun.CryptoHasher("sha256").update(mirrorData).digest("hex");
    let reads = 0; origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { reads++; return new Response(mirrorData); } });
    const mirror = (authorization?: string) => service.handle(new Request("http://127.0.0.1:50000/mirror", { method: "PUT", headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" }, body: JSON.stringify({ url: `http://127.0.0.1:${origin!.port}/${mirrorHash}` }) }));
    expect((await mirror(await auth(other, [mirrorHash]))).status).toBe(403); expect(reads).toBe(0);
    expect((await mirror(await auth(key, [mirrorHash]))).status).toBe(201); expect(reads).toBe(1);
    expect(await (await service.handle(new Request(`http://127.0.0.1:50000/${mirrorHash}`))).text()).toBe("mirrored bytes");
  } finally { origin?.stop(true); await rm(root, { recursive: true, force: true }); }
});
