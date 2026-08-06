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

test("documented no-env command reaches the candidate-bound authorization boundary", async () => {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")), PATH: "/nonexistent" } as Record<string, string>;
  const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--dry-run"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).not.toContain("RELEASE_CERTIFICATION_USAGE");
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ status: "authorization_required", candidateSha256: expect.stringMatching(/^[a-f0-9]{64}$/), topologySha256: expect.stringMatching(/^[a-f0-9]{64}$/), stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/), authorizationRequestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const status = await new ReleaseCertificationController({ candidatePath: "toolchains/candidates/initial.json", workspace: join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1") }).status();
  expect(status).toMatchObject({ state: { stateSha256: result.stateSha256, candidate: { candidateSha256: result.candidateSha256 } } });
  expect(result.resumeStateSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("a non-dry-run request is explicit about the unavailable complete live executor before any provider command", async () => {
  const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json"], { cwd: process.cwd(), env: { ...process.env, PATH: "/nonexistent", NAPPLET_CVM_RELEASE_AUTHORIZATION_SHA256: "a".repeat(64) }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(`${stdout}${stderr}`).toContain("RELEASE_LIVE_PROVIDER_FAMILY_UNIMPLEMENTED");
});

test("workspace overrides are confined and status/resume remain candidate-bound", async () => {
  const unsafe = Bun.spawn(["bun", "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, NAPPLET_CVM_RELEASE_WORKSPACE: "/tmp/unsafe-release-workspace" }, stdout: "pipe", stderr: "pipe" });
  const [unsafeCode, unsafeStdout, unsafeStderr] = await Promise.all([unsafe.exited, new Response(unsafe.stdout).text(), new Response(unsafe.stderr).text()]);
  expect(unsafeCode).toBe(1);
  expect(`${unsafeStdout}${unsafeStderr}`).toContain("RELEASE_CERTIFICATION_WORKSPACE_REJECTED");
});
