import { expect, test } from "bun:test";
import { ProductionJobObservationSchema } from "../../src/worker-adapters/production-job-client";

test("bounded command diagnostics remain failed evidence and cannot enter successful job receipts", () => {
  const diagnostic = { commandIndex: 0, argv: ["pnpm", "test:conformance"], exitCode: 1, stdoutSha256: "b".repeat(64), stderrSha256: "c".repeat(64), stdoutTail: "untrusted generated output", stderrTail: "EACCES" };
  const job = { version: 1, state: "failed", jobId: "a".repeat(64), requestSha256: "a".repeat(64), code: "JOB_REPRODUCTION_COMMAND_FAILED", commands: [], diagnostics: diagnostic, reproductionDiagnostics: diagnostic };
  expect(ProductionJobObservationSchema.parse(job).state).toBe("failed");
  expect(ProductionJobObservationSchema.safeParse({ ...job, reproductionDiagnostics: { ...diagnostic, stderrTail: "x".repeat(4097) } }).success).toBe(false);
  expect(ProductionJobObservationSchema.safeParse({ ...job, diagnostics: { ...job.diagnostics, commandIndex: 8 } }).success).toBe(false);
  expect(ProductionJobObservationSchema.safeParse({ ...job, state: "completed", artifactSha256: "b".repeat(64), artifactBytes: 1 }).success).toBe(false);
});
