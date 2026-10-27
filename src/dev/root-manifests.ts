import { resolve } from "node:path";

const manifestPins = Object.freeze({
  "package.json": "cb0b8052c98c74e227d6c42767226e713c5c6fcd404d825e34967cde21b089f0",
  "bun.lock": "62fd18d4eec7fb6134e1c90dd59e7bff032d73b98ce24ae993dc302884e4ef92",
  "patches/@contextvm%2Fsdk@0.13.10.patch": "89bd6447fbc11cc78869bc44395b8ef6e24ce3bc1bbc9fbae21d1b5dbb88b599",
});

/** One approved dependency pin set for launcher and browser evidence. */
export async function assertDevelopmentRootManifests(root = resolve(import.meta.dir, "../..")): Promise<void> {
  for (const [path, expected] of Object.entries(manifestPins)) {
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(root, path)).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new Error(`DEV_ROOT_MANIFEST_DRIFT:${path}`);
  }
}
