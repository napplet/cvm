import { expect, test } from "bun:test";
import {
  createFlyMachinesHttpTransport,
  createMemoryWorkerOperationJournal,
  createWorkerDeploymentClients,
  LOCKED_WORKER_SCHEDULE,
  PRODUCTION_WORKER_POLICY,
} from "../../src/release/deployment/worker-clients";

const digest = (value: string) => value.repeat(64);
const image = `registry.example/worker@sha256:${digest("a")}`;

test("uses the verifier's locked 1,000-attempt schedule and one versioned policy for both providers", () => {
  expect(LOCKED_WORKER_SCHEDULE).toHaveLength(1_000);
  expect(LOCKED_WORKER_SCHEDULE.filter((sample) => sample.cohort === "pool_hit")).toHaveLength(267);
  expect(LOCKED_WORKER_SCHEDULE.slice(0, 200).every((sample) => sample.cohort === "pool_hit")).toBeTrue();
  expect(new Set(LOCKED_WORKER_SCHEDULE.slice(200, 400).map((sample) => sample.cohort))).toEqual(new Set(["pool_miss", "cold", "contention"]));
  expect(PRODUCTION_WORKER_POLICY).toMatchObject({
    version: "production-worker-policy-2026-10-27",
    blockNetwork: true,
    noInboundPorts: true,
    nonRootUid: 65532,
    timeoutMs: 600_000,
    idleTimeoutMs: 600_000,
  });
  const clients = createWorkerDeploymentClients({
    image,
    workspaceRoot: "/workspace",
    policyVersion: PRODUCTION_WORKER_POLICY.version,
    modalSdk: {} as never,
    fly: {} as never,
  });
  expect(clients.modal.definition).toEqual(clients.fly.definition);
  expect(clients.selection).toEqual({ status: "unselected", reasonCode: "FRESH_PROTECTED_EVIDENCE_REQUIRED" });
});

test("Fly persists its original operation before create, queries deterministic metadata after loss, and never duplicates it", async () => {
  const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
  const journal = createMemoryWorkerOperationJournal();
  let listCount = 0;
  const transport = createFlyMachinesHttpTransport({
    appName: "napplet-cvm-workers",
    getAccessToken: async () => "fly-secret-must-not-cross-worker-boundary",
    journal,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (init.method === "GET") {
        listCount += 1;
        return new Response(JSON.stringify(listCount === 1 ? [] : [{ id: "machine-original", name: "napplet-cvm-op-lost", config: { image, metadata: { "napplet-cvm-operation": "op-lost", "napplet-cvm-policy": PRODUCTION_WORKER_POLICY.version, "napplet-cvm-role": "isolated-worker" } } }]), { status: 200 });
      }
      throw new Error("connection dropped after Fly accepted the create");
    },
  });

  const first = await transport.create({ operationId: "op-lost", region: "ams", image, policy: PRODUCTION_WORKER_POLICY });
  const retry = await transport.create({ operationId: "op-lost", region: "ams", image, policy: PRODUCTION_WORKER_POLICY });

  expect(first).toEqual({ status: "unknown", operationId: "op-lost" });
  expect(retry).toEqual({ status: "reconciled", operationId: "op-lost", resourceId: "machine-original" });
  expect(requests.filter((request) => request.init.method === "POST")).toHaveLength(1);
  expect(requests[0]!.init.headers).toMatchObject({ authorization: "Bearer fly-secret-must-not-cross-worker-boundary" });
  const body = JSON.parse(String(requests.find((request) => request.init.method === "POST")!.init.body));
  expect(body).toMatchObject({ name: "napplet-cvm-op-lost", region: "ams", config: { image, guest: { cpus: 1, memory_mb: 1024 }, services: [], metadata: { "napplet-cvm-operation": "op-lost" } } });
  expect(body).not.toHaveProperty("image");
  expect(JSON.stringify(body)).not.toContain("fly-secret");
  await expect(journal.read("op-lost")).resolves.toMatchObject({ state: "reconciled", resourceId: "machine-original" });
});

test("transport refuses a malformed or credential-bearing response and does not certify metadata as network isolation", async () => {
  const transport = createFlyMachinesHttpTransport({
    appName: "napplet-cvm-workers",
    getAccessToken: async () => "valid-access-token",
    journal: createMemoryWorkerOperationJournal(),
    fetch: async () => new Response(JSON.stringify([{ id: "machine-1", name: "napplet-cvm-op-unsafe", config: { image, metadata: { "napplet-cvm-operation": "op-unsafe", secret: "no" } } }]), { status: 200 }),
  });
  await expect(transport.create({ operationId: "op-unsafe", region: "ams", image, policy: PRODUCTION_WORKER_POLICY })).resolves.toEqual({ status: "unknown", operationId: "op-unsafe" });
});

test("sealed image installs root-owned trusted worker commands and runs the pinned build/conformance flow", async () => {
  const [dockerfile, worker, probe] = await Promise.all([
    Bun.file("infra/toolchain/Dockerfile").text(),
    Bun.file("infra/toolchain/production-worker.ts").text(),
    Bun.file("infra/toolchain/production-probe.ts").text(),
  ]);
  expect(dockerfile).toContain("infra/toolchain/production-worker.ts /usr/local/bin/napplet-cvm-worker");
  expect(dockerfile).toContain("infra/toolchain/production-probe.ts /usr/local/bin/napplet-cvm-probe");
  expect(dockerfile).toContain("chmod -R go-w /toolchain /usr/local/bin/napplet-cvm-worker /usr/local/bin/napplet-cvm-probe");
  expect(dockerfile).not.toContain("--chown=65532:65532 /toolchain/node_modules");
  for (const command of ["napplet", "--offline", "--frozen-lockfile", "test:conformance", "network_denied", "no_ambient_credentials"]) expect(worker).toContain(command);
  expect(probe).toContain("napplet-cvm-worker");
});
