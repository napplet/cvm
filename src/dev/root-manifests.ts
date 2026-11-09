import { resolve } from "node:path";

const manifestPins = Object.freeze({
  "package.json": "96c527a1cf5c6942a1a111b20d0371d48e6388be780dfed67125cf7d077b8ddd",
  "bun.lock": "7ee9d49fdeccdc0305b8f9e1d899353042ca833fe6da5b85039ae33dcd18befe",
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
