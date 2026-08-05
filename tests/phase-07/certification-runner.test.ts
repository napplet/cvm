import { expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProtectedCertificationAdapterRegistry } from "../../src/certification/adapters";
import { runProtectedCertificationProfile } from "../../src/certification/runner";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const binding = {
  releaseId: digest("1"), sourceRevision: "a".repeat(40), inputs: {
    controlImageDigest: digest("2"), workerImageDigest: digest("3"), packageLockSha256: digest("4"), toolchainSha256: digest("5"),
    migrationSha256: digest("6"), configSha256: digest("7"), policySha256: digest("8"), datasetSha256: digest("9"), goldenSha256: digest("a"), sbomSha256: digest("b"), provenanceSha256: digest("c"),
  },
};
const profile = { candidate: { id: digest("d"), provider: "modal" as const, image: `worker@sha256:${digest("3")}`, sourceSha256: digest("e") }, datasetSha256: digest("9"), topologySha256: digest("f"), profileSha256: digest("0"), releaseBinding: binding };

test("configured adapters run once, map finite safe results, and preserve test evidence class", async () => {
  let calls = 0;
  const outcome = await runProtectedCertificationProfile({
    profile, selectedSuites: ["admission"], evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}`,
    registry: { evidenceClass: "deterministic", adapters: { admission: async () => { calls += 1; return { status: "passed", claims: ["release.admission_slo"], limitations: [], reasonCode: "OBSERVATION_COMPLETE" }; } } },
    now: () => 1_000,
  });
  expect(calls).toBe(1);
  expect(outcome.records).toHaveLength(1);
  expect(outcome.records[0]!.status).toBe("passed");
  expect(outcome.records[0]!.evidenceClass).toBe("deterministic");
});

test("preflight writes every selected non-pass inventory record without invoking adapters", async () => {
  let calls = 0;
  const outcome = await runProtectedCertificationProfile({
    profile, selectedSuites: ["admission", "telemetry"], preflightOnly: true, evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}`,
    registry: { evidenceClass: "deterministic", adapters: { admission: async () => { calls += 1; return { status: "passed", claims: ["release.admission_slo"], limitations: [], reasonCode: "OBSERVATION_COMPLETE" }; } } },
    now: () => 1_000,
  });
  expect(calls).toBe(0);
  expect(outcome.records.map((record) => record.status)).toEqual(["blocked", "blocked"]);
});

test("malformed, throwing, and secret-bearing adapter output cannot fabricate a pass", async () => {
  const outcome = await runProtectedCertificationProfile({
    profile, selectedSuites: ["admission", "telemetry"], evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}`,
    registry: { evidenceClass: "deterministic", adapters: {
      admission: async () => ({ status: "passed", claims: ["release.unknown"], limitations: [], reasonCode: "OBSERVATION_COMPLETE", secret: "canary" }),
      telemetry: async () => { throw new Error("canary"); },
    } }, now: () => 1_000,
  });
  expect(outcome.records.map((record) => record.status)).toEqual(["failed", "failed"]);
  expect(JSON.stringify(outcome)).not.toContain("canary");
});

test("adapter loader rejects traversal, symlink, and digest drift without exposing a path", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-adapter-"));
  const modulePath = join(root, "adapter.ts");
  await writeFile(modulePath, "export const protectedCertificationAdapters = { evidenceClass: 'protected_live', adapters: {} };\n");
  await expect(loadProtectedCertificationAdapterRegistry({ root, modulePath, sha256: digest("1") })).rejects.toThrow("CERTIFICATION_ADAPTER_DIGEST_INVALID");
  await expect(loadProtectedCertificationAdapterRegistry({ root, modulePath: `${root}/../adapter.ts`, sha256: digest("1") })).rejects.toThrow("CERTIFICATION_ADAPTER_CONFIGURATION_INVALID");
  const linked = join(root, "linked.ts"); await symlink(modulePath, linked);
  await expect(loadProtectedCertificationAdapterRegistry({ root, modulePath: linked, sha256: digest("1") })).rejects.toThrow("CERTIFICATION_ADAPTER_SYMLINK_REJECTED");
});
