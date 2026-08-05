import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

type RegistryRow = Readonly<{ id: string; requirement: string; threat: string; evidenceTier: string; status: string; commands: readonly string[]; owners: readonly string[]; cases: readonly string[] }>;

async function loadRegistry(): Promise<Readonly<{ schema: string; version: number; entries: readonly RegistryRow[] }>> {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

test("07-W0-02 registry binds telemetry privacy coverage to Plan 07-04 and remains non-pass", async () => {
  const registry = await loadRegistry();
  expect(registry).toMatchObject({ schema: "phase-07-reference-set", version: 1 });
  const entry = registry.entries.filter((candidate) => candidate.id === "07-W0-02");
  expect(entry).toHaveLength(1);
  expect(entry[0]).toMatchObject({
    requirement: "OPS-01",
    threat: "T-07-TEL",
    evidenceTier: "medium",
    status: "pending",
    commands: ["bun test tests/phase-07/telemetry-policy.test.ts", "bun run eval:phase07 -- --suite=telemetry"],
    owners: ["07-04 Task 2"],
  });
  expect(entry[0].cases).toEqual(expect.arrayContaining([
    "finite-vocabulary", "canary-redaction", "protected-correlation", "cardinality-bound", "concurrent-export", "exporter-failure-non-authority",
  ]));
  expect(entry[0].status).not.toBe("passed");
});

test("07-W0-02 keeps comparator facts out of telemetry runtime inputs", async () => {
  const registry = await loadRegistry();
  const entry = registry.entries.find((candidate) => candidate.id === "07-W0-02");
  expect(entry?.cases.every((item) => typeof item === "string" && item.length > 0)).toBe(true);
  expect(JSON.stringify(entry)).not.toContain("prompt");
  expect(JSON.stringify(entry)).not.toContain("secretValue");
  expect(JSON.stringify(entry)).not.toContain("exporterCallback");
});

test.todo("07-W0-02 derives finite-vocabulary telemetry and redaction observations from the Plan 07-04 exporter");
