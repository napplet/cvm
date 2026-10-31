import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMountedProductionBootstrapConfig } from "../../src/production/bootstrap";
import { loadReleaseExecutionSession } from "../../src/release/production-execution";
import { finalizeReleaseCertification } from "../../src/release/finalize";
import { mountedBillingRecoveryFixture } from "../release/helpers/mounted-billing-recovery-fixture";
import { finalizationFixture } from "../release/helpers/finalization-fixtures";

const closedRefusal = {
  progress: "architecture_revision_required",
  reasonCode: "PRODUCTION_ARCHITECTURE_REVISION_REQUIRED",
};

function noAmbientEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: "/nonexistent",
    NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny",
  };
}

async function child(args: readonly string[], home: string, extraEnvironment: Record<string, string> = {}) {
  const process = Bun.spawn([Bun.which("bun")!, "scripts/certify-release.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...noAmbientEnvironment(home), ...extraEnvironment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

async function fixtureWorkspace(prefix: string): Promise<string> {
  const root = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1", "non-google-guard");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

test("current typed mounted configuration is rejected before bootstrap construction", async () => {
  const workspace = await fixtureWorkspace("bootstrap-");
  try {
    const fixture = await mountedBillingRecoveryFixture(workspace, Date.now());
    await expect(loadMountedProductionBootstrapConfig(fixture.runtimeConfigPath))
      .rejects.toThrow("PRODUCTION_ARCHITECTURE_REVISION_REQUIRED");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("receipt-bound pinned session rejects the typed current configuration before mounted authority", async () => {
  const workspace = await fixtureWorkspace("session-");
  try {
    const fixture = await mountedBillingRecoveryFixture(workspace, Date.now());
    const config = JSON.parse(await readFile(fixture.certifierPath, "utf8"));
    await expect(loadReleaseExecutionSession({
      config,
      candidateSha256: fixture.candidateSha256,
      workspace,
      authorization: { request: fixture.request, receipt: fixture.receipt },
    })).rejects.toThrow("PRODUCTION_ARCHITECTURE_REVISION_REQUIRED");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("actual certification activation arguments close before workspace or provider work", async () => {
  const home = await mkdtemp(join(tmpdir(), "napplet-cvm-non-google-cli-home-"));
  try {
    for (const args of [
      ["--candidate", "toolchains/candidates/initial.json", "--request"],
      ["--candidate", "toolchains/candidates/initial.json", "--receipt", "a".repeat(64)],
      ["--candidate", "toolchains/candidates/initial.json", "--setup"],
      ["--candidate", "toolchains/candidates/initial.json", "--dry-run"],
      ["--candidate", "toolchains/candidates/initial.json"],
      ["--verify-bundle", "a".repeat(64)],
    ]) {
      const result = await child(args, home);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual(closedRefusal);
      expect(result.stderr).toBe("");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("protected no-trust-root verification refuses while the pinned local trust-root verifier completes", async () => {
  const workspace = await fixtureWorkspace("bundle-verifier-");
  const home = await mkdtemp(join(tmpdir(), "napplet-cvm-non-google-verifier-home-"));
  try {
    const nowMs = Date.now();
    const fixture = await finalizationFixture(workspace, nowMs);
    const finalized = await finalizeReleaseCertification({
      workspace,
      candidateId: fixture.candidateId,
      topologySha256: fixture.topologySha256,
      authorizationReceiptSha256: fixture.authorizationReceiptSha256,
      protectedRecords: fixture.observations,
      trust: fixture.trust,
      verificationRecords: fixture.verificationRecords,
      sourceMeasurement: { version: 1, sourceRevision: fixture.manifest.sourceRevision, sourceSha256: fixture.manifest.sourceSha256 },
      cleanupPlan: { cleanupByMs: nowMs + 60_000, retainedEvidenceDays: 30, retainedArtifactDays: 30, effects: [] },
      promotion: { async persist() {}, async promote() { return "promoted" as const; } },
      cleanup: { async cleanup() { return "cleaned" as const; } },
      nowMs,
    });
    expect(finalized.status).toBe("promoted");
    if (!finalized.bundleSha256 || !finalized.verificationConfig
      || typeof finalized.verificationConfig.path !== "string" || typeof finalized.verificationConfig.sha256 !== "string") {
      throw new Error(`FINALIZED_BUNDLE_FIXTURE_REQUIRED:${JSON.stringify(finalized)}`);
    }

    const protectedWithoutTrustRoot = JSON.parse(await readFile(finalized.verificationConfig.path, "utf8"));
    delete protectedWithoutTrustRoot.trustRoot;
    const noTrustRootPath = join(workspace, "protected-without-trust-root.json");
    const noTrustRootBytes = JSON.stringify(protectedWithoutTrustRoot);
    await writeFile(noTrustRootPath, noTrustRootBytes, { mode: 0o600 });
    const noTrustRoot = await child(["--verify-bundle", finalized.bundleSha256], home, {
      NAPPLET_CVM_RELEASE_WORKSPACE: workspace,
      NAPPLET_CVM_CERTIFIER_CONFIG: noTrustRootPath,
      NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: sha256(noTrustRootBytes),
    });
    expect(noTrustRoot.code).toBe(1);
    expect(JSON.parse(noTrustRoot.stdout)).toEqual(closedRefusal);
    expect(noTrustRoot.stderr).toBe("");

    const verified = await child(["--verify-bundle", finalized.bundleSha256], home, {
      NAPPLET_CVM_RELEASE_WORKSPACE: workspace,
      NAPPLET_CVM_CERTIFIER_CONFIG: finalized.verificationConfig.path,
      NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: finalized.verificationConfig.sha256,
    });
    expect(verified.stderr).toBe("");
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ progress: "bundle_verified", status: "promoted", bundleSha256: finalized.bundleSha256, cleanup: "completed" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
