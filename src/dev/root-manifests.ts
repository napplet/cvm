import { resolve } from "node:path";

const manifestPins = Object.freeze({
  "package.json": "396739982eed64ec48ab5703c93132852091662b0d58481e1cf242768216b0d6",
  "bun.lock": "6360fa66cc48e7945e6d23d0a06ac1eafedad6710edb1ee53b85a8a36d607845",
  "patches/@contextvm%2Fsdk@0.13.10.patch": "89bd6447fbc11cc78869bc44395b8ef6e24ce3bc1bbc9fbae21d1b5dbb88b599",
});

/** Exact preview-runtime root after delegated decision 52dc056 and measured
 * local Collector smoke 18b42a8. Future root drift still fails closed. */
export async function assertDevelopmentRootManifests(root = resolve(import.meta.dir, "../..")): Promise<void> {
  for (const [path, expected] of Object.entries(manifestPins)) {
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(root, path)).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new Error(`DEV_ROOT_MANIFEST_DRIFT:${path}`);
  }
}
