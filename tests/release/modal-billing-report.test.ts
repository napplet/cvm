import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createMemoryModalBillingReportJournal,
  createModalBillingReportCollector,
  createModalBillingObservationGrant,
  parseModalBillingReport,
  runPinnedModalBillingReport,
} from "../../src/release/deployment/modal-billing-report";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hex = (seed: string) => digest(seed);
const encoder = new TextEncoder();

const report = JSON.stringify([{ object_id: "sb-verified-1", description: "Sandbox", environment: "cvm-prod", interval_start: "2026-10-30T10:00:00Z", resource: "CPU", cost: "0.125000", tags: "{\"cvm_operation\":\"operation-1\",\"cvm_account\":\"account-1\"}" }]);
const mismatchedReport = JSON.stringify([{ object_id: "unbound-object", description: "Sandbox", environment: "cvm-prod", interval_start: "2026-10-30T10:00:00Z", resource: "CPU", cost: "0.1", tags: "{\"cvm_operation\":\"operation-1\",\"cvm_account\":\"account-1\"}" }]);

async function fixture(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "modal-billing-fixture-"));
  const executable = join(directory, "modal-fixture");
  const source = script.replace("#!/usr/bin/env bun\n", `#!${process.execPath}\n`);
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { directory, executable, sha256: digest(new Uint8Array(await Bun.file(executable).arrayBuffer())) };
}

function grant(executableSha256: string) {
  return createModalBillingObservationGrant({
    version: 1,
    authorizationRequestSha256: hex("authorization-request"), authorizationReceiptSha256: hex("authorization-receipt"),
    candidateSha256: hex("candidate"), operationRecordSha256: hex("operation-record"),
    accountScopeSha256: hex("account-scope"), environmentScopeSha256: hex("environment-scope"),
    resourceIdentitySha256: hex("resource-identity"), currencyPolicySha256: hex("currency-policy"),
    credentialReferenceSha256: hex("credential-reference"), cliExecutableSha256: executableSha256,
    environmentName: "cvm-prod", expectedObjectId: "sb-verified-1", intervalStartMs: Date.parse("2026-10-30T10:00:00Z"), intervalEndMs: Date.parse("2026-10-30T11:00:00Z"),
    requiredTags: { cvm_account: "account-1", cvm_operation: "operation-1" }, maximumStdoutBytes: 8_192, maximumStderrBytes: 2_048,
    timeoutMs: 1_000, maximumAttempts: 2, expiresAtMs: Date.now() + 60_000,
  });
}

describe("pinned Modal billing report collector", () => {
  test("runs a bounded real child with fixed argv and a closed environment", async () => {
    const executable = await fixture(`#!/usr/bin/env bun
const expected = ["environment", "billing", "report", "cvm-prod", "--start", "2026-10-30T10:00:00.000Z", "--end", "2026-10-30T11:00:00.000Z", "--resolution", "h", "--tag-names", "cvm_account,cvm_operation", "--show-resources", "--json"];
const clean = process.env.HOME && process.env.HOME !== "/Users/leaked" && process.env.MODAL_CONFIG_PATH?.endsWith("modal.toml") && !process.env.HTTP_PROXY && !process.env.HTTPS_PROXY && !process.env.ALL_PROXY && !process.env.NO_PROXY;
if (!clean || JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) { process.stderr.write("profile-invalid"); process.exit(12); }
process.stdout.write(${JSON.stringify(report)});
`);
    try {
      const result = await runPinnedModalBillingReport({ executable: executable.executable, executableSha256: executable.sha256, environmentName: "cvm-prod", intervalStartMs: Date.parse("2026-10-30T10:00:00Z"), intervalEndMs: Date.parse("2026-10-30T11:00:00Z"), tagNames: ["cvm_account", "cvm_operation"], maximumStdoutBytes: 8_192, maximumStderrBytes: 2_048, timeoutMs: 1_000, credential: { tokenId: "fixture-id", tokenSecret: "fixture-secret" } });
      expect(result.disposition).toBe("passed");
      expect(result.argv).toEqual([executable.executable, "environment", "billing", "report", "cvm-prod", "--start", "2026-10-30T10:00:00.000Z", "--end", "2026-10-30T11:00:00.000Z", "--resolution", "h", "--tag-names", "cvm_account,cvm_operation", "--show-resources", "--json"]);
      expect(JSON.stringify(result.argv)).not.toContain("fixture-secret");
    } finally { await rm(executable.directory, { recursive: true, force: true }); }
  });

  test("enforces child output and wall-clock bounds", async () => {
    const overflow = await fixture(`#!/usr/bin/env bun
process.stdout.write("x".repeat(2048));
`);
    const sleeper = await fixture(`#!/usr/bin/env bun
await Bun.sleep(2_000);
`);
    const input = { environmentName: "cvm-prod", intervalStartMs: Date.parse("2026-10-30T10:00:00Z"), intervalEndMs: Date.parse("2026-10-30T11:00:00Z"), tagNames: ["cvm_account", "cvm_operation"], maximumStdoutBytes: 128, maximumStderrBytes: 128, credential: { tokenId: "fixture-id", tokenSecret: "fixture-secret" } };
    try {
      expect((await runPinnedModalBillingReport({ ...input, executable: overflow.executable, executableSha256: overflow.sha256, timeoutMs: 1_000 })).disposition).toBe("output_overflow");
      expect((await runPinnedModalBillingReport({ ...input, executable: sleeper.executable, executableSha256: sleeper.sha256, timeoutMs: 25 })).disposition).toBe("timeout");
    } finally { await Promise.all([rm(overflow.directory, { recursive: true, force: true }), rm(sleeper.directory, { recursive: true, force: true })]); }
  });

  test("rejects duplicate keys and holds mismatched, partial, and mixed report evidence", async () => {
    expect(() => parseModalBillingReport(encoder.encode('[{"object_id":"a","object_id":"b"}]'))).toThrow("MODAL_BILLING_REPORT_DUPLICATE_KEY");
    expect(() => parseModalBillingReport(encoder.encode('[{"object_id":"a"}]'))).toThrow("MODAL_BILLING_REPORT_SCHEMA_INVALID");
    const executable = await fixture(`#!/usr/bin/env bun
process.stdout.write(${JSON.stringify(mismatchedReport)});
`);
    const raw = new Map<string, Uint8Array>();
    const store = {
      async createImmutable(input: { key: string; bytes: Uint8Array; sha256: string }) { raw.set(`${input.key}:${input.sha256}`, new Uint8Array(input.bytes)); return { uri: `memory://${input.key}`, generation: "1", sha256: input.sha256 }; },
      async readExact(reference: { uri: string; generation: string; sha256: string }) { return [...raw.entries()].find(([key]) => key.endsWith(`:${reference.sha256}`))?.[1]; },
    };
    try {
      const collector = createModalBillingReportCollector({ executable: executable.executable, executableSha256: executable.sha256, credentialReference: "secret/modal-report", credentialReferenceSha256: hex("credential-reference"), credentialResolver: { async resolve() { return { tokenId: "fixture-id", tokenSecret: "fixture-secret" }; } }, journal: createMemoryModalBillingReportJournal(), artifacts: store, now: () => Date.now() });
      const result = await collector.capture(grant(executable.sha256));
      expect(result.status).toBe("held");
      expect(result.reason).toBe("scope_mismatch");
      expect(raw.size).toBe(1);
    } finally { await rm(executable.directory, { recursive: true, force: true }); }
  });

  test("keeps retry attempts immutable and does not represent provider reports as invoices", async () => {
    const executable = await fixture(`#!/usr/bin/env bun
process.stdout.write(${JSON.stringify(report)});
`);
    const writes: string[] = [];
    const artifacts = {
      async createImmutable(input: { key: string; bytes: Uint8Array; sha256: string }) { writes.push(input.key); return { uri: `memory://${input.key}`, generation: "1", sha256: input.sha256 }; },
      async readExact() { return undefined; },
    };
    try {
      const collector = createModalBillingReportCollector({ executable: executable.executable, executableSha256: executable.sha256, credentialReference: "secret/modal-report", credentialReferenceSha256: hex("credential-reference"), credentialResolver: { async resolve() { return { tokenId: "fixture-id", tokenSecret: "fixture-secret" }; } }, journal: createMemoryModalBillingReportJournal(), artifacts, now: () => Date.now() });
      const approved = grant(executable.sha256);
      const first = await collector.capture(approved);
      const recovery = await collector.recover(approved);
      expect(first.status).toBe("held");
      expect(first.reason).toBe("finality_unproven");
      expect(recovery).toEqual(first);
      expect(writes).toHaveLength(1);
    } finally { await rm(executable.directory, { recursive: true, force: true }); }
  });

  test("quarantines credential echoes and never retains raw stderr", async () => {
    const executable = await fixture(`#!/usr/bin/env bun
process.stderr.write(process.env.MODAL_TOKEN_ID + ":" + process.env.MODAL_TOKEN_SECRET);
process.stdout.write(${JSON.stringify(report)});
`);
    const stored: Uint8Array[] = [];
    const artifacts = {
      async createImmutable(input: { key: string; bytes: Uint8Array; sha256: string }) { stored.push(new Uint8Array(input.bytes)); return { uri: `memory://${input.key}`, generation: "1", sha256: input.sha256 }; },
      async readExact() { return undefined; },
    };
    try {
      const collector = createModalBillingReportCollector({ executable: executable.executable, executableSha256: executable.sha256, credentialReference: "secret/modal-report", credentialReferenceSha256: hex("credential-reference"), credentialResolver: { async resolve() { return { tokenId: "fixture-id", tokenSecret: "fixture-secret" }; } }, journal: createMemoryModalBillingReportJournal(), artifacts, now: () => Date.now() });
      const result = await collector.capture(grant(executable.sha256));
      expect(result).toMatchObject({ status: "held", reason: "credential_echo" });
      expect(stored).toHaveLength(0);
    } finally { await rm(executable.directory, { recursive: true, force: true }); }
  });
});
