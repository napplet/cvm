import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalToolchainId, parsePromotionManifest } from "../src/promotion/schema";
import { runPromotionCandidate } from "../src/promotion/run-promotion";
import { runHermeticCommand } from "../src/runner/hermetic-command";
import type { LifecycleObservation } from "../src/telemetry/contracts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Bun.file(path).arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function manifest(mode = "success", overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const executable = process.execPath;
  const fixture = join(import.meta.dir, "fixtures", "fake-toolchain.ts");
  return {
    schemaVersion: 1,
    status: "candidate",
    protocol: { nip5dRevision: "a".repeat(40), napRevisions: ["b".repeat(40)] },
    packages: [{ name: "fixture-toolchain", version: "1.2.3", integrity: "sha512-fixture", sourceCommit: "c".repeat(40) }],
    executables: [{ path: executable, sha256: await sha256File(executable) }],
    lockfileSha256: "d".repeat(64),
    scaffoldRevision: "e".repeat(40),
    imageDigest: "f".repeat(64),
    runtimeVersion: Bun.version,
    browserVersion: "chromium-fixture",
    fixtures: [{ name: "tracer", revision: "1".repeat(40), sha256: "2".repeat(64) }],
    goldens: [{ name: "tracer", revision: "3".repeat(40), sha256: "4".repeat(64) }],
    policyVersion: "policy-1",
    workingDirectory: process.cwd(),
    stages: [{ id: "native", executable, argv: [fixture, `--mode=${mode}`], timeoutMs: 200, expectedOutput: { outcome: "ok" } }],
    ...overrides,
  };
}

async function evidenceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "napplet-cvm-tracer-"));
  cleanup.push(directory);
  return directory;
}

async function sealedTestRunner(request: { id: string; args: readonly string[]; executableSha256?: string; timeoutMs?: number; toolchainId: string; imageDigest: string; now?: () => number }) {
  const executable = process.execPath;
  return runHermeticCommand({
    id: request.id,
    executable,
    executableSha256: request.executableSha256 ?? await sha256File(executable),
    allowedExecutables: [{ path: executable, sha256: request.executableSha256 ?? await sha256File(executable) }],
    argv: request.args,
    cwd: process.cwd(),
    timeoutMs: request.timeoutMs ?? 200,
    outputLimitBytes: 64 * 1024,
    toolchainId: request.toolchainId,
    imageDigest: request.imageDigest,
    now: request.now,
  });
}

async function sealedDenialTestRunner() {
  return [];
}

describe("promotion tracer", () => {
  test("runs a fully pinned candidate through command evidence deterministically", async () => {
    const candidate = await manifest();
    const directory = await evidenceDirectory();
    const observations: LifecycleObservation[] = [];
    const options = { evidenceDirectory: directory, now: () => 1_000, runSealed: sealedTestRunner, runDenialProbes: sealedDenialTestRunner, telemetry: { observe: (observation: LifecycleObservation) => { observations.push(observation); } } };
    const first = await runPromotionCandidate(candidate, options);
    const second = await runPromotionCandidate(candidate, options);

    expect(first.status).toBe("blocked");
    expect(first.responsibleStage).toBe("certification-required");
    expect(second).toEqual(first);
    expect(first.candidateId).toBe(await canonicalToolchainId(parsePromotionManifest(candidate)));
    expect(await Bun.file(join(directory, `${first.evidenceSha256}.json`)).exists()).toBeTrue();
    const evidence = await Bun.file(join(directory, `${first.evidenceSha256}.json`)).json() as { artifacts: { status: string }; reproducibility: { status: string }; provenance: { status: string } };
    expect(evidence.artifacts.status).toBe("not-evaluated");
    expect(evidence.reproducibility.status).toBe("not-evaluated");
    expect(evidence.provenance.status).toBe("not-evaluated");
    expect(observations).toEqual([
      expect.objectContaining({ stage: "promotion", outcome: "blocked", correlationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }),
      expect.objectContaining({ stage: "promotion", outcome: "blocked", correlationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }),
    ]);
  });

  test.each([
    ["missing pin", async () => ({ ...(await manifest()), lockfileSha256: "missing" }), "manifest"],
    ["executable mismatch", async () => ({ ...(await manifest()), executables: [{ path: process.execPath, sha256: "0".repeat(64) }] }), "native"],
    ["non-zero exit", async () => manifest("non-zero"), "native"],
    ["timeout", async () => ({ ...(await manifest("timeout")), stages: [{ ...(await manifest("timeout")).stages[0] as Record<string, unknown>, timeoutMs: 5, argv: [join(import.meta.dir, "fixtures", "fake-toolchain.ts"), "--mode=timeout", "--delay", "100"] } ] }), "native"],
    ["malformed output", async () => manifest("malformed"), "native"],
  ])("blocks %s", async (_name, candidate, responsibleStage) => {
    const result = await runPromotionCandidate(await candidate(), { evidenceDirectory: await evidenceDirectory(), now: () => 1_000, runSealed: sealedTestRunner, runDenialProbes: sealedDenialTestRunner });
    expect(result.status).toBe("blocked");
    expect(result.responsibleStage).toBe(responsibleStage);
  });

  test("preserves argv metacharacters as literal fixture input", async () => {
    const literal = "$(touch should-not-exist) ; && | spaced";
    const candidate = await manifest("echo");
    const stage = candidate.stages as Record<string, unknown>[];
    stage[0] = { ...stage[0], argv: [join(import.meta.dir, "fixtures", "fake-toolchain.ts"), "--mode=echo", "--literal", literal], expectedOutput: { outcome: "ok", literal } };
    const result = await runPromotionCandidate(candidate, { evidenceDirectory: await evidenceDirectory(), now: () => 1_000, runSealed: sealedTestRunner, runDenialProbes: sealedDenialTestRunner });
    expect(result.status).toBe("blocked");
    expect(result.responsibleStage).toBe("certification-required");
    expect(await Bun.file(join(process.cwd(), "should-not-exist")).exists()).toBeFalse();
  });
});
