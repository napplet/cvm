import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { startPajaServer, PAJA_SIMULATION_DOMAINS } from "@kehto/paja";
import { createDevelopmentPool, developmentStack } from "../../scripts/dev-payments";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { LocalArtifactRepository } from "../../src/dev/local-artifact-repository";
import { DEVELOPMENT_ARTIFACT_CSP, type VerifiedArtifactFacts } from "../../src/dev/local-artifact-verifier";
import { LocalPreviewGrantStore } from "../../src/dev/local-preview-grant-store";
import { createPreviewServer, type PreviewServer } from "../../src/dev-ui/preview-server";

test("real preview HTTP and SQL deny invalid grants, altered bytes, traversal and browser egress", async () => {
  const stack = developmentStack(true);
  const config = await stack.up();
  const pool = createDevelopmentPool(config.databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "napplet-preview-http-")); const nonce = crypto.randomUUID();
  const ownerId = "e".repeat(64); const accountId = await accountIdForPrincipal({ pubkey: ownerId });
  let artifactId: string | undefined; let server: PreviewServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let canary: ReturnType<typeof Bun.serve> | undefined;
  try {
    const body = `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${DEVELOPMENT_ARTIFACT_CSP}"></head><body><p>sealed-${nonce}</p></body></html>`;
    const distRoot = join(root, "source"); await mkdir(distRoot); await writeFile(join(distRoot, "index.html"), body);
    const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
    // This is an asset-boundary fixture; the separate full tracer proves build and Paja execution.
    const facts = { ownerId, accountId, sessionId: `session:${nonce}`, actionId: `action:${nonce}`, expectedVersion: 0, proposalSha256: "a".repeat(64), toolchainSha256: "b".repeat(64), aggregateSha256: hash(`${hash(body)} /index.html\n`), sealedObjectSha256: "c".repeat(64), verificationEvidenceSha256: "d".repeat(64), distRoot, files: [{ path: "index.html", sha256: hash(body), bytes: Buffer.byteLength(body) }], commandEvidence: [] } satisfies VerifiedArtifactFacts;
    let repository = new LocalArtifactRepository({ objectRoot: join(root, "objects"), pool });
    const artifact = await repository.commit(facts); artifactId = artifact.artifactId;
    let now = Date.now(); let grants = new LocalPreviewGrantStore({ pool, now: () => now });
    const grantInput = { ownerId, accountId, sessionId: facts.sessionId, artifact };
    const grant = await grants.create(grantInput);
    const expired = await grants.create({ ...grantInput, ttlMs: 1 });
    const revoked = await grants.create(grantInput); await grants.revoke(revoked.token); now += 2;
    await expect(grants.create({ ...grantInput, ownerId: "d".repeat(64) })).rejects.toThrow("PREVIEW_GRANT_OWNER_BINDING_INVALID");
    expect(await grants.authorize({ token: grant.token, ownerId: "d".repeat(64), path: "index.html" })).toBeUndefined();
    expect(await grants.authorize({ token: grant.token, artifactId: `artifact:sha256:${"f".repeat(64)}`, path: "index.html" })).toBeUndefined();
    const paja = { startPajaServer, domains: PAJA_SIMULATION_DOMAINS };
    server = await createPreviewServer({ repository, grants, paja });
    await server.close();
    repository = new LocalArtifactRepository({ objectRoot: join(root, "objects"), pool });
    grants = new LocalPreviewGrantStore({ pool, now: () => now });
    server = await createPreviewServer({ repository, grants, paja });
    const assetUrl = `${server.url}/preview/${grant.token}/index.html`;
    const response = await fetch(assetUrl); expect(response.status).toBe(200); expect(await response.text()).toBe(body);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    for (const suffix of [`${"0".repeat(64)}/index.html`, `${expired.token}/index.html`, `${revoked.token}/index.html`, `${grant.token}/%2e%2e%2frecord.json`, `${grant.token}/%252e%252e%252frecord.json`, `${grant.token}/%2fetc%2fpasswd`, `${grant.token}/index.html%00`, `${grant.token}/record.json`, `${grant.token}/missing.js`]) {
      const denied = await fetch(`${server.url}/preview/${suffix}`); expect(denied.status).toBe(404); expect(await denied.text()).toBe("not found");
    }
    let outboundRequests = 0;
    canary = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { if (new URL(request.url).pathname === "/canary") outboundRequests++; return new Response("<html><body>foreign origin</body></html>", { headers: { "content-type": "text/html" } }); } });
    const canaryUrl = `http://127.0.0.1:${canary.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto(assetUrl);
    expect(await page.evaluate(async (url) => { try { await fetch(url); return "allowed"; } catch { return "blocked"; } }, `${canaryUrl}/canary`)).toBe("blocked");
    expect(outboundRequests).toBe(0);
    await page.goto(canaryUrl);
    expect(await page.evaluate(async (url) => { try { await fetch(url); return "readable"; } catch { return "blocked"; } }, assetUrl)).toBe("blocked");
    await chmod(join(root, "objects", artifact.objectKey, "dist/index.html"), 0o600);
    await writeFile(join(root, "objects", artifact.objectKey, "dist/index.html"), "altered artifact");
    const altered = await fetch(assetUrl); expect(altered.status).toBe(404); expect(await altered.text()).toBe("not found");
  } finally {
    try {
      canary?.stop(true); await server?.close();
      if (artifactId) { await pool.query("DELETE FROM development_preview_grants WHERE artifact_id=$1", [artifactId]); await pool.query("DELETE FROM development_artifacts WHERE artifact_id=$1", [artifactId]); }
      await pool.end(); await rm(root, { recursive: true, force: true }); await stack.down(true);
    } finally { await browser?.close(); }
  }
}, 120_000);
