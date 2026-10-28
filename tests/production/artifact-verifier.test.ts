import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductionArtifactVerifier } from "../../src/production/artifact-verifier";

const directories: string[] = [];
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function facts() {
  const distRoot = await mkdtemp("/tmp/napplet-production-artifact-"); directories.push(distRoot);
  await mkdir(join(distRoot, "assets"));
  const html = "<!doctype html><html><head><link rel=\"stylesheet\" href=\"/assets/app.css\"><script type=\"module\" src=\"/assets/app.js\"></script></head><body><main id=\"app\"></main></body></html>";
  const js = "document.querySelector('#app').textContent = 'ready';";
  const css = "main{display:block}";
  await Promise.all([writeFile(join(distRoot, "index.html"), html), writeFile(join(distRoot, "assets/app.js"), js), writeFile(join(distRoot, "assets/app.css"), css)]);
  const files = [["/index.html", hash(html)], ["/assets/app.js", hash(js)], ["/assets/app.css", hash(css)]].map(([path, sha256]) => ({ path, sha256 }));
  const aggregateHash = hash(files.map((file) => `${file.sha256} ${file.path}\n`).sort().join(""));
  const item = { candidate: { name: "root", dir: "/workspace/project/dist", indexHtml: "/workspace/project/dist/index.html" }, target: "root", kind: 15129 };
  const report = { signing: { type: "none", canSignWithoutPrompt: false, requiresSecretLookup: false, notes: ["no signing input configured"] }, plan: { configPath: "/workspace/project/.napplet/config.json", items: [item] }, manifests: [{ item, files, aggregateHash, template: { kind: 15129, created_at: 1, tags: [...files.map((file) => ["path", file.path, file.sha256]), ["x", aggregateHash, "aggregate"]], content: "" } }], relays: [], blossomServers: [], dryRun: true };
  return { ownerId: "f".repeat(64), accountId: "account:test", sessionId: "session:test", actionId: "action:test", expectedVersion: 0, proposalSha256: "a".repeat(64), toolchainSha256: "b".repeat(64), distRoot, commandEvidence: ["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"].map((name) => ({ name, exitCode: 0, stdout: name === "conformance" ? "5 passed, 0 failed, 5 skipped (10 checks)\nRESULT: CONFORMANT" : name === "dry-run" ? JSON.stringify(report) : "passed" })) };
}

describe("production artifact verifier", () => {
  test("approved server must match both the actual CLI configuration and manifest", async () => {
    const input = await facts(), publication = { server: "https://blossom.example" };
    const report = JSON.parse(input.commandEvidence[7]!.stdout);
    report.blossomServers = [publication.server];
    report.manifests[0].template.tags.push(["server", publication.server]);
    input.commandEvidence[7]!.stdout = JSON.stringify(report);
    expect((await new ProductionArtifactVerifier().verify({ ...input, publication })).publication).toEqual(publication);
    for (const fault of ["config", "missing", "duplicate", "changed"] as const) {
      const changed = structuredClone(report);
      if (fault === "config") changed.blossomServers = ["https://other.example"];
      if (fault === "missing") changed.manifests[0].template.tags = changed.manifests[0].template.tags.filter((tag: string[]) => tag[0] !== "server");
      if (fault === "duplicate") changed.manifests[0].template.tags.push(["server", publication.server]);
      if (fault === "changed") changed.manifests[0].template.tags.find((tag: string[]) => tag[0] === "server")[1] = "https://other.example";
      input.commandEvidence[7]!.stdout = JSON.stringify(changed);
      await expect(new ProductionArtifactVerifier().verify({ ...input, publication })).rejects.toThrow("PRODUCTION_ARTIFACT_PUBLICATION_SERVER_MISMATCH");
    }
  });
  test("accepts the pinned CLI dry-run report and Vite's local asset layout", async () => {
    const verified = await new ProductionArtifactVerifier().verify(await facts());
    expect(verified.files.map((file) => file.path)).toEqual(["assets/app.css", "assets/app.js", "index.html"]);
  });

  test("accepts the actual named-target CLI shape and fences kind, d-tag and plan substitutions", async () => {
    const input = await facts();
    const report = JSON.parse(input.commandEvidence[7]!.stdout);
    const item = { ...report.plan.items[0], kind: 35129, target: "named", dTag: "cvm-proof" };
    report.plan.items = [item]; report.manifests[0].item = item;
    report.manifests[0].template.kind = 35129; report.manifests[0].template.tags.unshift(["d", item.dTag]);
    input.commandEvidence[7]!.stdout = JSON.stringify(report);
    expect((await new ProductionArtifactVerifier().verify(input)).files).toHaveLength(3);
    for (const mutation of ["kind", "name", "duplicate-name", "plan"] as const) {
      const changed = structuredClone(report);
      if (mutation === "kind") changed.manifests[0].template.kind = 15129;
      if (mutation === "name") changed.manifests[0].template.tags[0][1] = "another-name";
      if (mutation === "duplicate-name") changed.manifests[0].template.tags.push(["d", item.dTag]);
      if (mutation === "plan") changed.plan.items[0].dTag = "another-name";
      input.commandEvidence[7]!.stdout = JSON.stringify(changed);
      await expect(new ProductionArtifactVerifier().verify(input)).rejects.toThrow("PRODUCTION_ARTIFACT_MANIFEST_TARGET_MISMATCH");
    }
  });

  test("rejects external HTML resources even when CLI evidence says success", async () => {
    const input = await facts();
    await writeFile(join(input.distRoot, "index.html"), "<!doctype html><script src=\"https://example.invalid/x.js\"></script>");
    await expect(new ProductionArtifactVerifier().verify(input)).rejects.toThrow("PRODUCTION_ARTIFACT_HTML_POLICY_REJECTED");
  });
});
