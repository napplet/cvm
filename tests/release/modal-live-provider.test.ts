import { expect, test } from "bun:test";
import { createModalLiveWorkerProvider } from "../../src/release/native/modal";
import { executeIdenticalWorkerCohorts } from "../../src/certification/live/worker-ports";
import { createMemoryWorkerOperationJournal } from "../../src/release/deployment/worker-clients";

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
    }, findByName: async () => ({ kind: "missing" as const }), fromId: async () => sandbox },
  };
}

test("Modal provider has zero effects before receipt-gated apply, preserves original operation retry, and only cleans run-owned capacity", async () => {
  const calls: string[] = [];
  const provider = createModalLiveWorkerProvider({
    config: { appName: "napplet-cvm", image, workspaceRoot: "/workspace", policyVersion: "phase-02-policy-2026-08-04", tags: { run: "run-1" } },
    sdk: modalSdk(calls),
    command: { observeReady: async ({ operationId }) => ({ operationId, status: "ready", isolation: "passed", durableBacklogCount: 0, readyLeaseCount: 1 }) },
    journal: createMemoryWorkerOperationJournal(),
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
    journal: createMemoryWorkerOperationJournal(),
    now: (() => { let value = 0; return () => value += 10; })(),
  });

  const first = await provider.executeSample({ id: "benchmark-1", cohort: "pool_hit" });
  const retry = await provider.executeSample({ id: "benchmark-1", cohort: "pool_hit" });
  expect(first).toMatchObject({ id: "benchmark-1", cohort: "pool_hit", outcome: "accepted", receiptMonotonicMs: 10, readyMonotonicMs: 20, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" });
  expect(retry).toEqual(first);
  expect(calls.filter((entry) => entry.startsWith("create:"))).toHaveLength(1);
});

test("identical protected cohorts select only fresh passed measured evidence", async () => {
  const schedules: Record<string, Array<readonly [string, string]>> = { modal: [], fly: [] };
  const candidate = (provider: "modal" | "fly", id: string) => ({ id: digest(id), provider, image, sourceSha256: digest("d") });
  const port = (provider: "modal" | "fly", latency: number) => ({
    evidenceClass: "protected_live" as const,
    executeSample: async (sample: { id: string; cohort: string }) => {
      schedules[provider].push([sample.id, sample.cohort]);
      return { ...sample, outcome: "accepted", receiptMonotonicMs: 1, readyMonotonicMs: 1 + latency, readyLeaseCount: 1, durableBacklogCount: 0, isolation: "passed", cleanup: "passed" };
    },
  });
  const result = await executeIdenticalWorkerCohorts({
    candidates: [
      { candidate: candidate("modal", "b"), topologySha256: digest("e"), observationPort: port("modal", 20) },
      { candidate: candidate("fly", "c"), topologySha256: digest("f"), observationPort: port("fly", 40) },
    ],
    observedAtMs: 100,
    expiresAtMs: 200,
    now: () => 150,
  });
  expect(schedules.modal).toEqual(schedules.fly);
  expect(schedules.modal).toHaveLength(1_000);
  expect(result).toMatchObject({ status: "selected", provider: "modal", topologySha256: digest("e") });
  expect(result.selectionEvidenceSha256).toHaveLength(64);
});


test("Modal rejects a changed plan digest while preserving its original durable intent", async()=>{
  const calls:string[]=[],journal=createMemoryWorkerOperationJournal();
  const provider=createModalLiveWorkerProvider({config:{appName:"napplet-cvm",image,workspaceRoot:"/workspace",policyVersion:"phase-02-policy-2026-08-04",tags:{run:"identity-fixture"}},sdk:modalSdk(calls),command:{observeReady:async({operationId})=>({operationId,status:"ready",isolation:"passed",durableBacklogCount:0,readyLeaseCount:1})},journal});
  const original={operationId:"op-modal-binding",effectId:"modal-benchmark",region:"global",desiredDigest:digest("b")};
  await expect(provider.plan(original)).resolves.toMatchObject({status:"planned"});
  const retained=await journal.read(original.operationId);
  await expect(provider.plan({...original,desiredDigest:digest("c")})).rejects.toThrow("MODAL_OPERATION_IDENTITY_CONFLICT");
  expect(await journal.read(original.operationId)).toEqual(retained);
  expect(calls).toEqual([]);
});

test("Modal cannot apply another digest through an earlier planned operation", async()=>{
  const calls:string[]=[],journal=createMemoryWorkerOperationJournal();
  const provider=createModalLiveWorkerProvider({config:{appName:"napplet-cvm",image,workspaceRoot:"/workspace",policyVersion:"phase-02-policy-2026-08-04",tags:{run:"apply-fixture"}},sdk:modalSdk(calls),command:{observeReady:async({operationId})=>({operationId,status:"ready",isolation:"passed",durableBacklogCount:0,readyLeaseCount:1})},journal});
  const original={operationId:"op-modal-apply",effectId:"modal-benchmark",region:"global",desiredDigest:digest("b")};
  await provider.plan(original);
  expect(await provider.apply({...original,desiredDigest:digest("c")})).toMatchObject({status:"unknown"});
  expect(calls).toEqual([]);
  expect(await provider.apply(original)).toMatchObject({status:"applied"});
  expect(calls.filter(value=>value.startsWith("create:"))).toHaveLength(1);
});

test("Modal refuses a journal claim with a different original resource locator",async()=>{
  const calls:string[]=[],journal=createMemoryWorkerOperationJournal();
  const original={operationId:"op-modal-locator",requestSha256:digest("b"),resourceName:"napplet-cvm-foreign"};await journal.claim(original);
  const retained=await journal.read(original.operationId);
  const provider=createModalLiveWorkerProvider({config:{appName:"napplet-cvm",image,workspaceRoot:"/workspace",policyVersion:"phase-02-policy-2026-08-04",tags:{run:"locator-fixture"}},sdk:modalSdk(calls),command:{observeReady:async()=>{throw new Error("READINESS_MUST_NOT_RUN");}},journal});
  await expect(provider.plan({operationId:original.operationId,effectId:"modal-benchmark",region:"global",desiredDigest:original.requestSha256})).rejects.toThrow("MODAL_OPERATION_IDENTITY_CONFLICT");
  expect(await journal.read(original.operationId)).toEqual(retained);
  expect(calls).toEqual([]);
});


test("Modal rechecks durable identity before SDK access, cached readiness and cleanup",async()=>{
  const calls:string[]=[],backing=createMemoryWorkerOperationJournal();let corrupt:"digest"|"resource"|undefined;
  const journal={...backing,async read(operationId:string){const record=await backing.read(operationId);if(!record)return record;return corrupt==="digest"?{...record,requestSha256:digest("c")}:corrupt==="resource"?{...record,resourceId:"foreign-sandbox"}:record;}};
  const provider=createModalLiveWorkerProvider({config:{appName:"napplet-cvm",image,workspaceRoot:"/workspace",policyVersion:"phase-02-policy-2026-08-04",tags:{run:"read-binding-fixture"}},sdk:modalSdk(calls),command:{observeReady:async({operationId})=>({operationId,status:"ready",isolation:"passed",durableBacklogCount:0,readyLeaseCount:1})},journal});
  const original={operationId:"op-modal-read-binding",effectId:"modal-benchmark",region:"global",desiredDigest:digest("b")};await provider.plan(original);
  const planned=await backing.read(original.operationId);
  corrupt="digest";expect(await provider.apply(original)).toMatchObject({status:"unknown"});expect(calls).toEqual([]);expect(await backing.read(original.operationId)).toEqual(planned);
  corrupt=undefined;expect(await provider.apply(original)).toMatchObject({status:"applied"});const before=[...calls];
  corrupt="resource";expect(await provider.observe(original)).toMatchObject({status:"unknown"});expect(await provider.cleanup(original)).toMatchObject({status:"blocked"});expect(calls).toEqual(before);
  corrupt=undefined;expect(await provider.cleanup(original)).toMatchObject({status:"cleaned"});expect(calls.filter(value=>value.startsWith("create:"))).toHaveLength(1);expect(calls.filter(value=>value.startsWith("terminate:"))).toEqual(["terminate:modal-sandbox-1"]);
});
