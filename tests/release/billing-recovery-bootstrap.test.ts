import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";

const repositoryRoot = resolve(import.meta.dir, "../..");
const childPath = resolve(repositoryRoot, "tests/fixtures/billing-recovery-bootstrap.ts");
const Result = z.object({
  scenario: z.string(), cliExitCode: z.number(), captureFiles: z.number(), captureRows: z.number(), artifactDenials: z.number(),
  effects: z.object({ pools: z.number(), closes: z.number(), adc: z.number(), queryGets: z.number(), queryPosts: z.number(), objectReads: z.number(), objectWrites: z.number(), journalWrites: z.number(), captures: z.number(), secretReads: z.array(z.string()) }),
});

for (const scenario of ["completed", "missing-grant", "missing-job", "expired-grant", "grant-tampered", "receipt-integrity", "configuration", "candidate", "account", "mode-override"]) {
  test(`normal mounted CLI report recovery: ${scenario}`, async () => {
    // Keep transport substitutions in a separate process. Never replace the
    // loader or reporter in this test process or leak a mocked module into
    // subsequent tests. No operator credential/profile environment is inherited.
    const child = Bun.spawn([process.execPath, childPath, scenario], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH ?? "", NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const line = stdout.split("\n").find(value => value.startsWith("BOOTSTRAP_PROOF_RESULT="));
    if (!line) throw new Error(`BOOTSTRAP_PROOF_RESULT_REQUIRED:${stderr}`);
    const result = Result.parse(JSON.parse(line.slice("BOOTSTRAP_PROOF_RESULT=".length)));
    expect(result.scenario).toBe(scenario);
    expect(result.cliExitCode).toBe(1); // held evidence cannot finalize/promote
    expect(result.effects.queryPosts).toBe(0);
    expect(result.effects.closes).toBe(result.effects.pools);
    expect(result.effects.secretReads.every(name => ["cert_session", "cert_request", "cert_receipt", "sql_runtime"].includes(name))).toBeTrue();
    if (scenario === "completed") {
      expect(stdout).toContain('"reportOnlyRecovery":true');
      expect(stdout).toContain('"status":"billing_observing"');
      expect(result.effects.pools).toBe(2);
      expect(result.artifactDenials).toBe(5);
      expect(result.effects.queryGets).toBe(1);
      expect(result.effects.objectWrites).toBe(1);
      expect(result.effects.captures).toBe(1);
      expect(result.captureFiles).toBe(1);
      expect(result.captureRows).toBe(1);
    } else {
      expect(result.effects.adc).toBe(0);
      expect(result.effects.queryGets).toBe(0);
      expect(result.effects.objectReads).toBe(0);
      expect(result.effects.objectWrites).toBe(0);
      expect(result.effects.journalWrites).toBe(0);
      expect(result.effects.captures).toBe(0);
      expect(result.captureFiles).toBe(0);
      expect(result.captureRows).toBe(0);
      if (["expired-grant", "receipt-integrity", "configuration", "candidate"].includes(scenario)) expect(result.effects.pools).toBe(0);
      if (["configuration", "candidate"].includes(scenario)) expect(result.effects.secretReads).toEqual([]);
    }
  }, 15_000);
}
