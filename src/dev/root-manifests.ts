import { resolve } from "node:path";

const manifestPins = Object.freeze({
  "package.json": "dca9aebd2cbdb6a10b1dad1565667107807839545a98e10a76ff6e1bdd58891c",
  "bun.lock": "2043b92ba436bba778d338bad0af0255abd61363535e06f72ae3f8a9a71630f6",
  "patches/@contextvm%2Fsdk@0.13.10.patch": "89bd6447fbc11cc78869bc44395b8ef6e24ce3bc1bbc9fbae21d1b5dbb88b599",
});

/** One approved dependency pin set for launcher and browser evidence. */
export async function assertDevelopmentRootManifests(root = resolve(import.meta.dir, "../..")): Promise<void> {
  for (const [path, expected] of Object.entries(manifestPins)) {
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(root, path)).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new Error(`DEV_ROOT_MANIFEST_DRIFT:${path}`);
  }
}
