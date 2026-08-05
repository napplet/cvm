import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSupplyChainVerificationRecord, verifySupplyChainCertification, writeSupplyChainRecord } from "../../src/certification/supply-chain";
import { canonicalJson } from "../../src/promotion/schema";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const artifactSha256 = "a".repeat(64);
const candidateId = "b".repeat(64);
const lockSha256 = "c".repeat(64);
const toolchainSha256 = "d".repeat(64);
const sbom = {
  bomFormat: "CycloneDX", specVersion: "1.5",
  metadata: { tools: [{ vendor: "acme", name: "sealed-toolchain", version: "1", hashes: [{ alg: "SHA-256", content: toolchainSha256 }] }], properties: [{ name: "cvm.lock.sha256", value: lockSha256 }, { name: "cvm.toolchain.sha256", value: toolchainSha256 }] },
  components: [{ type: "library", name: "@napplet/sdk", version: "0.27.2", hashes: [{ alg: "SHA-256", content: "e".repeat(64) }] }],
};
const binding = {
  releaseId: "f".repeat(64), sourceRevision: "1".repeat(40), sourceSha256: "f".repeat(64), supplyChainPolicy: {
    cosign: { executableSha256: digest("approved cosign bytes"), signerIdentity: "https://github.com/acme/napplet/.github/workflows/release.yml@refs/heads/main", issuer: "https://token.actions.githubusercontent.com", predicateType: "https://slsa.dev/provenance/v1" },
    sbom: { bomFormat: "CycloneDX", specVersion: "1.5", generator: { vendor: "acme", name: "sealed-toolchain", version: "1" } },
  }, inputs: {
    controlImageDigest: "2".repeat(64), workerImageDigest: "3".repeat(64), packageLockSha256: lockSha256, toolchainSha256,
    migrationSha256: "4".repeat(64), configSha256: "5".repeat(64), policySha256: "6".repeat(64), datasetSha256: "7".repeat(64), goldenSha256: "8".repeat(64), sbomSha256: digest(canonicalJson(sbom)), provenanceSha256: "0".repeat(64),
  },
};
const provenance = {
  _type: "https://in-toto.io/Statement/v1", subject: [{ name: `registry.example/napplet@sha256:${artifactSha256}`, digest: { sha256: artifactSha256 } }], predicateType: "https://slsa.dev/provenance/v1",
  predicate: { buildDefinition: { externalParameters: { candidateId, sourceRevision: binding.sourceRevision, lockSha256, toolchainSha256, datasetSha256: binding.inputs.datasetSha256 } } },
};
binding.inputs.provenanceSha256 = digest(canonicalJson(provenance));
const cosignBytes = new TextEncoder().encode("approved cosign bytes");
const cosign = { executable: "/protected/bin/cosign", executableSha256: digest(cosignBytes), signerIdentity: "https://github.com/acme/napplet/.github/workflows/release.yml@refs/heads/main", issuer: "https://token.actions.githubusercontent.com", predicateType: provenance.predicateType };
const encodedProvenance = Buffer.from(canonicalJson(provenance)).toString("base64");

function input() {
  return { version: 1, evidenceClass: "protected_live" as const, candidateId, releaseBinding: binding, artifactReference: `registry.example/napplet@sha256:${artifactSha256}`, artifactSha256, cosign, sbom, provenance, reviewedComponents: [{ name: "@napplet/sdk", version: "0.27.2", sha256: "e".repeat(64) }], workingDirectory: "/protected/input" };
}
function runner(stdout = JSON.stringify([{ payloadType: "application/vnd.in-toto+json", payload: encodedProvenance }])) {
  const calls: { executable: string; argv: readonly string[] }[] = [];
  return { calls, run: async (command: { executable: string; argv: readonly string[] }) => { calls.push(command); return { disposition: "passed" as const, stdout, stderr: "" }; } };
}

test("hashes the pinned Cosign binary before one closed identity-bound attestation command and persists redacted facts", async () => {
  const command = runner();
  const verified = await verifySupplyChainCertification(input(), { readExecutable: async () => cosignBytes, run: command.run });
  expect(command.calls).toEqual([{ executable: cosign.executable, argv: ["verify-attestation", "--type", cosign.predicateType, "--certificate-identity", cosign.signerIdentity, "--certificate-oidc-issuer", cosign.issuer, "--output", "json", input().artifactReference] }]);
  expect(verified).toMatchObject({ status: "verified", candidateId, artifactSha256, sbomSha256: binding.inputs.sbomSha256, provenanceSha256: binding.inputs.provenanceSha256 });
  expect(JSON.stringify(verified)).not.toContain("registry.example");
  expect(JSON.stringify(verified)).not.toContain("release.yml");

  const directory = await mkdtemp(join(tmpdir(), "napplet-cvm-supply-chain-"));
  const written = await writeSupplyChainRecord(directory, input(), { readExecutable: async () => cosignBytes, run: runner().run });
  expect(JSON.parse(await readFile(join(directory, `${written.evidenceSha256}.json`), "utf8"))).toEqual(written);
});

test("wrong tool, argv-result, identity, predicate, subject, reviewed contents, binding, malformed data, and raw secrets cannot pass", async () => {
  const cases: Array<{ value: unknown; stdout?: string; executable?: Uint8Array }> = [
    { value: { ...input(), cosign: { ...cosign, executableSha256: "0".repeat(64) } } },
    { value: { ...input(), artifactReference: `registry.example/napplet@sha256:${"0".repeat(64)}` } },
    { value: { ...input(), reviewedComponents: [{ name: "@napplet/sdk", version: "wrong", sha256: "e".repeat(64) }] } },
    { value: { ...input(), releaseBinding: { ...binding, inputs: { ...binding.inputs, packageLockSha256: "0".repeat(64) } } } },
    { value: { ...input(), sbom: { ...sbom, specVersion: "1.4" } } },
    { value: { ...input(), provenance: { ...provenance, subject: [{ ...provenance.subject[0], digest: { sha256: "0".repeat(64) } }] } } },
    { value: { ...input(), extra: "rejected" } },
    { value: input(), stdout: JSON.stringify([{ payloadType: "application/vnd.in-toto+json", payload: "not-base64" }]) },
    { value: input(), stdout: JSON.stringify({ rawSecret: "supersecret" }) },
  ];
  for (const item of cases) await expect(verifySupplyChainCertification(item.value, { readExecutable: async () => item.executable ?? cosignBytes, run: runner(item.stdout).run })).rejects.toThrow();
});

test("manifest-owned Cosign and SBOM policy rejects self-selected identities and freshly rehashed records", async () => {
  const verified = await verifySupplyChainCertification(input(), { readExecutable: async () => cosignBytes, run: runner().run, nowMs: () => 1_000 });
  const selfSelected = { ...input(), cosign: { ...cosign, signerIdentity: "https://github.com/attacker/release.yml@refs/heads/main" } };
  await expect(verifySupplyChainCertification(selfSelected, { readExecutable: async () => cosignBytes, run: runner().run })).rejects.toThrow("SUPPLY_CHAIN_POLICY_MISMATCH");
  await expect(verifySupplyChainCertification({ ...input(), sbom: { ...sbom, metadata: { ...sbom.metadata, tools: [{ ...sbom.metadata.tools[0]!, version: "2" }] } } }, { readExecutable: async () => cosignBytes, run: runner().run })).rejects.toThrow("SUPPLY_CHAIN_POLICY_MISMATCH");

  const substitutedBase = { ...verified, signerIdentitySha256: digest("https://github.com/attacker/release.yml@refs/heads/main") };
  const substituted = { ...substitutedBase, evidenceSha256: digest(canonicalJson(Object.fromEntries(Object.entries(substitutedBase).filter(([key]) => key !== "evidenceSha256" && key !== "contentAddressedPath")))) };
  await expect(validateSupplyChainVerificationRecord({ ...substituted, contentAddressedPath: `evidence/certification/supply-chain/${substituted.evidenceSha256}.json` }, { candidateId, releaseBinding: binding, artifactSha256, nowMs: 1_001 })).rejects.toThrow("SUPPLY_CHAIN_POLICY_MISMATCH");
});
