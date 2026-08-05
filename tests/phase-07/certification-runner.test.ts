import { expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProtectedCertificationAdapterRegistry } from "../../src/certification/adapters";
import { runProtectedCertificationProfile } from "../../src/certification/runner";
import { canonicalJson } from "../../src/promotion/schema";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const binding = {
  releaseId: digest("1"), sourceRevision: "a".repeat(40), sourceSha256: digest("e"), supplyChainPolicy: { cosign: { executableSha256: digest("0"), signerIdentity: "https://github.com/acme/napplet/.github/workflows/release.yml@refs/heads/main", issuer: "https://token.actions.githubusercontent.com", predicateType: "https://slsa.dev/provenance/v1" }, sbom: { bomFormat: "CycloneDX", specVersion: "1.5", generator: { vendor: "acme", name: "sealed-toolchain", version: "1" } } }, inputs: {
    controlImageDigest: digest("2"), workerImageDigest: digest("3"), packageLockSha256: digest("4"), toolchainSha256: digest("5"),
    migrationSha256: digest("6"), configSha256: digest("7"), policySha256: digest("8"), datasetSha256: digest("9"), goldenSha256: digest("a"), sbomSha256: digest("b"), provenanceSha256: digest("c"),
  },
};
const profile = { candidate: { id: digest("d"), provider: "modal" as const, image: `worker@sha256:${digest("3")}`, sourceSha256: digest("e") }, datasetSha256: digest("9"), topologySha256: digest("f"), profileSha256: digest("0"), releaseBinding: binding };

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Text(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

test("a protected supply-chain adapter cannot claim release authority without exact verified record references", async () => {
  let calls = 0;
  const outcome = await runProtectedCertificationProfile({
    profile, selectedSuites: ["supply-chain"], evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}`,
    registry: { evidenceClass: "protected_live", adapters: {
      "supply-chain": async () => {
        calls += 1;
        return { status: "passed", claims: ["release.supply_chain"], limitations: [], reasonCode: "OBSERVATION_COMPLETE" };
      },
    } }, now: () => 1_000,
  });
  expect(calls).toBe(0);
  expect(outcome.records[0]).toMatchObject({ status: "blocked", reasonCode: "INPUT_UNAVAILABLE" });
});

test("a protected adapter cannot run when candidate source bytes differ from the trusted release source digest", async () => {
  let calls = 0;
  const outcome = await runProtectedCertificationProfile({
    profile: { ...profile, candidate: { ...profile.candidate, sourceSha256: digest("0") } }, selectedSuites: ["admission"], evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}`,
    registry: { evidenceClass: "protected_live", adapters: { admission: async () => { calls += 1; return { status: "passed", claims: ["release.admission_slo"], limitations: [], reasonCode: "OBSERVATION_COMPLETE" }; } } }, now: () => 1_000,
  });
  expect(calls).toBe(0);
  expect(outcome.records[0]).toMatchObject({ status: "failed", reasonCode: "EVIDENCE_INVALID" });
});

test("runner rejects a freshly rehashed supply record that self-selects a signer before adapter invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-records-"));
  const releaseBindingSha256 = await sha256(binding);
  const reproducibilityBase = { version: 1 as const, evidenceClass: "protected_live" as const, status: "verified" as const, candidateId: profile.candidate.id, releaseBindingSha256, measuredSourceSha256: binding.sourceSha256, sourceReferenceSha256: [digest("a"), digest("b")], expectedArtifactSha256: digest("3"), buildEvidenceSha256: [digest("1"), digest("2")], isolationIdentitySha256: [digest("3"), digest("4")], runIdentitySha256: [digest("5"), digest("6")], completedAtMs: 1_000 };
  const reproducibilityEvidenceSha256 = await sha256(reproducibilityBase);
  const reproducibility = { ...reproducibilityBase, evidenceSha256: reproducibilityEvidenceSha256, contentAddressedPath: `evidence/certification/reproducibility/${reproducibilityEvidenceSha256}.json` };
  const supplyChainEvidenceSha256 = digest("7");
  const supplyChain = { version: 1 as const, evidenceClass: "protected_live" as const, status: "verified" as const, candidateId: profile.candidate.id, artifactSha256: digest("3"), releaseBindingSha256, cosignExecutableSha256: binding.supplyChainPolicy.cosign.executableSha256, cosignCommandSha256: digest("8"), signerIdentitySha256: await sha256Text("https://github.com/attacker/release.yml@refs/heads/main"), issuerSha256: await sha256Text(binding.supplyChainPolicy.cosign.issuer), predicateType: binding.supplyChainPolicy.cosign.predicateType, sbomFormat: binding.supplyChainPolicy.sbom.bomFormat, sbomSpecVersion: binding.supplyChainPolicy.sbom.specVersion, sbomGeneratorSha256: await sha256(binding.supplyChainPolicy.sbom.generator), sbomSha256: binding.inputs.sbomSha256, provenanceSha256: binding.inputs.provenanceSha256, reviewedComponentsSha256: digest("9"), verifiedAtMs: 1_000, evidenceSha256: supplyChainEvidenceSha256, contentAddressedPath: `evidence/certification/supply-chain/${supplyChainEvidenceSha256}.json` };
  const reproducibilityText = JSON.stringify(reproducibility); const supplyChainText = JSON.stringify(supplyChain);
  await writeFile(join(root, "reproducibility.json"), reproducibilityText); await writeFile(join(root, "supply-chain.json"), supplyChainText);
  let calls = 0;
  const outcome = await runProtectedCertificationProfile({ profile: { ...profile, protectedVerificationReferences: { root, reproducibility: { relativePath: "reproducibility.json", evidenceSha256: await sha256Text(reproducibilityText) }, supplyChain: { relativePath: "supply-chain.json", evidenceSha256: await sha256Text(supplyChainText) } } }, selectedSuites: ["supply-chain"], evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}`, registry: { evidenceClass: "protected_live", adapters: { "supply-chain": async () => { calls += 1; return { status: "passed", claims: ["release.supply_chain"], limitations: [], reasonCode: "OBSERVATION_COMPLETE" }; } } }, now: () => 1_001 });
  expect(calls).toBe(0);
  expect(outcome.records[0]).toMatchObject({ status: "failed", reasonCode: "EVIDENCE_INVALID" });
});

test("runner rejects empty or duplicate suite selection instead of silently succeeding", async () => {
  await expect(runProtectedCertificationProfile({ profile, selectedSuites: [], evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}` })).rejects.toThrow("CERTIFICATION_SUITE_SELECTION_INVALID");
  await expect(runProtectedCertificationProfile({ profile, selectedSuites: ["admission", "admission"], evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}` })).rejects.toThrow("CERTIFICATION_SUITE_SELECTION_INVALID");
});

test("all-suite dispatch refuses a partial claim inventory even when every adapter reports passed", async () => {
  const claims = { admission: "release.admission_slo", telemetry: "release.telemetry_policy", chaos: "release.database_failover", restore: "release.checkpoint_object", "security-host": "release.compatible_host", "supply-chain": "release.supply_chain", "contextvm-payment-model": "release.contextvm_relay", publication: "release.sealed_upload" };
  const adapters = Object.fromEntries(Object.entries(claims).map(([suite, claim]) => [suite, async () => ({ status: "passed", claims: [claim], limitations: [], reasonCode: "OBSERVATION_COMPLETE" })]));
  const outcome = await runProtectedCertificationProfile({ profile, evidenceDirectory: `/tmp/napplet-cvm-certification-${crypto.randomUUID()}`, registry: { evidenceClass: "deterministic", adapters }, now: () => 1_000 });
  expect(outcome.status).toBe("blocked");
  expect(outcome.records.every((record) => record.status === "passed")).toBe(true);
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
