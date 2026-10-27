import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("runtime dependency graph only composes concrete production transports", async () => {
  const source = await readFile(new URL("../../src/production/runtime-dependencies.ts", import.meta.url), "utf8");
  expect(source).toContain("createMountedVertexMaterial");
  expect(source).toContain("createPostgresVertexOperationJournal");
  expect(source).toContain("ProductionWorkerBridge");
  expect(source).not.toContain("src/dev");
  expect(source).not.toContain("FakeWallet");
});
