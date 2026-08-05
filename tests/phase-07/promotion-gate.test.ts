import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

async function run(script: string, args: readonly string[]) {
  const child = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PHASE07_TEST_SECRET: "supersecret" } });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("07-W0-05 registry binds promotion coverage to Plan 07-10 and has no pass claim", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8"));
  const entries = registry.entries.filter((entry: { id: string }) => entry.id === "07-W0-05");
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    requirement: "OPS-04",
    threat: "T-07-PRO",
    evidenceTier: "live",
    status: "pending",
    commands: ["bun test tests/phase-07/promotion-gate.test.ts", "bun run candidate:verify"],
    owners: ["07-10 Task 1", "07-10 Task 2", "07-10 Task 3"],
  });
  expect(entries[0].cases).toEqual(expect.arrayContaining([
    "exact-input-freshness-digest-binding", "concurrency", "non-waivable-classes", "blocked-preflight", "atomic-decision",
  ]));
  expect(entries[0].status).not.toBe("passed");
});

test("Phase 07 CLI seams reject unimplemented or protected work without a release pass or secret echo", async () => {
  const deterministic = await run("scripts/eval-phase-07.ts", ["--suite=all"]);
  const existingEvidence = await run("scripts/verify-phase-07-evidence.ts", ["--verify-existing"]);
  const protectedPreflight = await run("scripts/certify-phase-07.ts", ["--profile=release", "--preflight-only"]);
  for (const result of [deterministic, existingEvidence, protectedPreflight]) {
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/blocked|not_observed|not_implemented/u);
    expect(`${result.stdout}${result.stderr}`).not.toContain("supersecret");
  }
  expect(protectedPreflight.stdout).toContain("admission");
  expect(protectedPreflight.stdout).toContain("publication");
});

test.todo("07-W0-05 rejects missing, stale, mutated, cross-candidate, skipped, blocked, and not_observed promotion evidence atomically");
