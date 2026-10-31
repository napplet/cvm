import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMountedProductionBootstrapConfig } from "../../src/production/bootstrap";
import { loadReleaseExecutionSession } from "../../src/release/production-execution";
import { mountedBillingRecoveryFixture } from "../release/helpers/mounted-billing-recovery-fixture";

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

async function child(args: readonly string[], home: string) {
  const process = Bun.spawn([Bun.which("bun")!, "scripts/certify-release.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: noAmbientEnvironment(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

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
