import { resolve } from "node:path";

const manifestPins = Object.freeze({
  "package.json": "046a7ffc858c393c5289ffa106290fb8f01fe0365b84d9daa47aaaaa2f1a5b00",
  "bun.lock": "0a2027fd7eaa6f6f609c9f1ec430a7b9095d6b45472f8833a3e00e6f0604c187",
  "patches/@contextvm%2Fsdk@0.13.10.patch": "89bd6447fbc11cc78869bc44395b8ef6e24ce3bc1bbc9fbae21d1b5dbb88b599",
});

/** One approved dependency pin set for launcher and browser evidence. */
export async function assertDevelopmentRootManifests(root = resolve(import.meta.dir, "../..")): Promise<void> {
  for (const [path, expected] of Object.entries(manifestPins)) {
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(root, path)).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new Error(`DEV_ROOT_MANIFEST_DRIFT:${path}`);
  }
}
