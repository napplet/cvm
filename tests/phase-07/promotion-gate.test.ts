import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const fixturePath = "tests/fixtures/phase-07-reference-set.json";

async function run(script: string, args: readonly string[]) {
  const child = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PHASE07_TEST_SECRET: "supersecret" } });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("07-W0-05 corpus binds promotion coverage and keeps protected live work non-passing", async () => {
  const registry = JSON.parse(await readFile(fixturePath, "utf8"));
  expect(registry.cases.filter((entry: { category: string }) => entry.category === "launch")).toHaveLength(10);
  expect(registry.cases.filter((entry: { requirements: string[] }) => entry.requirements.includes("OPS-04")).length).toBeGreaterThan(0);
  expect(registry.liveObservations.every((entry: { status: string }) => entry.status === "blocked" || entry.status === "not_observed")).toBe(true);
});

test("Phase 07 CLI seams reject unimplemented or protected work without a release pass or secret echo", async () => {
  const deterministic = await run("scripts/eval-phase-07.ts", ["--suite=all"]);
  const existingEvidence = await run("scripts/verify-phase-07-evidence.ts", ["--verify-existing"]);
  const protectedPreflight = await run("scripts/certify-phase-07.ts", ["--profile=release", "--preflight-only"]);
  for (const result of [deterministic, existingEvidence]) {
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/promotionVerdict.*blocked|"blocked"/u);
    expect(`${result.stdout}${result.stderr}`).not.toContain("supersecret");
  }
  expect(protectedPreflight.exitCode).not.toBe(0);
  expect(`${protectedPreflight.stdout}${protectedPreflight.stderr}`).toMatch(/blocked|not_observed|not_implemented/u);
  expect(`${protectedPreflight.stdout}${protectedPreflight.stderr}`).not.toContain("supersecret");
});

test.todo("07-W0-05 rejects missing, stale, mutated, cross-candidate, skipped, blocked, and not_observed promotion evidence atomically");
