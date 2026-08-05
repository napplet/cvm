import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

test("Phase 07 registry is a strict five-row comparator-only baseline", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8"));
  assertComparatorOnlyRegistry(registry);
  expect(registry.entries.map((entry: { id: string }) => entry.id)).toEqual(["07-W0-01", "07-W0-02", "07-W0-03", "07-W0-04", "07-W0-05"]);
});

test.todo("07-W0-03 compares Plan 07-06/07-09 actual authority observations without injecting expected facts into runtime inputs");
