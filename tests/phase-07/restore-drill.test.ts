import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

function assertRestoreEntry(entry: unknown): asserts entry is Readonly<{ requirement: string; threat: string; evidenceTier: string; status: string; commands: readonly string[]; owners: readonly string[]; cases: readonly string[] }> {
  expect(entry).toMatchObject({
    requirement: "OPS-03",
    threat: "T-07-RST",
    evidenceTier: "live",
    status: "pending",
    commands: ["bun test tests/phase-07/restore-drill.test.ts", "bun run certify:phase07 -- --suite=restore"],
    owners: ["07-07 Task 1", "07-07 Task 2"],
  });
  expect((entry as { status: string }).status).not.toBe("passed");
}

test("07-W0-04 names exact-object restore and retention oracles with Plan 07-07 ownership", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8"));
  const entry = registry.entries.find((candidate: { id: string }) => candidate.id === "07-W0-04");
  assertRestoreEntry(entry);
  expect(entry.cases).toEqual(expect.arrayContaining([
    "generation-checksum-read-decrypt-manifest-owner-version-lease-compatibility-expiry", "fresh-instance-reattachment", "mutation-deletion-races", "retention-inventory", "bounded-topology-claim",
  ]));
});

test.todo("07-W0-04 derives exact restore observations from the Plan 07-07 fresh-instance drill");
