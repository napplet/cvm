import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCertifierConfig } from "../../src/certification/config";
import { canonicalJson } from "../../src/promotion/schema";
import { completeFinalizationCleanup, verifyFinalizationCleanup } from "../../src/release/finalization-cleanup";
import { finalizeReleaseCertification } from "../../src/release/finalize";
import { verifyFinalizedRelease } from "../../src/release/verify-finalization";
import { finalizationFixture } from "./helpers/finalization-fixtures";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

test("cleanup lost response survives fresh coordinator and only observes original operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cvm-cleanup-"));
  try {
    let calls = 0, queries = 0;
    const expected = { root, operationId: "promotion-test", bundleSha256: digest("bundle"), effects: [{ providerOperationId: "original-worker", resourceIdentitySha256: digest("worker") }] };
    expect(await completeFinalizationCleanup({ ...expected, port: { async cleanup() { calls++; throw new Error("response lost"); } } })).toBe(false);
    await expect(verifyFinalizationCleanup(expected)).rejects.toThrow("RELEASE_FINALIZATION_CLEANUP_INCOMPLETE");
    expect(await completeFinalizationCleanup(expected)).toBe(false);
    const port = {
      async cleanup() { calls++; return "cleaned" as const; },
      async observe(input: { operationId: string }) { queries++; expect(input.operationId).toBe("promotion-test:cleanup:original-worker"); return "cleaned" as const; },
    };
    expect(await completeFinalizationCleanup({ ...expected, port })).toBe(true);
    await verifyFinalizationCleanup(expected);
    expect(await completeFinalizationCleanup({ ...expected, port })).toBe(true);
    expect(calls).toBe(1); expect(queries).toBe(1);
    await expect(verifyFinalizationCleanup({ ...expected, effects: [{ ...expected.effects[0]!, resourceIdentitySha256: digest("other") }] })).rejects.toThrow("RELEASE_FINALIZATION_CLEANUP_INCOMPLETE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent cleanup claims dispatch once; absence of a cleanup port cannot complete required work", async () => {
  const root = await mkdtemp(join(tmpdir(), "cvm-cleanup-race-"));
  try {
    let calls = 0;
    const expected = { root, operationId: "promotion-race", bundleSha256: digest("race"), effects: [{ providerOperationId: "original-worker", resourceIdentitySha256: digest("worker") }] };
    expect(await completeFinalizationCleanup(expected)).toBe(false);
    const results = await Promise.all(Array.from({ length: 8 }, () => completeFinalizationCleanup({ ...expected, port: { async cleanup() { calls++; await Bun.sleep(10); return "cleaned"; } } })));
    expect(results).toContain(true); expect(calls).toBe(1);
    await verifyFinalizationCleanup(expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual finalizer output verifies through pinned authority and blocks mutation, stale evidence and missing cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cvm-finalized-bundle-"));
  try {
    const fixture = await finalizationFixture(root);
    let promotions = 0, cleanupCalls = 0;
    let persistedAuthority: unknown;
    class Promotion {
      #persisted = false;
      async persist(value: { verificationAuthority?: unknown }) { this.#persisted = true; persistedAuthority = value.verificationAuthority; }
      async promote() { if (!this.#persisted) throw new Error("PERSIST_REQUIRED"); promotions++; return "promoted" as const; }
    }
    const input = { workspace: root, candidateId: fixture.candidateId, topologySha256: fixture.topologySha256, authorizationReceiptSha256: fixture.authorizationReceiptSha256,
      protectedRecords: fixture.observations, trust: fixture.trust, verificationRecords: fixture.verificationRecords,
      sourceMeasurement: { version: 1, sourceRevision: fixture.manifest.sourceRevision, sourceSha256: fixture.manifest.sourceSha256 },
      cleanupPlan: { cleanupByMs: 10_000, retainedEvidenceDays: 30, retainedArtifactDays: 30, effects: [{ providerOperationId: "worker-op", resourceIdentitySha256: digest("worker") }] },
      promotion: new Promotion(), nowMs: 2_000,
    };
    const incomplete = await finalizeReleaseCertification(input);
    expect(incomplete.status).toBe("cleanup_incomplete");
    const releaseRoot = join(root, "release-finalizations", fixture.candidateId);
    expect(await readdir(releaseRoot)).not.toContain("current.json");
    const result = await finalizeReleaseCertification({ ...input, cleanup: { async cleanup() { cleanupCalls++; return "cleaned"; } } });
    expect(result.status).toBe("promoted"); expect(persistedAuthority).toEqual(result.verificationConfig); expect(promotions).toBe(1); expect(cleanupCalls).toBe(1);
    const config = await loadCertifierConfig({ env: { NAPPLET_CVM_CERTIFIER_CONFIG: result.verificationConfig!.path, NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: result.verificationConfig!.sha256 } });
    if (config.mode !== "protected") throw new Error("fixture authority missing");
    const verification = { workspace: root, bundleSha256: result.bundleSha256!, config, configSha256: result.verificationConfig!.sha256, nowMs: 2_000 };
    expect(await verifyFinalizedRelease(verification)).toMatchObject({ status: "promoted", bundleSha256: result.bundleSha256, cleanup: "completed" });
    await expect(verifyFinalizedRelease({ ...verification, configSha256: digest("substituted") })).rejects.toThrow("RELEASE_FINALIZATION_BINDING_REJECTED");
    await expect(verifyFinalizedRelease({ ...verification, nowMs: 100_000 })).rejects.toThrow("CERTIFICATION_OBSERVATION_STALE");
    const bundlePath = join(releaseRoot, "bundles", `${result.bundleSha256}.json`);
    const bytes = await readFile(bundlePath, "utf8");
    const bundle = JSON.parse(bytes); bundle.receipts.push("forged");
    await writeFile(bundlePath, canonicalJson(bundle));
    await expect(verifyFinalizedRelease(verification)).rejects.toThrow("RELEASE_FINALIZATION_BUNDLE_DIGEST_INVALID");
    await writeFile(bundlePath, bytes);
    const cleanupPath = join(releaseRoot, "cleanup", `${digest(`${result.operationId}:cleanup:worker-op`)}.json`);
    const cleanupBytes = await readFile(cleanupPath, "utf8");
    await rm(cleanupPath); await writeFile(join(root, "replacement.json"), cleanupBytes);
    await symlink(join(root, "replacement.json"), cleanupPath);
    await expect(verifyFinalizedRelease(verification)).rejects.toThrow("RELEASE_FINALIZATION_PATH_REJECTED");
    await rm(cleanupPath); await writeFile(cleanupPath, cleanupBytes);
    await rm(join(releaseRoot, "completed", `${result.bundleSha256}.json`));
    await expect(verifyFinalizedRelease(verification)).rejects.toThrow();
    expect(promotions).toBe(1); expect(cleanupCalls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lost promotion response is fenced across fresh finalizers and reconciled only by original-operation query", async () => {
  const root = await mkdtemp(join(tmpdir(), "cvm-promotion-lost-"));
  try {
    const fixture = await finalizationFixture(root);
    let dispatches = 0, queries = 0;
    const sent: string[] = [];
    const promotion = { async persist() {}, async promote(value: { operationId: string }) { dispatches++; sent.push(value.operationId); throw new Error("response lost after pointer changed"); } };
    const input = { workspace: root, candidateId: fixture.candidateId, topologySha256: fixture.topologySha256, authorizationReceiptSha256: fixture.authorizationReceiptSha256,
      protectedRecords: fixture.observations, trust: fixture.trust, verificationRecords: fixture.verificationRecords,
      sourceMeasurement: { version: 1, sourceRevision: fixture.manifest.sourceRevision, sourceSha256: fixture.manifest.sourceSha256 },
      cleanupPlan: { cleanupByMs: 10_000, retainedEvidenceDays: 30, retainedArtifactDays: 30, effects: [] }, promotion, nowMs: 2_000 };
    const first = await finalizeReleaseCertification(input);
    expect(first.status).toBe("blocked");
    expect((await finalizeReleaseCertification(input)).status).toBe("blocked");
    const recovered = await finalizeReleaseCertification({ ...input, promotion: { ...promotion, async observe(value) { queries++; expect(value.operationId).toBe(sent[0]!); return "promoted"; } } });
    expect(recovered.status).toBe("promoted"); expect(recovered.bundleSha256).toBe(first.bundleSha256);
    expect(dispatches).toBe(1); expect(queries).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
