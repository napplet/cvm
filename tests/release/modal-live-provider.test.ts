import { expect, test } from "bun:test";
import { createModalLiveWorkerProvider } from "../../src/release/native/modal";

const digest = (letter: string) => letter.repeat(64);
const image = `registry.example/worker@sha256:${digest("a")}`;

function modalSdk(calls: string[]) {
  const sandbox = {
    id: "modal-sandbox-1",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    poll: async () => ({ state: "ready" }),
    terminate: async () => { calls.push("terminate:modal-sandbox-1"); },
    filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] },
  };
  return {
    apps: { fromName: async () => { calls.push("app"); return {}; } },
    images: { fromRegistry: () => { calls.push("image"); return {}; } },
    sandboxes: { create: async (_app: unknown, _image: unknown, options: { blockNetwork: true; command: readonly string[]; timeoutMs: number; idleTimeoutMs: number }) => {
      calls.push(`create:${options.blockNetwork}:${options.command.join(" ")}:${options.timeoutMs}:${options.idleTimeoutMs}`);
      return sandbox;
    } },
  };
}

test("Modal provider has zero effects before receipt-gated apply, preserves original operation retry, and only cleans run-owned capacity", async () => {
  const calls: string[] = [];
  const provider = createModalLiveWorkerProvider({
    config: { appName: "napplet-cvm", image, workspaceRoot: "/workspace", policyVersion: "phase-02-policy-2026-08-04", tags: { run: "run-1" } },
    sdk: modalSdk(calls),
    command: { observeReady: async ({ operationId }) => ({ operationId, status: "ready", isolation: "passed", durableBacklogCount: 0, readyLeaseCount: 1 }) },
    now: (() => { let value = 100; return () => value += 25; })(),
  });

  await provider.plan({ operationId: "op-modal-1", effectId: "modal-benchmark", region: "global", desiredDigest: digest("b") });
  expect(calls).toEqual([]);

  await provider.apply({ operationId: "op-modal-1", effectId: "modal-benchmark", region: "global", desiredDigest: digest("b") });
  await provider.apply({ operationId: "op-modal-1", effectId: "modal-benchmark", region: "global", desiredDigest: digest("b") });
  expect(calls.filter((entry) => entry.startsWith("create:"))).toHaveLength(1);
  expect(calls[2]).toContain("true:/bin/sh -c while true; do sleep 60; done");

  await provider.cleanup({ operationId: "op-modal-1" });
  await provider.cleanup({ operationId: "op-modal-foreign" });
  expect(calls.filter((entry) => entry.startsWith("terminate:"))).toEqual(["terminate:modal-sandbox-1"]);
});

test("Modal readiness samples timestamp trusted receipt through exact isolated-ready and reconcile the same operation", async () => {
  const calls: string[] = [];
  const provider = createModalLiveWorkerProvider({
    config: { appName: "napplet-cvm", image, workspaceRoot: "/workspace", policyVersion: "phase-02-policy-2026-08-04", tags: { run: "run-2" } },
    sdk: modalSdk(calls),
    command: { observeReady: async ({ operationId, cohort }) => ({ operationId, cohort, status: "ready", isolation: "passed", durableBacklogCount: 0, readyLeaseCount: 1 }) },
    now: (() => { let value = 0; return () => value += 10; })(),
  });

  const first = await provider.executeSample({ id: "benchmark-1", cohort: "pool_hit" });
  const retry = await provider.executeSample({ id: "benchmark-1", cohort: "pool_hit" });
  expect(first).toMatchObject({ id: "benchmark-1", cohort: "pool_hit", outcome: "accepted", receiptMonotonicMs: 10, readyMonotonicMs: 20, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" });
  expect(retry).toEqual(first);
  expect(calls.filter((entry) => entry.startsWith("create:"))).toHaveLength(1);
});
