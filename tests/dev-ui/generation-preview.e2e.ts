/**
 * The production-like development tracer intentionally talks to the same
 * artifact and preview authorities used by the local ContextVM composition.
 * Docker execution is enabled only when the pinned image has been built; this
 * keeps the test useful on a fresh checkout while the launcher owns image
 * intake in Plan 55.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { LocalArtifactRepository } from "../../src/dev/local-artifact-repository";
import { LocalArtifactVerifier } from "../../src/dev/local-artifact-verifier";
import { LocalPreviewGrantStore } from "../../src/dev/local-preview-grant-store";
import { createPreviewServer } from "../../src/dev-ui/preview-server";

const requestedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "deterministic-real-worker-compatible-host";
if (requestedCase !== "deterministic-real-worker-compatible-host" && requestedCase !== "boundaries-platform-provider-recovery") throw new Error(`Unknown generation preview case: ${requestedCase}`);

const root = join(import.meta.dir, "../..");
const objectRoot = join(root, ".local", `preview-e2e-${crypto.randomUUID()}`);
await mkdir(join(objectRoot, "dist"), { recursive: true });
// This is deliberately a real browser artifact: the worker path replaces this
// fixture with CLI output when the development image is available.
await writeFile(join(objectRoot, "dist", "index.html"), "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'\"><button id=increment>Increment</button><output id=count>0</output><script>let n=0;increment.onclick=()=>count.textContent=String(++n)</script>");

const repository = new LocalArtifactRepository({ objectRoot });
const verifier = new LocalArtifactVerifier();
const verified = await verifier.verify({
  ownerId: "f".repeat(64), accountId: "account:test", sessionId: "session:test", actionId: "action:test", expectedVersion: 0,
  proposalSha256: "a".repeat(64), toolchainSha256: "b".repeat(64), distRoot: join(objectRoot, "dist"),
  commandEvidence: [{ name: "build", exitCode: 0 }, { name: "verify", exitCode: 0 }, { name: "conformance", exitCode: 0 }, { name: "dry-run", exitCode: 0, stdout: JSON.stringify({ plan: { items: [{}] }, manifests: [{ files: [{ path: "/index.html" }], aggregateHash: "c".repeat(64) }] }) }],
});
const artifact = await repository.commit(verified);
const grants = new LocalPreviewGrantStore();
const grant = await grants.create({ ownerId: "f".repeat(64), accountId: "account:test", sessionId: "session:test", artifact });
const server = await createPreviewServer({ repository, grants, hostPackageRoot: join(root, "tests/dev-ui") });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/preview/${grant.token}/index.html`);
  await page.getByRole("button", { name: "Increment" }).click();
  await page.getByText("1").waitFor();
  const denied = await page.request.get(`${server.url}/preview/${grant.token}/../../package.json`);
  if (denied.status() !== 404) throw new Error("PREVIEW_TRAVERSAL_DISCLOSED");
  if (requestedCase === "boundaries-platform-provider-recovery") {
    const crossOwner = await grants.authorize({ token: grant.token, ownerId: "e".repeat(64), artifactId: artifact.artifactId, path: "index.html" });
    if (crossOwner) throw new Error("CROSS_OWNER_GRANT_ACCEPTED");
  }
  console.log(JSON.stringify({ case: requestedCase, artifactId: artifact.artifactId, aggregateSha256: artifact.aggregateSha256 }));
} finally {
  await browser.close();
  await server.close();
}
