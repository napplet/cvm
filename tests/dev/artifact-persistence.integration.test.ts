import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { createDevelopmentPool } from "../../scripts/dev-payments";
import { readDevelopmentPaymentConfig } from "./payment-config";
import { LocalArtifactRepository } from "../../src/dev/local-artifact-repository";
import { LocalPreviewGrantStore } from "../../src/dev/local-preview-grant-store";
import type { VerifiedArtifactFacts } from "../../src/dev/local-artifact-verifier";

test("SQL artifacts and grants survive pool recreation, revoke and reject byte tampering", async () => {
  const config = await readDevelopmentPaymentConfig();
  let pool = createDevelopmentPool(config.databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "napplet-artifact-persistence-"));
  const ownerId = "f".repeat(64); const accountId = await accountIdForPrincipal({ pubkey: ownerId }); const nonce = crypto.randomUUID();
  let artifactId: string | undefined;
  try {
    const distRoot = join(root, "source"); await mkdir(distRoot); const body = "<p>immutable fixture bytes</p>"; await writeFile(join(distRoot, "index.html"), body);
    const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
    // A repository boundary fixture, not claimed browser/build evidence.
    const facts = { ownerId, accountId, sessionId: `session:${nonce}`, actionId: `action:${nonce}`, expectedVersion: 0, proposalSha256: "a".repeat(64), toolchainSha256: "b".repeat(64), aggregateSha256: hash(`${hash(body)} /index.html\n`), sealedObjectSha256: "c".repeat(64), verificationEvidenceSha256: "d".repeat(64), distRoot, files: [{ path: "index.html", sha256: hash(body), bytes: Buffer.byteLength(body) }], commandEvidence: [] } satisfies VerifiedArtifactFacts;
    let repository = new LocalArtifactRepository({ objectRoot: join(root, "objects"), pool });
    const [artifact, concurrent] = await Promise.all([repository.commit(facts), new LocalArtifactRepository({ objectRoot: join(root, "objects"), pool }).commit(facts)]); artifactId = artifact.artifactId;
    expect(concurrent).toEqual(artifact);
    expect(artifact.version).toBe(1);
    expect(await repository.commit(facts)).toEqual(artifact);
    let now = Date.now(); let grants = new LocalPreviewGrantStore({ pool, now: () => now });
    const grant = await grants.create({ ownerId, accountId, sessionId: facts.sessionId, artifact, ttlMs: 5_000 });
    const revokedGrant = await grants.create({ ownerId, accountId, sessionId: facts.sessionId, artifact });
    const rows = await pool.query("SELECT count(*)::int AS count FROM development_artifacts WHERE artifact_id=$1", [artifactId]); expect(rows.rows[0].count).toBe(1);
    await pool.end(); pool = createDevelopmentPool(config.databaseUrl);
    repository = new LocalArtifactRepository({ objectRoot: join(root, "objects"), pool }); grants = new LocalPreviewGrantStore({ pool, now: () => now });
    expect(await repository.get(artifactId)).toEqual(artifact);
    expect(new TextDecoder().decode((await repository.read({ artifactId, path: "index.html" }))!.bytes)).toBe(body);
    expect((await grants.authorize({ token: grant.token, ownerId, path: "index.html" }))?.artifactId).toBe(artifactId);
    expect(await grants.authorize({ token: grant.token, ownerId: "e".repeat(64), path: "index.html" })).toBeUndefined();
    await grants.revoke(revokedGrant.token);
    expect(await new LocalPreviewGrantStore({ pool }).authorize({ token: revokedGrant.token, path: "index.html" })).toBeUndefined();
    now += 5_001; expect(await grants.authorize({ token: grant.token, path: "index.html" })).toBeUndefined();
    await expect(grants.create({ ownerId: "e".repeat(64), accountId, sessionId: facts.sessionId, artifact })).rejects.toThrow();
    await expect(repository.commit({ ...facts, ownerId: "e".repeat(64) })).rejects.toThrow();
    await chmod(join(root, "objects", artifact.objectKey, "dist/index.html"), 0o600);
    await writeFile(join(root, "objects", artifact.objectKey, "dist/index.html"), "tampered");
    await expect(repository.read({ artifactId, path: "index.html" })).rejects.toThrow("ARTIFACT_FILE_HASH_MISMATCH");
    expect(await repository.read({ artifactId, path: "../record.json" })).toBeUndefined();
  } finally {
    if (artifactId) { await pool.query("DELETE FROM development_preview_grants WHERE artifact_id=$1", [artifactId]); await pool.query("DELETE FROM development_artifacts WHERE artifact_id=$1", [artifactId]); }
    await pool.end(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
