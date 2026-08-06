import { expect, test } from "bun:test";
import { createFlyLiveWorkerProvider } from "../../src/release/native/fly";

const digest = (letter: string) => letter.repeat(64);
const image = `registry.example/worker@sha256:${digest("a")}`;

function flyClient(calls: string[]) {
  return {
    create: async (input: { blockNetwork: true; noInboundPorts: true; cpu: number; memoryMiB: number; timeoutMs: number; idleTimeoutMs: number }) => {
      calls.push(`create:${input.blockNetwork}:${input.noInboundPorts}:${input.cpu}:${input.memoryMiB}:${input.timeoutMs}:${input.idleTimeoutMs}`);
      return { id: "fly-machine-1" };
    },
    exec: async () => ({ stdout: "", exitCode: 0 }),
    destroy: async (id: string) => { calls.push(`destroy:${id}`); },
  };
}

test("Fly provider has zero effects before receipt-gated apply, preserves original operation retry, and only cleans run-owned capacity", async () => {
  const calls: string[] = [];
  const provider = createFlyLiveWorkerProvider({
    config: { appName: "napplet-cvm", image, region: "ams", workspaceRoot: "/workspace", policyVersion: "phase-02-policy-2026-08-04" },
    client: flyClient(calls),
    command: { observeReady: async ({ operationId }) => ({ operationId, status: "ready", isolation: "passed", durableBacklogCount: 0, readyLeaseCount: 1 }) },
    now: (() => { let value = 100; return () => value += 25; })(),
  });

  await provider.plan({ operationId: "op-fly-1", effectId: "fly-benchmark", region: "ams", desiredDigest: digest("b") });
  expect(calls).toEqual([]);
  await provider.apply({ operationId: "op-fly-1", effectId: "fly-benchmark", region: "ams", desiredDigest: digest("b") });
  await provider.apply({ operationId: "op-fly-1", effectId: "fly-benchmark", region: "ams", desiredDigest: digest("b") });
  expect(calls.filter((entry) => entry.startsWith("create:"))).toHaveLength(1);
  expect(calls[0]).toContain("true:true");
  await provider.cleanup({ operationId: "op-fly-1" });
  await provider.cleanup({ operationId: "op-fly-foreign" });
  expect(calls.filter((entry) => entry.startsWith("destroy:"))).toEqual(["destroy:fly-machine-1"]);
});

test("Fly readiness samples timestamp trusted receipt through exact isolated-ready and reconcile the same machine operation", async () => {
  const calls: string[] = [];
  const provider = createFlyLiveWorkerProvider({
    config: { appName: "napplet-cvm", image, region: "ams", workspaceRoot: "/workspace", policyVersion: "phase-02-policy-2026-08-04" },
    client: flyClient(calls),
    command: { observeReady: async ({ operationId, cohort }) => ({ operationId, cohort, status: "ready", isolation: "passed", durableBacklogCount: 0, readyLeaseCount: 1 }) },
    now: (() => { let value = 0; return () => value += 10; })(),
  });
  const first = await provider.executeSample({ id: "benchmark-1", cohort: "pool_hit" });
  const retry = await provider.executeSample({ id: "benchmark-1", cohort: "pool_hit" });
  expect(first).toMatchObject({ id: "benchmark-1", cohort: "pool_hit", outcome: "accepted", receiptMonotonicMs: 10, readyMonotonicMs: 20, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" });
  expect(retry).toEqual(first);
  expect(calls.filter((entry) => entry.startsWith("create:"))).toHaveLength(1);
});
