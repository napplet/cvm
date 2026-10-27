import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertDevelopmentRootManifests } from "../../src/dev/root-manifests";

test("the checked-in dependency manifests match the approved launcher pins", async () => {
  await expect(assertDevelopmentRootManifests()).resolves.toBeUndefined();
});

for (const changed of ["package.json", "bun.lock"]) test(`dependency drift is refused for ${changed}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "cvm-manifest-test-"));
  try {
    for (const file of ["package.json", "bun.lock"]) await copyFile(resolve(import.meta.dir, "../..", file), join(root, file));
    await appendFile(join(root, changed), "\n");
    await expect(assertDevelopmentRootManifests(root)).rejects.toThrow(`DEV_ROOT_MANIFEST_DRIFT:${changed}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
