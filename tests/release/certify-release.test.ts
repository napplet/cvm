import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLiveProtectedCertificationRegistry } from "../../src/certification/live/registry";
import { PROTECTED_SUITES } from "../../src/certification/runner";
import { ReleaseCertificationController } from "../../src/release/controller";
import { createOperatorFundingPrerequisiteController } from "../../src/release/deployment/operator-funding";

const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const candidate = { id: digest("candidate"), provider: "modal" as const, image: `napplet-cvm/worker@sha256:${digest("worker")}`, sourceSha256: digest("source") };
const input = { datasetSha256: digest("dataset"), profileSha256: digest("profile"), topologySha256: digest("topology"), command: ["bun", "test"] };
const architectureRevisionRequired = { progress: "architecture_revision_required", reasonCode: "PRODUCTION_ARCHITECTURE_REVISION_REQUIRED" };

async function isolatedReleaseWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1");
  await mkdir(workspaceRoot, { recursive: true });
  return await mkdtemp(join(workspaceRoot, prefix));
}

test("incomplete execution is reported before expired funding readiness and preserves saved custody", async () => {
  const workspace = await isolatedReleaseWorkspace("certify-expired-funding-");
  try {
    const funding = createOperatorFundingPrerequisiteController({ now: () => 1_000 });
    await funding.capture({ rail: "cashu", secretReference: "os-secret-ref:expired-cashu", capabilitySha256: digest("cashu"), accountScopeSha256: digest("account"), expiresAtMs: 2_000, status: "ready" });
    const stored = JSON.stringify(await funding.readiness());
    const path = join(workspace, "operator-funding-readiness.json");
    await writeFile(path, stored);
    const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--request"], {
      cwd: process.cwd(), env: { ...process.env, NAPPLET_CVM_RELEASE_WORKSPACE: workspace, PATH: "/nonexistent", NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
    expect(JSON.parse(stdout)).toEqual(architectureRevisionRequired);
    expect(await readFile(path, "utf8")).toBe(stored);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

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
  const workspace = await isolatedReleaseWorkspace("certify-resume-");
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

test("fresh documented default workspace stays untouched by activation refusal", async () => {
  const workspace = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")), PATH: "/nonexistent", NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" } as Record<string, string>;
  try {
    const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--request"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
    expect(JSON.parse(stdout)).toEqual(architectureRevisionRequired);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("documented no-env candidate activation refuses before provider effects", async () => {
  const workspace = await isolatedReleaseWorkspace("certify-no-env-");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")), NAPPLET_CVM_RELEASE_WORKSPACE: workspace, PATH: "/nonexistent" } as Record<string, string>;
  try {
    const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--dry-run"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
    expect(JSON.parse(stdout)).toEqual(architectureRevisionRequired);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("status require-state exits zero only on the documented exact match", async () => {
  const workspaceRoot = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await mkdtemp(join(workspaceRoot, "certify-status-"));
  const candidatePath = join(process.cwd(), "toolchains", "candidates", "initial.json");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")),
    NAPPLET_CVM_RELEASE_WORKSPACE: workspace,
    PATH: "/nonexistent",
  } as Record<string, string>;
  try {
    const seeded = await new ReleaseCertificationController({ candidatePath, workspace }).certify();
    expect(seeded.state.status).toBe("authorization_required");

    const matching = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--status", "--require-state=authorization_required"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [matchingCode, matchingStdout, matchingStderr] = await Promise.all([matching.exited, new Response(matching.stdout).text(), new Response(matching.stderr).text()]);
    expect(matchingCode).toBe(0);
    expect(matchingStderr).not.toContain("RELEASE_CERTIFICATION_ARGUMENT_REJECTED");
    expect(JSON.parse(matchingStdout)).toMatchObject({ status: "authorization_required", candidateSha256: seeded.state.candidate.candidateSha256, stateSha256: seeded.state.stateSha256 });

    const unasserted = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--status"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [unassertedCode, unassertedStdout] = await Promise.all([unasserted.exited, new Response(unasserted.stdout).text()]);
    expect(unassertedCode).toBe(1);
    expect(JSON.parse(unassertedStdout)).toMatchObject({ status: "authorization_required" });

    const mismatching = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--status", "--require-state=completed"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [mismatchingCode, mismatchingStdout, mismatchingStderr] = await Promise.all([mismatching.exited, new Response(mismatching.stdout).text(), new Response(mismatching.stderr).text()]);
    expect(mismatchingCode).toBe(1);
    expect(mismatchingStdout).toBe("");
    expect(mismatchingStderr).toContain("RELEASE_CERTIFICATION_STATE_MISMATCH");

    const missing = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--status", "--require-state="], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [missingCode, missingStdout, missingStderr] = await Promise.all([missing.exited, new Response(missing.stdout).text(), new Response(missing.stderr).text()]);
    expect(missingCode).toBe(1);
    expect(missingStdout).toBe("");
    expect(missingStderr).toContain("RELEASE_CERTIFICATION_ARGUMENT_REJECTED");

    const invalid = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--status", "--require-state=not-a-release-state"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [invalidCode, invalidStdout, invalidStderr] = await Promise.all([invalid.exited, new Response(invalid.stdout).text(), new Response(invalid.stderr).text()]);
    expect(invalidCode).toBe(1);
    expect(invalidStdout).toBe("");
    expect(invalidStderr).toContain("RELEASE_CERTIFICATION_STATE_MISMATCH");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a non-dry-run candidate activation refuses before any provider command", async () => {
  const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json"], { cwd: process.cwd(), env: { ...process.env, PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).not.toContain("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
  expect(JSON.parse(stdout)).toEqual(architectureRevisionRequired);
});

test("candidate activation does not consult workspace overrides", async () => {
  const unsafe = Bun.spawn(["bun", "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, NAPPLET_CVM_RELEASE_WORKSPACE: "/tmp/unsafe-release-workspace" }, stdout: "pipe", stderr: "pipe" });
  const [unsafeCode, unsafeStdout, unsafeStderr] = await Promise.all([unsafe.exited, new Response(unsafe.stdout).text(), new Response(unsafe.stderr).text()]);
  expect(unsafeCode).toBe(1);
  expect(unsafeStderr).toContain("error: script \"release:certify\" exited with code 1");
  expect(JSON.parse(unsafeStdout)).toEqual(architectureRevisionRequired);
});

test("a lexically confined workspace symlink remains untouched by activation refusal", async () => {
  const workspaceRoot = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1");
  const outside = await mkdtemp("/tmp/napplet-cvm-cli-workspace-escape-");
  const redirect = join(workspaceRoot, "redirect");
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await symlink(outside, redirect);
    const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--request"], {
      cwd: process.cwd(), env: { ...process.env, NAPPLET_CVM_RELEASE_WORKSPACE: join(redirect, "workspace"), NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("error: script \"release:certify\" exited with code 1");
    expect(JSON.parse(stdout)).toEqual(architectureRevisionRequired);
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(redirect, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("receipt activation refuses before controller record lookup", async () => {
  const workspace = await isolatedReleaseWorkspace("certify-receipt-");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")), NAPPLET_CVM_RELEASE_WORKSPACE: workspace, PATH: "/nonexistent" } as Record<string, string>;
  try {
    const receiptChild = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--receipt", "a".repeat(64)], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [receiptCode, receiptStdout, receiptStderr] = await Promise.all([receiptChild.exited, new Response(receiptChild.stdout).text(), new Response(receiptChild.stderr).text()]);
    expect(receiptCode).toBe(1);
    expect(receiptStderr).toContain("error: script \"release:certify\" exited with code 1");
    expect(JSON.parse(receiptStdout)).toEqual(architectureRevisionRequired);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("immutable bundle verification rejects an absolute caller-selected path before trust loading", async () => {
  const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--verify-bundle", "/tmp/forged-release.json"], {
    cwd: process.cwd(), env: { ...process.env, PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("RELEASE_CERTIFICATION_USAGE");
});

test("request refuses before funding setup or remote price discovery", async () => {
  const workspace = await isolatedReleaseWorkspace("certify-setup-required-");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")), NAPPLET_CVM_RELEASE_WORKSPACE: workspace, PATH: "/nonexistent", NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" } as Record<string, string>;
  try {
    const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--request"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
    expect(JSON.parse(stdout)).toEqual(architectureRevisionRequired);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("product request refuses without asking for credentials or funds", async () => {
  const workspaceRoot = join(process.cwd(), ".runtime", "release-certification", "native-discovery-v1");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = await mkdtemp(join(workspaceRoot, "certify-preapproval-blocked-"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")),
    NAPPLET_CVM_RELEASE_WORKSPACE: workspace,
    PATH: "/nonexistent",
    NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny",
  } as Record<string, string>;
  try {
    const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--request"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
    expect(JSON.parse(stdout)).toEqual(architectureRevisionRequired);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
