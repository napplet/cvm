import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateDesignVerificationEvidence } from "../../src/verification/design-evidence";

test("design slice preserves the native scaffold limitation as blocked, content-addressed evidence", async () => {
  const root = join(import.meta.dir, "..", "..");
  const process = Bun.spawn(["bun", "run", "test:design-slice"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  // Bun prints its script invocation to stderr; it must not contain a failure.
  expect(stderr).not.toContain("error:");
  expect(JSON.parse(stdout)).toMatchObject({ verdict: "blocked", nativeRuntime: "blocked" });

  const summary = JSON.parse(await readFile(join(root, "evidence/design/phase-01.json"), "utf8"));
  expect(summary).toMatchObject({
    certificationProfile: "design",
    verdict: "blocked",
    nativeRuntime: expect.stringContaining("Phase 7"),
  });
  expect(summary.contentAddressedPath).toMatch(/^evidence\/design\/[a-f0-9]{64}\.json$/);

  const evidence = JSON.parse(await readFile(join(root, summary.contentAddressedPath), "utf8"));
  await expect(validateDesignVerificationEvidence(evidence)).resolves.toBeUndefined();
  expect(evidence.verdict).toBe("blocked");
  expect(evidence.deferredLaunchGates).toEqual(expect.arrayContaining([
    "exhaustive-provenance",
    "cross-environment-reproducibility",
    "full-hostile-mutation-matrix",
    "formal-golden-approval",
    "production-promotion",
  ]));
});
