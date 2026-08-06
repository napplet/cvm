import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("documented no-env command reports the bounded pre-approval blockers", async () => {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")), PATH: "/nonexistent" } as Record<string, string>;
  const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--dry-run"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).not.toContain("RELEASE_CERTIFICATION_USAGE");
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({
    progress: "preapproval_blocked",
    candidateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    readiness: {
      capabilityDiscovery: { status: "completed", mode: "read_only" },
      pricing: { status: "blocked", reasonCode: "RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED" },
      execution: { status: "blocked", reasonCode: "RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED" },
    },
  });
  expect(JSON.stringify(result)).not.toContain("fixture-catalog");
  expect(result).not.toHaveProperty("authorizationRequestSha256");
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

test("a non-dry-run request rejects local evidence-only config before any provider command", async () => {
  const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json"], { cwd: process.cwd(), env: { ...process.env, PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(`${stdout}${stderr}`).toContain("RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED");
  expect(`${stdout}${stderr}`).not.toContain("RELEASE_LIVE_PROVIDER_FAMILY_UNIMPLEMENTED");
});

test("workspace overrides are confined and status/resume remain candidate-bound", async () => {
  const unsafe = Bun.spawn(["bun", "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, NAPPLET_CVM_RELEASE_WORKSPACE: "/tmp/unsafe-release-workspace" }, stdout: "pipe", stderr: "pipe" });
  const [unsafeCode, unsafeStdout, unsafeStderr] = await Promise.all([unsafe.exited, new Response(unsafe.stdout).text(), new Response(unsafe.stderr).text()]);
  expect(unsafeCode).toBe(1);
  expect(`${unsafeStdout}${unsafeStderr}`).toContain("RELEASE_CERTIFICATION_WORKSPACE_REJECTED");
});

test("a supplied receipt cannot bypass missing current price authority", async () => {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")), PATH: "/nonexistent" } as Record<string, string>;
  const receiptChild = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--receipt", "a".repeat(64)], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const [receiptCode, receiptStdout] = await Promise.all([receiptChild.exited, new Response(receiptChild.stdout).text()]);
  expect(receiptCode).toBe(1);
  const result = JSON.parse(receiptStdout);
  expect(result).toMatchObject({ progress: "preapproval_blocked", readiness: { pricing: { status: "blocked", reasonCode: "RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED" } } });
  expect(result).not.toHaveProperty("receiptValidated");
});

test("request output is a finite redacted blocker projection without launchable consent", async () => {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NAPPLET_CVM_RELEASE_WORKSPACE")), PATH: "/nonexistent", NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" } as Record<string, string>;
  const child = Bun.spawn([Bun.which("bun")!, "run", "release:certify", "--", "--candidate", "toolchains/candidates/initial.json", "--request"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).not.toContain("token");
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ progress: "preapproval_blocked", readiness: { pricing: { status: "blocked" }, execution: { status: "blocked" } } });
  expect(result).not.toHaveProperty("review");
  expect(result).not.toHaveProperty("consentLaunches");
  expect(result.prerequisites).toEqual([
    { kind: "operator_funding_rail", status: "selection_required", allowedChannels: ["nwc", "cashu"] },
    { kind: "owner_manifest_signature", protocol: "nip46", status: "deferred_to_publication" },
  ]);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("NWC");
});

test("product request fails closed with bounded readiness and prerequisite semantics when current price authority is absent", async () => {
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
    expect(stderr).not.toContain("token");
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      progress: "preapproval_blocked",
      readiness: {
        pricing: { status: "blocked", reasonCode: "RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED" },
        execution: { status: "blocked", reasonCode: "RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED" },
      },
    });
    expect(result.prerequisites).toEqual([
      { kind: "operator_funding_rail", status: "selection_required", allowedChannels: ["nwc", "cashu"] },
      { kind: "owner_manifest_signature", protocol: "nip46", status: "deferred_to_publication" },
    ]);
    expect(result).not.toHaveProperty("review");
    expect(result).not.toHaveProperty("consentLaunches");
    expect(JSON.stringify(result)).not.toContain("fixture-catalog");
    expect(JSON.stringify(result)).not.toContain("secret");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
