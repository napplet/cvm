import { resolve } from "node:path";

const manifestPins = Object.freeze({
  "package.json": "0c1829dce988bd001823e397c36c53e78e303249041f52b0219ca1542d185989",
  "bun.lock": "f6a0fc4120899cb12e99f857c5fc0253c797ed06a24647cdb7ce359cd066bd6d",
});

/** One approved dependency pin set for launcher and browser evidence. */
export async function assertDevelopmentRootManifests(root = resolve(import.meta.dir, "../..")): Promise<void> {
  for (const [path, expected] of Object.entries(manifestPins)) {
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(root, path)).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new Error(`DEV_ROOT_MANIFEST_DRIFT:${path}`);
  }
}
