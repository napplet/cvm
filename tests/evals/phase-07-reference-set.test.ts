import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";
const allowedEntryKeys = ["cases", "commands", "evidenceTier", "id", "owners", "requirement", "status", "threat"];
const forbiddenRuntimeKeys = ["input", "expected", "observed", "schedule", "provider", "store", "service", "callback"];

function assertComparatorOnlyRegistry(registry: unknown): asserts registry is Readonly<{ schema: string; version: number; entries: readonly Record<string, unknown>[] }> {
  expect(registry).toMatchObject({ schema: "phase-07-reference-set", version: 1 });
  const entries = (registry as { entries?: unknown }).entries;
  expect(Array.isArray(entries)).toBe(true);
  expect(entries).toHaveLength(5);
  for (const entry of entries as readonly Record<string, unknown>[]) {
    expect(Object.keys(entry).sort()).toEqual(allowedEntryKeys);
    expect(entry.status).toBe("pending");
    expect(entry.status).not.toBe("passed");
    expect(Array.isArray(entry.commands) && entry.commands.length > 0).toBe(true);
    expect(Array.isArray(entry.owners) && entry.owners.length > 0).toBe(true);
    expect(forbiddenRuntimeKeys.some((key) => key in entry)).toBe(false);
  }
}

test("Phase 07 registry is a strict five-row comparator-only baseline", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8"));
  assertComparatorOnlyRegistry(registry);
  expect(registry.entries.map((entry: { id: string }) => entry.id)).toEqual(["07-W0-01", "07-W0-02", "07-W0-03", "07-W0-04", "07-W0-05"]);
});

test.todo("07-W0-03 compares Plan 07-06/07-09 actual authority observations without injecting expected facts into runtime inputs");
