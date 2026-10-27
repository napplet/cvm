import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertDevelopmentRootManifests } from "../../src/dev/root-manifests";

test("the checked-in dependency manifests match the approved launcher pins", async () => {
  await expect(assertDevelopmentRootManifests()).resolves.toBeUndefined();
});

const dependencyFiles = ["package.json", "bun.lock", "patches/@contextvm%2Fsdk@0.13.10.patch"];
for (const changed of dependencyFiles) test(`dependency drift is refused for ${changed}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "cvm-manifest-test-"));
  try {
    for (const file of dependencyFiles) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await copyFile(resolve(import.meta.dir, "../..", file), join(root, file));
    }
    await appendFile(join(root, changed), "\n");
    await expect(assertDevelopmentRootManifests(root)).rejects.toThrow(`DEV_ROOT_MANIFEST_DRIFT:${changed}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
