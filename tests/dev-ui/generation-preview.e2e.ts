/**
 * The production-like development tracer intentionally talks to the same
 * artifact and preview authorities used by the local ContextVM composition.
 * Docker execution is enabled only when the pinned image has been built; this
 * keeps the test useful on a fresh checkout while the launcher owns image
 * intake in Plan 55.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { PAJA_SIMULATION_DOMAINS, startPajaServer } from "@kehto/paja";
import { LocalArtifactRepository } from "../../src/dev/local-artifact-repository";
import { LocalArtifactVerifier } from "../../src/dev/local-artifact-verifier";
import { LocalPreviewGrantStore } from "../../src/dev/local-preview-grant-store";
import { LocalNappletWorker } from "../../src/dev/local-napplet-worker";
import { createPreviewServer } from "../../src/dev-ui/preview-server";

const requestedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "deterministic-real-worker-compatible-host";
if (requestedCase !== "deterministic-real-worker-compatible-host" && requestedCase !== "boundaries-platform-provider-recovery") throw new Error(`Unknown generation preview case: ${requestedCase}`);

const root = join(import.meta.dir, "../..");
const objectRoot = join(root, ".local", `preview-e2e-${crypto.randomUUID()}`);
await mkdir(join(objectRoot, "dist"), { recursive: true });
const worker = new LocalNappletWorker();
const work = await worker.materialize({ proposalSha256: "a".repeat(64), proposal: { reference: `proposal:sha256:${"a".repeat(64)}`, sha256: "a".repeat(64), files: [
  { path: "src/main.ts", content: "import { runtimeHasDomain } from './domain-availability.js'; import './styles.css'; void runtimeHasDomain('theme'); const root=document.querySelector<HTMLElement>('#app')!; root.innerHTML='<button id=increment>Increment</button><output id=count>0</output>'; let n=0; document.querySelector<HTMLButtonElement>('#increment')!.onclick=()=>document.querySelector('#count')!.textContent=String(++n);" },
  { path: "src/styles.css", content: "html, body, #app { height: 100%; } button{padding:1rem}" },
] } } as any);

const repository = new LocalArtifactRepository({ objectRoot });
const verifier = new LocalArtifactVerifier();
const verified = await verifier.verify({
  ownerId: "f".repeat(64), accountId: "account:test", sessionId: "session:test", actionId: "action:test", expectedVersion: 0,
  proposalSha256: "a".repeat(64), toolchainSha256: work.toolchainSha256, distRoot: work.distRoot, commandEvidence: work.commandEvidence,
});
const artifact = await repository.commit(verified);
const grants = new LocalPreviewGrantStore();
const grant = await grants.create({ ownerId: "f".repeat(64), accountId: "account:test", sessionId: "session:test", artifact });
const server = await createPreviewServer({ repository, grants, paja: { startPajaServer, domains: PAJA_SIMULATION_DOMAINS } });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pajaUrl = await server.openPaja(grant.token);
  await page.goto(pajaUrl);
  const frame = page.frameLocator("iframe").first();
  await frame.getByRole("button", { name: "Increment" }).click();
  await frame.getByText("1").waitFor();
  const sandbox = await page.locator("iframe").first().getAttribute("sandbox");
  const isolation = await page.frames()[1]!.evaluate(() => ({ origin: location.origin, hasNostr: typeof (window as any).nostr, hasShell: typeof (window as any).napplet?.shell }));
  if (sandbox !== "allow-scripts" || isolation.origin !== "null" || isolation.hasNostr !== "undefined" || isolation.hasShell !== "object") throw new Error("PAJA_PREVIEW_BOUNDARY_INVALID");
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
  await work.cleanup();
}
