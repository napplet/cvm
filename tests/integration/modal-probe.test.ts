import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import {
  ModalWorkerAdapter,
  ModalWorkerConfigSchema,
  runModalIsolationProbe,
  type ModalSdkPort,
} from "../../src/worker-adapters/modal-worker";
import { PHASE_02_POLICY_INITIAL } from "../../src/policy/phase-02-policy";

const request = {
  sessionId: "session-1",
  actionId: "action-1",
  expectedVersion: 0,
  policyVersion: PHASE_02_POLICY_INITIAL.policyVersion,
  capabilityGrant: "grant-1",
  workspaceId: "workspace-1",
  idea: "make a focused napplet",
};

function config() {
  return {
    appName: "napplet-cvm-modal-probe",
    image: "registry.example/napplet-cvm@sha256:" + "a".repeat(64),
    workspaceRoot: "/workspace",
    policyVersion: PHASE_02_POLICY_INITIAL.policyVersion,
    tags: { correlation: "test-correlation" },
  };
}

function fakeSdk(options: { output?: string; exitCode?: number; execError?: Error; terminateError?: Error } = {}): { sdk: ModalSdkPort; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { app: [], image: [], create: [], exec: [], terminate: [] };
  const sandbox = {
    id: "sandbox-test",
    async exec(argv: readonly string[], input: { timeoutMs: number }) {
      calls.exec.push([argv, input]);
      if (options.execError) throw options.execError;
      return { stdout: options.output ?? '{"kind":"progress","turn":1,"detail":"sandbox-ready"}\n', stderr: "", exitCode: options.exitCode ?? 0 };
    },
    async poll() { return { state: "terminated" }; },
    async terminate() {
      calls.terminate.push([]);
      if (options.terminateError) throw options.terminateError;
    },
    filesystem: {
      async copyFromLocal() {},
      async copyToLocal() {},
      async listFiles() { return []; },
    },
  };
  return {
    calls,
    sdk: {
      apps: { async fromName(name, input) { calls.app.push([name, input]); return { name }; } },
      images: { fromRegistry(image) { calls.image.push([image]); return { image }; } },
      sandboxes: { async create(...input) { calls.create.push(input); return sandbox; } },
    },
  };
}

describe("Modal adapter contract", () => {
  test("adapter contract creates only the fixed default-deny sandbox and parses the canonical port boundaries", async () => {
    const { sdk, calls } = fakeSdk();
    const adapter = new ModalWorkerAdapter(config(), sdk);

    const result = await adapter.run(request, new AbortController().signal);

    expect(result).toEqual({
      status: "completed",
      code: "WORKER_PROPOSALS_VALIDATED",
      events: [{ kind: "progress", turn: 1, detail: "sandbox-ready" }],
    });
    expect(calls.app).toEqual([["napplet-cvm-modal-probe", { createIfMissing: false }]]);
    expect(calls.image).toEqual([[config().image]]);
    expect(calls.create).toEqual([[{ name: "napplet-cvm-modal-probe" }, { image: config().image },
      expect.objectContaining({
        blockNetwork: true,
        cpu: 1,
        cpuLimit: 2,
        memoryMiB: 1024,
        memoryLimitMiB: 2048,
        timeoutMs: 20 * 60_000,
        idleTimeoutMs: 2 * 60_000,
        workdir: "/workspace",
        command: ["/bin/sh", "-c", "while true; do sleep 60; done"],
        env: { NAPPLET_CVM_POLICY_VERSION: PHASE_02_POLICY_INITIAL.policyVersion },
        tags: { correlation: "test-correlation" },
      })],]);
    expect(calls.exec).toEqual([[["/usr/local/bin/napplet-cvm-worker", "run-proposal"], { timeoutMs: 30_000 }]]);
    expect(calls.terminate).toHaveLength(1);
  });

  test("adapter contract rejects unsafe config, invalid requests, aborts, output overflow, and always terminates", async () => {
    expect(() => ModalWorkerConfigSchema.parse({ ...config(), secrets: ["forbidden"] })).toThrow();
    expect(() => ModalWorkerConfigSchema.parse({ ...config(), memoryMiB: 1 })).toThrow();

    const invalid = fakeSdk();
    const invalidAdapter = new ModalWorkerAdapter(config(), invalid.sdk);
    await expect(invalidAdapter.run({ ...request, unexpected: true } as unknown as typeof request, new AbortController().signal)).resolves.toEqual({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    expect(invalid.calls.create).toHaveLength(0);

    const overflow = fakeSdk({ output: "x".repeat(PHASE_02_POLICY_INITIAL.sandbox.maxOutputBytes + 1) });
    const overflowAdapter = new ModalWorkerAdapter(config(), overflow.sdk);
    await expect(overflowAdapter.run(request, new AbortController().signal)).resolves.toEqual({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    expect(overflow.calls.terminate).toHaveLength(1);

    const failure = fakeSdk({ execError: new Error("provider lost sandbox") });
    const failureAdapter = new ModalWorkerAdapter(config(), failure.sdk);
    await expect(failureAdapter.run(request, new AbortController().signal)).resolves.toEqual({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    expect(failure.calls.terminate).toHaveLength(1);

    const termination = fakeSdk({ terminateError: new Error("termination uncertain") });
    const terminationAdapter = new ModalWorkerAdapter(config(), termination.sdk);
    await expect(terminationAdapter.run(request, new AbortController().signal)).resolves.toEqual({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    expect(termination.calls.terminate).toHaveLength(1);
  });

  test("adapter contract keeps WorkerPort declarations canonical and Modal imports outside trusted modules", async () => {
    const source = await Bun.file("src/worker-adapters/modal-worker.ts").text();
    expect(source).toContain('from "../phase-02/contracts"');
    expect(source).toContain("WorkerRunRequestSchema");
    expect(source).toContain("WorkerEventSchema");
    expect(source).toContain("WorkerRunResultSchema");
    expect(existsSync("src/worker-port/contracts.ts")).toBe(false);
    const sourceRoots = ["src/domain", "src/capabilities", "src/persistence"];
    for (const root of sourceRoots) {
      for (const name of await readdir(root)) {
        if (!name.endsWith(".ts")) continue;
        expect(await Bun.file(`${root}/${name}`).text()).not.toMatch(/from\s+["']modal["']/);
      }
    }
  });
});

describe("Modal probe evidence", () => {
  test("writes blocked, unselected evidence without provider configuration", async () => {
    const process = Bun.spawn(["bun", "run", "scripts/probe-modal-worker.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, MODAL_TOKEN_ID: "", MODAL_TOKEN_SECRET: "", NAPPLET_CVM_MODAL_PROBE_CONFIG: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
    const pointer = await Bun.file("evidence/phase-02/modal-probe.json").json();
    expect(pointer).toMatchObject({ status: "blocked", selection: "unselected", reasonCode: "PROVIDER_UNSELECTED" });
    expect(pointer.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(`evidence/phase-02/provider/${pointer.evidenceSha256}.json`)).toBe(true);
  });

  test("requires every observation and termination before a provider pass", async () => {
    const required = {
      ownCanary: "passed", siblingAbsent: "passed", hostAbsent: "passed", secretAbsent: "passed",
      dnsDenied: "passed", httpDenied: "passed", websocketDenied: "passed", tcpDenied: "passed",
      noPorts: "passed", gatewayAllowed: "passed", runtimeBrowserBuild: "passed", checkpointPortable: "passed",
    } as const;
    const passed = await runModalIsolationProbe({ config: config(), observe: async () => ({ checks: required, termination: "observed" }) });
    expect(passed).toMatchObject({ status: "passed", selection: "eligible-not-selected" });
    const failed = await runModalIsolationProbe({ config: config(), observe: async () => ({ checks: { ...required, tcpDenied: "failed" }, termination: "observed" }) });
    expect(failed).toMatchObject({ status: "failed", selection: "unselected", failedChecks: ["tcpDenied"] });
  });
});
