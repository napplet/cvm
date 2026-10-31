import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packages = Object.freeze({ "@kehto/runtime": "0.24.1", "@kehto/shell": "0.22.0", "@napplet/core": "0.32.0", "@napplet/nap": "0.32.0" });
const assetPath = "/static/nip5d-direct-v1/preview-host.js";
/** Fixed source only; caller/source/model data cannot select an entrypoint or
 * dependency. The public bundle has no service or owner signing material. */
export async function createProductionDirectPreviewAssets() {
  for (const [name, version] of Object.entries(packages)) {
    const actual = z.object({ name: z.literal(name), version: z.literal(version) }).passthrough();
    const entry = name === "@napplet/nap" ? import.meta.resolve("@napplet/nap/storage") : import.meta.resolve(name);
    actual.parse(JSON.parse(await readFile(new URL(name === "@napplet/nap" ? "../../package.json" : "../package.json", entry), "utf8")));
  }
  const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("../publication/direct-preview-host.ts", import.meta.url))], target: "browser", minify: true, env: "disable" });
  if (!built.success || built.outputs.length !== 1) throw new Error("PRODUCTION_DIRECT_PREVIEW_BUILD_REQUIRED");
  const bytes = new Uint8Array(await built.outputs[0]!.arrayBuffer());
  if (!bytes.length || bytes.length > 2_097_152) throw new Error("PRODUCTION_DIRECT_PREVIEW_ASSET_LIMIT");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const metadata = Object.freeze({ version: "direct-preview-host-v1", assetPath, sha256, packages, liveDomains: Object.freeze(["storage"]) });
  return Object.freeze({ metadata, async handle(request: Request): Promise<Response> {
    const url = new URL(request.url), headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "access-control-allow-origin": "*" };
    if (request.method === "GET" && !url.search && !url.hash) {
      if (url.pathname === assetPath) return new Response(bytes, { headers: { ...headers, "content-type": "application/javascript; charset=utf-8", "x-napplet-preview-sha256": sha256 } });
      if (url.pathname === "/static/nip5d-direct-v1/preview-host.json") return Response.json(metadata, { headers });
    }
    return Response.json({ code: "STATIC_NOT_CONFIGURED" }, { status: 404, headers });
  } });
}
