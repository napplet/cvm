import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createProductionGcsObjectClient } from "../../src/production/gcs-object-client";
import { GOOGLE_CONTROL_PLANE_SCOPES } from "../../src/release/deployment/google-auth";

for (const match of [true, false]) {
  test(`production GCS immutable collision ${match ? "adopts the checksum-matched original" : "rejects a foreign checksum"}`, async () => {
    const bytes = new TextEncoder().encode("original report");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const calls: Array<{ url: string; method: string }> = [];
    const client = createProductionGcsObjectClient({ bucket: "release-evidence", tokenSource: {
      async getAccessToken() { return { token: "offline-storage-token", projectId: "project-12345", quotaProjectId: "project-12345", principal: "release@example.com", scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256: "a".repeat(64), expiresAtMs: Date.now() + 60_000 }; },
    }, fetch: Object.assign(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push({ url: url.toString(), method: init.method ?? "GET" });
      expect(url.origin).toBe("https://storage.googleapis.com");
      expect(init.redirect).toBe("error");
      if (init.method === "POST") {
        expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
        return new Response(null, { status: 412 });
      }
      expect(url.pathname).toBe("/storage/v1/b/release-evidence/o/authoritative-usage%2Foriginal%2Freport.json");
      return Response.json({ generation: "7", metadata: { sha256: match ? checksum : "b".repeat(64) } });
    }, { preconnect: fetch.preconnect }) });
    const creation = client.createIfAbsent({ key: "authoritative-usage/original/report.json", bytes, checksum });
    if (match) expect(await creation).toEqual({ generation: 7, checksum });
    else await expect(creation).rejects.toThrow("GCS_OBJECT_IMMUTABLE_CONFLICT");
    expect(calls.map(value => value.method)).toEqual(["POST", "GET"]);
  });
}
