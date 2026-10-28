import { resolve } from "node:path";

const manifestPins = Object.freeze({
  "package.json": "48db1af57f71711833851c4c5c6f3c2d5cb306c9c95a6cfc8d9be1913a4d188b",
  "bun.lock": "7b1a312b47a2d6a3f7b18a84ee72e09a821aaf13043a7d8dcc1a05ea5c49a385",
  "patches/@contextvm%2Fsdk@0.13.10.patch": "89bd6447fbc11cc78869bc44395b8ef6e24ce3bc1bbc9fbae21d1b5dbb88b599",
});

/** One approved dependency pin set for launcher and browser evidence. */
export async function assertDevelopmentRootManifests(root = resolve(import.meta.dir, "../..")): Promise<void> {
  for (const [path, expected] of Object.entries(manifestPins)) {
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(root, path)).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new Error(`DEV_ROOT_MANIFEST_DRIFT:${path}`);
  }
}
