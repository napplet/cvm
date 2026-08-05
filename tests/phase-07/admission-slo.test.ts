import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";
const knownStatuses = new Set(["pending", "blocked", "not_observed", "passed"]);
const knownTiers = new Set(["fast", "medium", "live"]);

type RegistryRow = Readonly<{
  id: string;
  requirement: string;
  threat: string;
  evidenceTier: string;
  status: string;
  commands: readonly string[];
  owners: readonly string[];
  cases: readonly string[];
}>;

async function loadRegistry(): Promise<Readonly<{ schema: "phase-07-reference-set"; version: 1; entries: readonly RegistryRow[] }>> {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function assertStrictRegistry(registry: Awaited<ReturnType<typeof loadRegistry>>): void {
  expect(registry).toMatchObject({ schema: "phase-07-reference-set", version: 1 });
  expect(registry.entries.map((entry) => entry.id)).toEqual(["07-W0-01", "07-W0-02", "07-W0-03", "07-W0-04", "07-W0-05"]);
  expect(new Set(registry.entries.map((entry) => entry.id)).size).toBe(registry.entries.length);
  for (const entry of registry.entries) {
    expect(entry.requirement).toMatch(/^(SESS-02|OPS-0[1-4])$/u);
    expect(entry.threat).toMatch(/^T-07-(ADM|TEL|REC|RST|PRO)$/u);
    expect(knownTiers.has(entry.evidenceTier)).toBe(true);
    expect(knownStatuses.has(entry.status)).toBe(true);
    expect(entry.status).not.toBe("passed");
    expect(entry.commands.length).toBeGreaterThan(0);
    expect(entry.owners.length).toBeGreaterThan(0);
    expect(entry.cases.length).toBeGreaterThan(0);
  }
}

test("07-W0-01 registry is unique, owner-bound, and pending until Plan 07-01 observations exist", async () => {
  const registry = await loadRegistry();
  assertStrictRegistry(registry);
  const entry = registry.entries.find((candidate) => candidate.id === "07-W0-01");
  expect(entry).toMatchObject({
    requirement: "SESS-02",
    threat: "T-07-ADM",
    evidenceTier: "live",
    status: "pending",
    commands: ["bun test tests/phase-07/admission-slo.test.ts", "bun run certify:phase07 -- --suite=admission"],
    owners: ["07-01 Task 1", "07-01 Task 2"],
  });
  expect(entry?.cases).toEqual(expect.arrayContaining([
    "receipt-before-effects", "exact-session-readiness", "stable-no-effect-refusal", "exact-replay", "concurrent-single-claim", "sample-confidence", "zero-backlog",
  ]));
});

test("07-W0-01 rejects duplicate IDs, unknown registry enums, and baseline pass claims", async () => {
  const registry = await loadRegistry();
  const duplicate = structuredClone(registry); duplicate.entries.push(structuredClone(duplicate.entries[0]));
  expect(new Set(duplicate.entries.map((entry) => entry.id)).size).not.toBe(duplicate.entries.length);
  const unknownStatus = structuredClone(registry); unknownStatus.entries[0].status = "unknown";
  expect(knownStatuses.has(unknownStatus.entries[0].status)).toBe(false);
  const passClaim = structuredClone(registry); passClaim.entries[0].status = "passed";
  expect(passClaim.entries[0].status).not.toBe("pending");
});

test.todo("07-W0-01 derives receipt-to-exact-ready timing and refusal effects from the production admission service");
