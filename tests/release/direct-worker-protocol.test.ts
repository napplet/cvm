import { expect, test } from "bun:test";
import { verifyProductionDirectManifestReceipt } from "../../src/worker-adapters/direct-manifest-receipt";
import { ProductionCapabilityDeclarationSchema } from "../../src/worker-adapters/capability-receipt";
import { generateCapabilitiesWorkerProfile } from "../../scripts/generate-capabilities-worker-profile";

const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const artifactHash = "a".repeat(64);
const declaration = { required: ["storage"], optional: ["theme"] };
const purpose = "Keep one short note";
const manifest: ReturnType<typeof verifyProductionDirectManifestReceipt> = { kind: 35129, created_at: 1, content: purpose, artifactHash, tags: [["d", "my-napplet"], ["x", artifactHash], ["R", "storage"], ["O", "theme"]] };
const receipt = (value: unknown) => { const text = JSON.stringify(value); return { path: ".nip5a-manifest.json", sha256: hash(text), bytesBase64: Buffer.from(text).toString("base64") }; };

test("direct receipt preserves raw identity, purpose and required/optional metadata", () => {
  expect(verifyProductionDirectManifestReceipt(receipt(manifest), { artifactHash, declaration, purpose })).toEqual(manifest);
  for (const changed of [
    { ...manifest, kind: 15129 },
    { ...manifest, artifactHash: "b".repeat(64) },
    { ...manifest, content: "A different purpose" },
    { ...manifest, pubkey: "f".repeat(64) },
    { ...manifest, tags: [...manifest.tags, ["R", "storage"]] },
    { ...manifest, tags: [...manifest.tags, ["requires", "storage"]] },
    { ...manifest, tags: manifest.tags.filter(tag => tag[0] !== "O") },
  ]) expect(() => verifyProductionDirectManifestReceipt(receipt(changed), { artifactHash, declaration, purpose })).toThrow();
  const valid = receipt(manifest);
  expect(() => verifyProductionDirectManifestReceipt({ ...valid, bytesBase64: valid.bytesBase64 + "\n" }, { artifactHash, declaration, purpose })).toThrow();
  expect(ProductionCapabilityDeclarationSchema.safeParse({ required: ["storage"], optional: ["storage"] }).success).toBe(false);
});

test("direct profile retains authoritative scaffold scripts and legacy default", async () => {
  const archived = await Bun.file("toolchains/recipes/capabilities-worker-profile.json").json();
  // Archived profile bytes remain readable for evidence and resume. New builds
  // must use an explicitly versioned unpromoted selector instead of rewriting
  // a profile that may already bind a retained image.
  expect(archived).toMatchObject({ status: "prepared-profile-not-promoted", artifactContract: "nip5d-direct-v1", sourceVersion: 2, transportBundleVersion: 3, promotion: { selected: false, protectedEvidence: null } });
  const selected = await Bun.file("toolchains/recipes/capabilities-worker-current.json").json();
  expect(selected).toMatchObject({ version: 1, status: "unpromoted", profile: "toolchains/recipes/capabilities-worker-profile-v3-unpromoted.json", sourceVersion: 3, promotion: { selected: false, protectedEvidence: null } });
  const profile = await Bun.file(selected.profile).json();
  expect(profile).toMatchObject({ status: "prepared-profile-not-promoted", artifactContract: "nip5d-direct-v1", workerContract: "edge-native-v3-unpromoted", workerImageTarget: "edge-production-worker", sourceVersion: 3, transportBundleVersion: 4, promotion: { selected: false, protectedEvidence: null } });
  expect(profile.inputs).toEqual([...profile.inputs].sort((left, right) => left.path.localeCompare(right.path)));
  for (const input of profile.inputs) expect(new Bun.CryptoHasher("sha256").update(await Bun.file(input.path).bytes()).digest("hex")).toBe(input.sha256);
  const generated = await generateCapabilitiesWorkerProfile();
  expect(profile).toEqual(generated.profile);
  expect(selected).toEqual(generated.selector);
  const legacy = await Bun.file("infra/toolchain/Dockerfile").text();
  const direct = await Bun.file("infra/toolchain/capabilities.Dockerfile").text();
  const cli = await Bun.file("toolchains/recipes/napplet-cli-0.13.0-capabilities-source-build.json").json();
  expect(legacy).not.toContain("capabilities-worker");
  expect(legacy).toContain("toolchains/locks/initial/");
  expect(direct).toContain(cli.upstream.commit);
  expect(direct).toContain("edge-production-worker");
  expect(direct).toContain(cli.upstream.sourceArchiveSha256);
  expect(direct).toContain(cli.upstream.sourceLockSha256);
  expect(direct).toContain(cli.lockOverlay.sha256);
  for (const digest of Object.values(cli.build.targets)) expect(direct).toContain(String(digest));
  const template = await Bun.file("toolchains/overlays/capabilities-template/package.json").json();
  expect(template.packageManager).toBe("pnpm@10.8.0");
  expect(template.scripts.verify).toBe("pnpm test:guidance && pnpm type-check && pnpm build");
  expect(template.scripts["test:conformance"]).toBe("pnpm build && napplet-conformance ./dist");
  const config = await Bun.file("toolchains/overlays/capabilities-template/vite.config.ts").text();
  expect(config).toContain("artifactMode: 'single-file'");
  expect(config).toContain("description: authoring.purpose");
  expect(config).toContain("requires: capabilities.required");
  expect(config).toContain("optional: capabilities.optional");
});
