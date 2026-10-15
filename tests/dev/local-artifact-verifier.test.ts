import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactVerifier, type TrustedCoreArtifactFacts } from "../../src/dev/local-artifact-verifier";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const html = `<!doctype html>\n<html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Fixture</title></head><body><div id="app"></div><script>document.querySelector('#app').textContent='Ready'</script></body></html>`;
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

async function fixture(body = html): Promise<TrustedCoreArtifactFacts> {
  const distRoot = await mkdtemp(join(tmpdir(), "napplet-artifact-verifier-")); directories.push(distRoot);
  await writeFile(join(distRoot, "index.html"), body);
  const file = { path: "/index.html", sha256: hash(body) };
  const aggregateHash = hash(`${file.sha256} ${file.path}\n`);
  const item = { candidate: { name: "fixture", dir: "/work/project/dist", indexHtml: "/work/project/dist/index.html" }, target: "root", kind: 15129 };
  const dry = { dryRun: true, plan: { items: [item] }, manifests: [{ item, files: [file], aggregateHash, template: { kind: 15129, created_at: 1, tags: [["path", file.path, file.sha256], ["x", aggregateHash, "aggregate"]], content: "" } }] };
  return { ownerId: "f".repeat(64), accountId: "account:test", sessionId: "session:test", actionId: "action:test", expectedVersion: 0, proposalSha256: "a".repeat(64), toolchainSha256: "b".repeat(64), distRoot,
    commandEvidence: ["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"].map((name) => ({ name: name as TrustedCoreArtifactFacts["commandEvidence"][number]["name"], exitCode: 0, stdout: name === "dry-run" ? JSON.stringify(dry) : name === "conformance" ? "5 passed, 0 failed, 5 skipped (10 checks)\nRESULT: CONFORMANT" : "passed" })) };
}
function changeDry(input: TrustedCoreArtifactFacts, edit: (value: any) => void): TrustedCoreArtifactFacts {
  return { ...input, commandEvidence: input.commandEvidence.map((stage) => {
    if (stage.name !== "dry-run") return stage;
    const dry = JSON.parse(stage.stdout!); edit(dry); return { ...stage, stdout: JSON.stringify(dry) };
  }) };
}

describe("independent development artifact verification", () => {
  test("accepts actual matching bytes and the CLI's legacy aggregate convention", async () => {
    const facts = await fixture(); const result = await new LocalArtifactVerifier().verify(facts);
    expect(result.files).toEqual([{ path: "index.html", sha256: hash(html), bytes: Buffer.byteLength(html) }]);
    expect(result.aggregateSha256).toBe(hash(`${hash(html)} /index.html\n`));
  });
  test("rejects altered bytes even when worker commands all report success", async () => {
    const facts = await fixture(); await writeFile(join(facts.distRoot, "index.html"), html.replace("Ready", "Changed"));
    await expect(new LocalArtifactVerifier().verify(facts)).rejects.toThrow();
  });
  test("rejects forged aggregate and manifest path-tag identities", async () => {
    const facts = await fixture();
    await expect(new LocalArtifactVerifier().verify(changeDry(facts, (dry) => { dry.manifests[0].aggregateHash = "c".repeat(64); }))).rejects.toThrow();
    await expect(new LocalArtifactVerifier().verify(changeDry(facts, (dry) => { dry.manifests[0].template.tags[0][2] = "d".repeat(64); }))).rejects.toThrow();
  });
  test("rejects symlinks and extra unmanifested files instead of silently skipping them", async () => {
    const facts = await fixture(); await symlink(join(facts.distRoot, "index.html"), join(facts.distRoot, "escape.html"));
    await expect(new LocalArtifactVerifier().verify(facts)).rejects.toThrow();
    await rm(join(facts.distRoot, "escape.html")); await writeFile(join(facts.distRoot, "extra.js"), "unmanifested");
    await expect(new LocalArtifactVerifier().verify(facts)).rejects.toThrow();
  });
  test("requires the exact trusted CSP first in the real head, not a comment or script string", async () => {
    const commented = html.replace(`<meta http-equiv="Content-Security-Policy" content="${csp}">`, `<!-- Content-Security-Policy ${csp} -->`);
    await expect(new LocalArtifactVerifier().verify(await fixture(commented))).rejects.toThrow();
    await expect(new LocalArtifactVerifier().verify(await fixture(html.replace("script-src 'unsafe-inline'", "script-src https: 'unsafe-inline'")))).rejects.toThrow();
  });
  test("rejects actual external resources and refresh navigation", async () => {
    await expect(new LocalArtifactVerifier().verify(await fixture(html.replace("</head>", '<script src="https://example.invalid/code.js"></script></head>')))).rejects.toThrow();
    await expect(new LocalArtifactVerifier().verify(await fixture(html.replace("</head>", '<meta http-equiv="refresh" content="0;url=https://example.invalid"></head>')))).rejects.toThrow();
  });
  test("requires each ordered command once and actual successful conformance output", async () => {
    const facts = await fixture();
    await expect(new LocalArtifactVerifier().verify({ ...facts, commandEvidence: [{ name: "build", exitCode: 1 }, ...facts.commandEvidence] })).rejects.toThrow();
    await expect(new LocalArtifactVerifier().verify({ ...facts, commandEvidence: facts.commandEvidence.map((stage) => stage.name === "conformance" ? { ...stage, stdout: "0 passed, 5 failed, 5 skipped\nRESULT: NONCONFORMANT" } : stage) })).rejects.toThrow();
    await expect(new LocalArtifactVerifier().verify(changeDry(facts, (dry) => { dry.plan.items = []; }))).rejects.toThrow();
  });
});
