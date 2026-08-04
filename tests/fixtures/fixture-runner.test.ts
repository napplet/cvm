import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { distTreeDigest } from "../../infra/toolchain/fixture-runner";

describe("fixture-runner dist identity", () => {
  test("includes parent directories when hashing nested dist files", async () => {
    const root = await mkdtemp(join(tmpdir(), "napplet-cvm-dist-"));
    try {
      await mkdir(join(root, "first", "nested"), { recursive: true });
      await writeFile(join(root, "first", "nested", "asset.js"), "same bytes");
      const first = await distTreeDigest(root);

      await rename(join(root, "first"), join(root, "second"));
      const second = await distTreeDigest(root);

      expect(second).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
