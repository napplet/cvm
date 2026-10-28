import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductionDirectArtifactVerifier } from "../../src/production/direct-artifact-verifier";
import { verifyProductionConformanceReceipt } from "../../src/worker-adapters/conformance-receipt";
import { sealDirectProductionWorkerArtifact } from "../../src/production/sealed-worker-artifact";
import cli from "../fixtures/direct-artifact/cli-current.json";
import sidecar from "../fixtures/direct-artifact/manifest-current.json";
import conformance from "../fixtures/direct-artifact/conformance-current.json";

const directories: string[] = [];
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const receipt = (path: string, value: unknown) => {
  const text = JSON.stringify(value);
  return { path, sha256: hash(text), bytesBase64: Buffer.from(text).toString("base64") };
};
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Unit fixtures retain real CLI/report shapes but replace the artifact and its
// hash. They do not assert execution of any producer or protected suite.
async function facts() {
  const distRoot = await mkdtemp("/tmp/napplet-direct-artifact-"); directories.push(distRoot);
  const html = '<!doctype html><style>main{color:red}</style><main>ready</main>', digest = hash(html);
  await writeFile(join(distRoot, "index.html"), html);
  const report = structuredClone(cli), manifest = structuredClone(sidecar);
  report.manifests[0]!.artifactHash = digest; report.manifests[0]!.files[0]!.sha256 = digest;
  report.manifests[0]!.template.tags.find(tag => tag[0] === "x")![1] = digest;
  manifest.artifactHash = digest; manifest.tags.find(tag => tag[0] === "x")![1] = digest;
  return { artifactContract: "nip5d-direct-v1", ownerId: "f".repeat(64), accountId: "unit:account", sessionId: "unit:session", actionId: "unit:action", expectedVersion: 0, proposalSha256: "a".repeat(64), toolchainSha256: "b".repeat(64), distRoot,
    publication: { server: "https://publication.example" },
    capabilityReceipt: { state: "present", ...receipt("src/capabilities.json", { required: ["storage"], optional: ["intent"] }) },
    conformanceReceipt: receipt("test-results/conformance.json", conformance),
    manifestReceipt: receipt(".nip5a-manifest.json", manifest),
    commandEvidence: ["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"].map(name => ({ name, exitCode: 0, stdout: name === "dry-run" ? JSON.stringify(report) : "unit fixture" })),
  };
}

describe("direct artifact contract", () => {
  test("verifies raw HTML hash and R/O declarations without inventing a legacy aggregate", async () => {
    const input = await facts(), verifier = new ProductionDirectArtifactVerifier();
    const verified = await verifier.verify(input);
    expect(verified.artifactHash).toBe(hash(await Bun.file(join(input.distRoot, "index.html")).text()));
    expect(verified).not.toHaveProperty("aggregateSha256");
    expect(verified.declaration).toEqual({ required: ["storage"], optional: ["intent"] });
    const archive = JSON.parse(new TextDecoder().decode(await sealDirectProductionWorkerArtifact(verified)));
    expect(archive).toMatchObject({ version: 3, artifactContract: "nip5d-direct-v1", artifactHash: verified.artifactHash, build: { ownerId: input.ownerId }, receipts: { conformance: input.conformanceReceipt, manifest: input.manifestReceipt, capability: input.capabilityReceipt, commands: input.commandEvidence } });
    expect(archive).not.toHaveProperty("aggregateSha256");
    expect(archive.files.map((file: { path: string }) => file.path)).toEqual(["index.html"]);
    const bytes = Buffer.from(input.manifestReceipt.bytesBase64, "base64");
    await writeFile(join(input.distRoot, ".nip5a-manifest.json"), bytes);
    expect((await verifier.verify(input)).verificationEvidenceSha256).toBe(verified.verificationEvidenceSha256);
    await writeFile(join(input.distRoot, ".nip5a-manifest.json"), "{}");
    await expect(verifier.verify(input)).rejects.toThrow("SIDECAR_MISMATCH");
  });
  test("rejects undeployed side files and byte substitutions", async () => {
    const input = await facts(), verifier = new ProductionDirectArtifactVerifier();
    await writeFile(join(input.distRoot, "extra.js"), "hi");
    await expect(verifier.verify(input)).rejects.toThrow("SINGLE_FILE_REQUIRED");
    await rm(join(input.distRoot, "extra.js"));
    await writeFile(join(input.distRoot, "index.html"), "<!doctype html><main>changed</main>");
    await expect(verifier.verify(input)).rejects.toThrow("HASH_MISMATCH");
  });
  test("rejects changed CLI target, server, format, capabilities and legacy hash semantics", async () => {
    const input = await facts();
    const report: typeof cli = JSON.parse(input.commandEvidence[7]!.stdout);
    const mutations: Array<(value: typeof cli) => void> = [
      value => { value.manifests[0]!.artifactHash = "0".repeat(64); },
      value => { value.plan.items[0]!.dTag = "other"; },
      value => { value.manifests[0]!.format = "legacy"; },
      value => { value.blossomServers = ["https://other.example"]; },
      value => { value.manifests[0]!.template.tags.push(["server", "https://publication.example"]); },
      value => { value.manifests[0]!.template.tags.push(["R", "storage"]); },
      value => { value.manifests[0]!.template.tags.push(["O", "relay"]); },
      value => { value.manifests[0]!.template.tags.push(["path", "/index.html", value.manifests[0]!.artifactHash]); },
      value => { value.manifests[0]!.template.tags.find(tag => tag[0] === "x")!.push("aggregate"); },
      value => { Object.assign(value.manifests[0]!, { aggregateHash: "0".repeat(64) }); },
      value => { value.signing.type = "secret"; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(report); mutate(changed);
      await expect(new ProductionDirectArtifactVerifier().verify({ ...input, commandEvidence: input.commandEvidence.map(command => command.name === "dry-run" ? { ...command, stdout: JSON.stringify(changed) } : command) })).rejects.toThrow();
    }
  });
  test("requires explicit, conflict-free declaration and unsigned, exact sidecar receipt", async () => {
    const input = await facts(), verifier = new ProductionDirectArtifactVerifier();
    await expect(verifier.verify({ ...input, capabilityReceipt: { state: "absent", path: "src/capabilities.json" } })).rejects.toThrow("DECLARATION_REQUIRED");
    for (const declaration of [{ required: ["storage", "storage"], optional: [] }, { required: ["storage"], optional: ["storage"] }, { required: ["storage.get"], optional: [] }, { required: [], optional: [] }]) {
      await expect(verifier.verify({ ...input, capabilityReceipt: { state: "present", ...receipt("src/capabilities.json", declaration) } })).rejects.toThrow();
    }
    for (const manifest of [{ ...sidecar, sig: "0".repeat(128) }, { ...sidecar, artifactHash: "0".repeat(64) }]) await expect(verifier.verify({ ...input, manifestReceipt: receipt(".nip5a-manifest.json", manifest) })).rejects.toThrow();
    await expect(verifier.verify({ ...input, manifestReceipt: { ...input.manifestReceipt, sha256: "0".repeat(64) } })).rejects.toThrow();
  });
  test("requires each producer stage and the actual structured browser checks", async () => {
    const input = await facts(), verifier = new ProductionDirectArtifactVerifier();
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const changed = structuredClone(input); changed.commandEvidence[index]!.exitCode = 1;
      await expect(verifier.verify(changed)).rejects.toThrow();
    }
    const failed = structuredClone(conformance); failed.checks[9]!.status = "skip"; failed.summary.passed--; failed.summary.skipped++;
    await expect(verifier.verify({ ...input, conformanceReceipt: receipt("test-results/conformance.json", failed) })).rejects.toThrow("CONFORMANCE_REJECTED");
    const changed = structuredClone(input); changed.commandEvidence[0]!.name = "build";
    await expect(verifier.verify(changed)).rejects.toThrow("COMMAND_NOT_PASSED");
  });
});

describe("structured standalone conformance receipt", () => {
  test("retains the actual measured passes and explicit unsigned/lifecycle skips", () => {
    const verified = verifyProductionConformanceReceipt(receipt("test-results/conformance.json", conformance));
    expect(verified.report.summary).toEqual({ total: 11, passed: 6, failed: 0, skipped: 5, errors: 0, warnings: 0 });
  });
  test("cannot pass via claimed ok, counts, duplicate IDs, skipped required checks or missing checks", () => {
    const mutations: Array<(value: typeof conformance) => void> = [
      value => { value.summary.passed++; },
      value => { value.ok = false; },
      value => { value.finishedAt = value.startedAt - 1; },
      value => { value.checks.push(value.checks[5]!); value.summary.total++; value.summary.passed++; },
      value => { value.checks[9]!.status = "skip"; value.summary.passed--; value.summary.skipped++; },
      value => { value.checks.splice(9, 1); value.summary.total--; value.summary.passed--; },
      value => { value.checks[5]!.status = "fail"; value.summary.failed++; value.summary.errors++; value.summary.passed--; },
      value => { value.checks[10]!.id = "unknown/skipped"; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(conformance); mutate(changed);
      expect(() => verifyProductionConformanceReceipt(receipt("test-results/conformance.json", changed))).toThrow();
    }
    const valid = receipt("test-results/conformance.json", conformance);
    expect(() => verifyProductionConformanceReceipt({ ...valid, bytesBase64: valid.bytesBase64 + "\n" })).toThrow();
    expect(() => verifyProductionConformanceReceipt({ ...valid, sha256: "0".repeat(64) })).toThrow();
  });
});
