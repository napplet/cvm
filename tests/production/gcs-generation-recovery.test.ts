import { expect, test } from "bun:test";
import { createProductionGcsObjectClient } from "../../src/production/gcs-object-client";
import { GcsObjectStoreAdapter } from "../../src/continuity/object-store";

const bytes = new TextEncoder().encode("retained original encrypted bytes");
const checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const reference = { key: "checkpoints/original", generation: 1, checksum };
function setup(respond: (url: URL, init?: RequestInit) => Response) {
  const client = createProductionGcsObjectClient({ bucket: "checkpoint-fixture", tokenSource: { async getAccessToken() { return { token: "test-only-token", projectId: "test-project", quotaProjectId: "test-project", principal: "test-operator", scopes: [], accountScopeSha256: "a".repeat(64), expiresAtMs: Date.now() + 60_000 }; } },
    fetch: Object.assign(async (raw: Parameters<typeof fetch>[0], init?: RequestInit) => respond(new URL(raw instanceof Request ? raw.url : raw), init), { preconnect() {} }),
  });
  return new GcsObjectStoreAdapter({ config: { bucket: "checkpoint-fixture", projectId: "test-project" }, client });
}
const meta = () => Response.json({ generation: "1", metadata: { sha256: checksum } });

test("exact-generation absence requires provider 404, never denied, unavailable or malformed metadata", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const store = setup(() => new Response("unavailable", { status }));
    await expect(store.readExact(reference)).rejects.toThrow("GCS_METADATA_UNAVAILABLE");
    await expect(store.observeExactByKey(reference)).rejects.toThrow("GCS_METADATA_UNAVAILABLE");
  }
  await expect(setup(() => Response.json({ generation: "invalid" })).readExact(reference)).rejects.toThrow("GCS_OBJECT_METADATA_INVALID");
  expect(await setup(() => new Response(null, { status: 404 })).readExact(reference)).toBeUndefined();
  const unavailableMedia = setup(url => url.searchParams.has("alt") ? new Response("unavailable", { status: 503 }) : meta());
  await expect(unavailableMedia.readExact(reference)).rejects.toThrow("GCS_OBJECT_READ_UNAVAILABLE");
  const corruptMedia = setup(url => url.searchParams.has("alt") ? new Response("corrupt bytes") : meta());
  await expect(corruptMedia.readExact(reference)).rejects.toThrow("OBJECT_EXACT_GENERATION_REQUIRED");
});

test("read and delete address the original noncurrent generation, preserving a newer object", async () => {
  let deleted = false, deletions = 0;
  const store = setup((url, init) => {
    if (!url.searchParams.has("generation")) return Response.json({ generation: "2", metadata: { sha256: "b".repeat(64) } });
    expect(url.searchParams.get("generation")).toBe("1");
    if (init?.method === "DELETE") {
      expect(url.searchParams.get("ifGenerationMatch")).toBe("1");
      deleted = true; deletions++;
      return new Response(null, { status: 204 });
    }
    if (deleted) return new Response(null, { status: 404 });
    return url.searchParams.has("alt") ? new Response(bytes, { headers: { "x-goog-generation": "1" } }) : meta();
  });
  expect(await store.observeExactByKey(reference)).toBeUndefined(); // Current is generation 2.
  expect(await store.readExact(reference)).toEqual(bytes);
  await store.scheduleExactDeletion(reference, new Date(Date.now() - 1000).toISOString());
  expect(await store.readExact(reference)).toBeUndefined();
  expect(await store.observeExactByKey({ key: reference.key, checksum: "b".repeat(64) })).toEqual({ key: reference.key, generation: 2, checksum: "b".repeat(64) });
  expect(deletions).toBe(1);
});
