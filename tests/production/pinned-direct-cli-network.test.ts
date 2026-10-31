import { expect, test } from "bun:test";
import { finalizeEvent, getPublicKey, verifyEvent, type EventTemplate } from "nostr-tools/pure";
import { loadPinnedDirectCliNetworkHelpers, DIRECT_CLI_NETWORK_IDENTITY } from "../../src/production/pinned-direct-cli-network";
import { loadPinnedCliNetworkHelpers, CLI_NETWORK_HELPER_SHA256 } from "../../src/production/pinned-cli-network";

const key = new Uint8Array(32).fill(41), server = "https://publication.example", now = Math.floor(Date.now() / 1000);
const data = new TextEncoder().encode("<!doctype html><main>actual typed CLI source probe</main>"), hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
const file = { candidateDir: "sealed", path: "/index.html", sha256: hash, data, contentType: "text/html" };
const signed = (template: EventTemplate) => finalizeEvent(structuredClone(template), key);
const expectedTags = [["t", "upload"], ["x", hash], ["expiration", String(now + 3600)], ["client", "napplet"], ["server", "publication.example"]];

test("distinct direct helper preserves historical bytes and builds the actual scoped upstream authorization", async () => {
  const direct = await loadPinnedDirectCliNetworkHelpers(), legacy = await loadPinnedCliNetworkHelpers();
  expect(direct.identity).toEqual(DIRECT_CLI_NETWORK_IDENTITY);
  expect(Object.keys(legacy).sort()).toEqual(["publishEventWithSimplePool", "uploadFilesToServers"]);
  expect(new Bun.CryptoHasher("sha256").update(await Bun.file("vendor/napplet-cli-976ad054/network-helpers.mjs").bytes()).digest("hex")).toBe(CLI_NETWORK_HELPER_SHA256);
  let signs = 0;
  const token = await direct.createUploadAuthorization({ async sign(template) { signs++; expect(template.tags).toEqual(expectedTags); return signed(template); } }, [hash], now, "publication.example");
  const event = JSON.parse(Buffer.from(token.slice(6), "base64url").toString("utf8"));
  expect(verifyEvent(event)).toBeTrue(); expect(event.pubkey).toBe(getPublicKey(key)); expect(event.kind).toBe(24242); expect(event.tags).toEqual(expectedTags); expect(signs).toBe(1);
  for (const host of ["", "publication.example/path", "publication.example:443", "user@publication.example"]) {
    await expect(direct.createUploadAuthorization({ async sign(template) { signs++; return signed(template); } }, [hash], now, host)).rejects.toThrow();
  }
  await expect(direct.createUploadAuthorization({ async sign(template) { signs++; return signed(template); } }, [hash, hash], now, "publication.example")).rejects.toThrow();
  expect(signs).toBe(1);
});

test("actual direct CLI uploads provided bytes with scoped authorization and checks the returned descriptor", async () => {
  const helpers = await loadPinnedDirectCliNetworkHelpers(); let signs = 0; const methods: string[] = [];
  const transport: typeof fetch = Object.assign(async (resource: Parameters<typeof fetch>[0], init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "HEAD") { expect(String(resource)).toBe(`${server}/${hash}`); return new Response(null, { status: 404 }); }
    expect(String(resource)).toBe(`${server}/upload`); expect(init?.method).toBe("PUT");
    if (!(init?.body instanceof Blob)) throw new Error("ACTUAL_CLI_BLOB_REQUIRED");
    expect(new Uint8Array(await init.body.arrayBuffer())).toEqual(data);
    const headers = new Headers(init.headers); expect(headers.get("x-sha-256")).toBe(hash);
    const token = headers.get("authorization"); if (!token) throw new Error("ACTUAL_CLI_AUTHORIZATION_REQUIRED");
    const event = JSON.parse(Buffer.from(token.slice(6), "base64url").toString("utf8"));
    expect(verifyEvent(event)).toBeTrue(); expect(event.tags).toEqual(expectedTags);
    return Response.json({ sha256: hash }, { status: 201 });
  }, { preconnect: fetch.preconnect });
  const result = await helpers.uploadFilesToServers([file], [server], { async sign(template) { signs++; return signed(template); } }, { now: () => now, fetch: transport });
  expect(result).toEqual([{ server, file: "/index.html", sha256: hash, success: true, skipped: false }]); expect(methods).toEqual(["HEAD", "PUT"]); expect(signs).toBe(1);
  const invalidDescriptor: typeof fetch = Object.assign(async (_resource: Parameters<typeof fetch>[0], init?: RequestInit) => init?.method === "HEAD" ? new Response(null, { status: 404 }) : Response.json({ sha256: "0".repeat(64) }), { preconnect: fetch.preconnect });
  expect((await helpers.uploadFilesToServers([file], [server], { async sign(template) { return signed(template); } }, { now: () => now, fetch: invalidDescriptor }))[0]?.success).toBeFalse();
});

test("actual upstream auth fallback is stopped by an exact signer before an unscoped signature or second PUT", async () => {
  const helpers = await loadPinnedDirectCliNetworkHelpers(); let attempts = 0, scopedSigns = 0, puts = 0;
  const transport: typeof fetch = Object.assign(async (_resource: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    puts++; return new Response("authorization server scope mismatch", { status: 401 });
  }, { preconnect: fetch.preconnect });
  await expect(helpers.uploadFilesToServers([file], [server], { async sign(template) {
    attempts++;
    if (JSON.stringify(template.tags) !== JSON.stringify(expectedTags)) throw new Error("UPLOAD_AUTH_SCOPE_DOWNGRADE_DENIED");
    scopedSigns++; return signed(template);
  } }, { now: () => now, fetch: transport })).rejects.toThrow("SCOPE_DOWNGRADE_DENIED");
  expect(attempts).toBe(2); expect(scopedSigns).toBe(1); expect(puts).toBe(1);
});

test("upstream positive HEAD is only a transport hint and skips signing; a production adapter must verify actual bytes", async () => {
  const helpers = await loadPinnedDirectCliNetworkHelpers(); let signs = 0; const methods: string[] = [];
  const transport: typeof fetch = Object.assign(async (_resource: Parameters<typeof fetch>[0], init?: RequestInit) => { methods.push(init?.method ?? "GET"); return new Response(null, { status: 200 }); }, { preconnect: fetch.preconnect });
  const result = await helpers.uploadFilesToServers([file], [server], { async sign(template) { signs++; return signed(template); } }, { now: () => now, fetch: transport });
  expect(result[0]).toMatchObject({ success: true, skipped: true }); expect(signs).toBe(0); expect(methods).toEqual(["HEAD"]);
});

test("pinned direct CLI functions use actual local HTTP and Nostr WebSocket transports", async () => {
  const helpers = await loadPinnedDirectCliNetworkHelpers(); let puts = 0, publishes = 0;
  const blobs = new Map<string, Uint8Array>();
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, runtime) {
    const url = new URL(request.url);
    if (url.pathname === "/relay" && runtime.upgrade(request)) return;
    if (request.method === "HEAD") return new Response(null, { status: blobs.has(url.pathname.slice(1)) ? 200 : 404 });
    if (request.method === "PUT" && url.pathname === "/upload") {
      const token = request.headers.get("authorization"); if (!token?.startsWith("Nostr ")) return new Response("missing", { status: 401 });
      const event = JSON.parse(Buffer.from(token.slice(6), "base64url").toString("utf8"));
      expect(verifyEvent(event)).toBeTrue(); expect(event.pubkey).toBe(getPublicKey(key));
      expect(event.tags.filter((tag: string[]) => tag[0] === "server")).toEqual([["server", "127.0.0.1"]]);
      const bytes = new Uint8Array(await request.arrayBuffer()); expect(bytes).toEqual(data);
      const checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      expect(checksum).toBe(hash); expect(request.headers.get("x-sha-256")).toBe(hash);
      puts++; blobs.set(hash, bytes); return Response.json({ sha256: checksum }, { status: 201 });
    }
    return new Response("missing", { status: 404 });
  }, websocket: { message(socket, raw) {
    const message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (message[0] === "EVENT") { expect(verifyEvent(message[1])).toBeTrue(); publishes++; socket.send(JSON.stringify(["OK", message[1].id, true, ""])); }
  } } });
  try {
    const target = fixture.url.origin, relay = target.replace("http:", "ws:") + "/relay";
    const uploaded = await helpers.uploadFilesToServers([file], [target], { async sign(template) { return signed(template); } }, { now: () => now, fetch });
    expect(uploaded[0]).toMatchObject({ success: true, skipped: false }); expect(puts).toBe(1);
    const event = signed({ kind: 1, created_at: now, content: "local typed source transport fixture", tags: [] });
    expect(await helpers.publishEventWithSimplePool([relay], event)).toEqual([{ relay, eventId: event.id, success: true }]);
    expect(publishes).toBe(1); expect(blobs.get(hash)).toEqual(data);
  } finally { await fixture.stop(true); }
});
