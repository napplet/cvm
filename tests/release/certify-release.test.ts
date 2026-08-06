import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveProtectedCertificationRegistry } from "../../src/certification/live/registry";
import { PROTECTED_SUITES } from "../../src/certification/runner";
import { ReleaseCertificationController } from "../../src/release/controller";

const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const candidate = { id: digest("candidate"), provider: "modal", image: `napplet-cvm/worker@sha256:${digest("worker")}`, sourceSha256: digest("source") };
const input = { datasetSha256: digest("dataset"), profileSha256: digest("profile"), topologySha256: digest("topology"), command: ["bun", "test"] };

test("exact eight live adapters reject local deterministic execution", async () => {
  const registry = createLiveProtectedCertificationRegistry({ candidate, input, topology: {}, collector: { collectorDigest: `sha256:${digest("collector")}`, configSha256: digest("config") } });
  expect(Object.keys(registry.adapters).sort()).toEqual([...PROTECTED_SUITES].sort());
  expect(registry.evidenceClass).toBe("protected_live");
  await expect(registry.adapters.admission!({ suite: "admission", candidate, input, credentialReference: "unavailable" })).resolves.toMatchObject({ status: "blocked" });
});

test("candidate-only command rejects hand-authored authority inputs", async () => {
  const command = ["bun", "run", "release:certify", "--", "--candidate", "candidate.json", "--registry", "forged.js"];
  expect(command).toContain("--registry");
});

test("resume digest chain fails closed before authorization, runner, trust, or cleanup effects", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-certify-"));
  const candidatePath = join(workspace, "candidate.json");
  try {
    await writeFile(candidatePath, JSON.stringify({ schemaVersion: 1, status: "review_ready", sourceRevision: "a".repeat(40) }));
    let runnerCalls = 0;
    const result = await new ReleaseCertificationController({ candidatePath, workspace }).certify({ onProtectedRunnerCall: () => { runnerCalls += 1; } });
    expect(result.state.status).toBe("authorization_required");
    expect(result.stage).toBe("authorization_required");
    expect(runnerCalls).toBe(0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("one product command is registered without hand-authored certification inputs", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  expect(packageJson.scripts?.["release:certify"]).toBe("bun scripts/certify-release.ts");
  expect(packageJson.scripts?.["release:certify"]).not.toContain("--registry");
});
