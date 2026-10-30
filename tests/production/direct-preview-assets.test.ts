import { expect, test } from "bun:test";
import { createProductionDirectPreviewAssets } from "../../src/production/direct-preview-assets";

test("prepared public preview module serves its actual immutable bundle identity and no other source paths", async () => {
  const assets = await createProductionDirectPreviewAssets();
  const response = await assets.handle(new Request(`https://static.example${assets.metadata.assetPath}`));
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(assets.metadata.sha256);
  expect(response.headers.get("x-napplet-preview-sha256")).toBe(assets.metadata.sha256);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  expect(await (await assets.handle(new Request("https://static.example/static/nip5d-direct-v1/preview-host.json"))).json()).toEqual(assets.metadata);
  for (const request of [new Request("https://static.example/static/source.ts"), new Request(`https://static.example${assets.metadata.assetPath}?path=source.ts`),
    new Request(`https://static.example${assets.metadata.assetPath}`, { method: "POST" })]) {
    const refused = await assets.handle(request);
    expect(refused.status).toBe(404); expect(await refused.json()).toEqual({ code: "STATIC_NOT_CONFIGURED" });
  }
});
