import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

test("07-W0-04 names exact-object restore and retention oracles with Plan 07-07 ownership", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8"));
  const entry = registry.entries.find((candidate: { id: string }) => candidate.id === "07-W0-04");
  assertRestoreEntry(entry);
  expect(entry.cases).toEqual(expect.arrayContaining([
    "generation-checksum-read-decrypt-manifest-owner-version-lease-compatibility-expiry", "fresh-instance-reattachment", "mutation-deletion-races", "retention-inventory", "bounded-topology-claim",
  ]));
});

test.todo("07-W0-04 derives exact restore observations from the Plan 07-07 fresh-instance drill");
