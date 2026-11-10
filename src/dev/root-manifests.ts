import { resolve } from "node:path";

const manifestPins = Object.freeze({
  "package.json": "f81ff7825d98e653b77457b8f778cbc05596286712aa1b6eec0c693a641b9834",
  "bun.lock": "eb9424c906e9dcd5960f97b4ba1ce21b757f84ccf664db9c18ba7efffe153e5d",
  "patches/@contextvm%2Fsdk@0.13.10.patch": "89bd6447fbc11cc78869bc44395b8ef6e24ce3bc1bbc9fbae21d1b5dbb88b599",
});

/** Exact preview-runtime root including the requested MCP dependency; all
 * previously locked package entries and the approved OTel closure are unchanged. Future root drift still fails closed. */
export async function assertDevelopmentRootManifests(root = resolve(import.meta.dir, "../..")): Promise<void> {
  for (const [path, expected] of Object.entries(manifestPins)) {
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(root, path)).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new Error(`DEV_ROOT_MANIFEST_DRIFT:${path}`);
  }
}
