import { expect, test } from "bun:test";
import {
  createFlyMachinesHttpTransport,
  createMemoryWorkerOperationJournal,
  createWorkerDeploymentClients,
  LOCKED_WORKER_SCHEDULE,
  PRODUCTION_WORKER_POLICY,
  validateWorkerReadinessAttestation,
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
    activeWorkTimeoutMs: 600_000,
    idleGraceMs: 600_000,
    totalLifetimeMs: 1_200_000,
    idleTimeoutMs: 600_000,
  });
  const clients = createWorkerDeploymentClients({
    image,
    workspaceRoot: "/workspace",
    policyVersion: PRODUCTION_WORKER_POLICY.version,
    modalAppName: "napplet-cvm-workers",
    modalTags: {},
    journal: createMemoryWorkerOperationJournal(),
    modalSdk: { sandboxes: { findByName: async () => ({ kind: "missing" as const }) } } as never,
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
        return new Response(JSON.stringify(listCount === 1 ? [] : [{ id: "machine-original", name: "napplet-cvm-op-lost", created_at: "2026-10-27T00:00:00.000Z", config: { image, metadata: { "napplet-cvm-operation": "op-lost", "napplet-cvm-policy": PRODUCTION_WORKER_POLICY.version, "napplet-cvm-role": "isolated-worker" } } }]), { status: 200 });
      }
      throw new Error("connection dropped after Fly accepted the create");
    },
  });

  const intent = { sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 };
  const first = await transport.create({ operationId: "op-lost", region: "ams", image, policy: PRODUCTION_WORKER_POLICY, ...intent });
  const retry = await transport.create({ operationId: "op-lost", region: "ams", image, policy: PRODUCTION_WORKER_POLICY, ...intent });

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

test("Fly records the provider creation identity after a successful original create", async () => {
  const operationId = "op-created";
  const journal = createMemoryWorkerOperationJournal();
  const created = { id: "machine-created", name: `napplet-cvm-${operationId}`, created_at: "2026-10-27T00:00:00.000Z", config: { image, guest: { cpus: 1, memory_mb: 1024 }, services: [], env: { NAPPLET_CVM_POLICY_VERSION: PRODUCTION_WORKER_POLICY.version }, metadata: { "napplet-cvm-operation": operationId, "napplet-cvm-policy": PRODUCTION_WORKER_POLICY.version, "napplet-cvm-role": "isolated-worker" } } };
  const transport = createFlyMachinesHttpTransport({ appName: "napplet-cvm-workers", getAccessToken: async () => "valid-access-token", journal, fetch: async (_url, init) => init.method === "GET" ? new Response(JSON.stringify([]), { status: 200 }) : new Response(JSON.stringify(created), { status: 200 }) });
  await expect(transport.create({ operationId, region: "ams", image, policy: PRODUCTION_WORKER_POLICY, sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 })).resolves.toEqual({ status: "created", operationId, resourceId: "machine-created" });
  await expect(journal.read(operationId)).resolves.toMatchObject({ resourceId: "machine-created", providerCreatedAtMs: Date.parse(created.created_at), state: "dispatched" });
});

test("transport refuses a malformed or credential-bearing response and does not certify metadata as network isolation", async () => {
  const transport = createFlyMachinesHttpTransport({
    appName: "napplet-cvm-workers",
    getAccessToken: async () => "valid-access-token",
    journal: createMemoryWorkerOperationJournal(),
    fetch: async () => new Response(JSON.stringify([{ id: "machine-1", name: "napplet-cvm-op-unsafe", created_at: "2026-10-27T00:00:00.000Z", config: { image, metadata: { "napplet-cvm-operation": "op-unsafe", secret: "no" } } }]), { status: 200 }),
  });
  await expect(transport.create({ operationId: "op-unsafe", region: "ams", image, policy: PRODUCTION_WORKER_POLICY, sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 })).resolves.toEqual({ status: "unknown", operationId: "op-unsafe" });
});

test("sealed image installs root-owned trusted worker commands and runs the pinned build/conformance flow", async () => {
  const [dockerfile, worker, probe, bootstrap] = await Promise.all([
    Bun.file("infra/toolchain/Dockerfile").text(),
    Bun.file("infra/toolchain/production-worker.ts").text(),
    Bun.file("infra/toolchain/production-probe.ts").text(),
    Bun.file("infra/toolchain/production-bootstrap.sh").text(),
  ]);
  expect(dockerfile).toContain("infra/toolchain/production-worker.ts /usr/local/bin/napplet-cvm-worker");
  expect(dockerfile).toContain("infra/toolchain/production-probe.ts /usr/local/bin/napplet-cvm-probe");
  expect(dockerfile).toContain("infra/toolchain/production-bootstrap.sh /usr/local/bin/napplet-cvm-bootstrap");
  expect(dockerfile).toContain("FROM sealed AS production-worker");
  expect(dockerfile).toContain("FROM sealed AS default\nUSER 65532:65532");
  expect(dockerfile).toContain("chmod -R go-w /toolchain /usr/local/bin/napplet-cvm-worker /usr/local/bin/napplet-cvm-probe");
  expect(dockerfile).not.toContain("--chown=65532:65532 /toolchain/node_modules");
  for (const command of ["napplet", "--offline", "--frozen-lockfile", "test:conformance", "networkDenied", "deniedProbe", "ipv6", "private", "WORKER_ACTIVE_DEADLINE_INVALID", "environmentClean", "CapBnd", "NoNewPrivs", "WORKER_SOURCE_DUPLICATE"]) expect(worker).toContain(command);
  expect(probe).toContain("napplet-cvm-worker");
  for (const command of ["findmnt", "tmpfs", "setpriv", "--bounding-set=-all", "--no-new-privs", "mount_bounded /home/napplet", "mount_bounded /tmp"]) expect(bootstrap).toContain(command);
  expect(dockerfile).toContain('install","chromium');
});

test("readiness rejects a credential-bearing, unprobed, or incorrectly leased worker", () => {
  const lease = digest("b");
  const valid = {
    version: 1 as const, policyVersion: PRODUCTION_WORKER_POLICY.version, image, sessionLeaseSha256: lease,
    remainingLifetimeMs: 600_000, networkPolicyEvidenceSha256: digest("e"),
    checks: { toolchain_readonly: true as const, workspace_bounded: true as const, non_root: true as const, no_ambient_credentials: true as const, network_denied: true as const, no_inbound_ports: true as const, minimal_capabilities: true as const },
  };
  expect(validateWorkerReadinessAttestation(valid, { image, sessionLeaseSha256: lease, networkPolicyEvidenceSha256: digest("e") })).toEqual(valid);
  for (const invalid of [
    { ...valid, networkPolicyEvidenceSha256: "not-a-digest" },
    { ...valid, checks: { ...valid.checks, no_ambient_credentials: false } },
    { ...valid, checks: { ...valid.checks, network_denied: false } },
    { ...valid, sessionLeaseSha256: digest("c") },
  ]) expect(() => validateWorkerReadinessAttestation(invalid, { image, sessionLeaseSha256: lease, networkPolicyEvidenceSha256: digest("e") })).toThrow();
});

test("cleanup after controller interruption deletes only the original owned machine", async () => {
  const operationId = "op-cleanup";
  const providerCreatedAtMs = Date.parse("2026-10-27T00:00:00.000Z");
  const journal = createMemoryWorkerOperationJournal([{ operationId, requestSha256: digest("d"), state: "dispatched", resourceName: `napplet-cvm-${operationId}`, resourceId: "machine-cleanup", image, region: "ams", policyVersion: PRODUCTION_WORKER_POLICY.version, createdAtMs: 1, providerCreatedAtMs, sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 }]);
  const calls: RequestInit[] = [];
  let getCount = 0;
  const transport = createFlyMachinesHttpTransport({
    appName: "napplet-cvm-workers", getAccessToken: async () => "valid-access-token", journal,
    fetch: async (_url, init) => {
      calls.push(init);
      if (init.method === "GET" && ++getCount > 1) return new Response(null, { status: 404 });
      if (init.method === "GET") return new Response(JSON.stringify({ id: "machine-cleanup", name: `napplet-cvm-${operationId}`, created_at: "2026-10-27T00:00:00.000Z", config: { image, guest: { cpus: 1, memory_mb: 1024 }, services: [], env: { NAPPLET_CVM_POLICY_VERSION: PRODUCTION_WORKER_POLICY.version }, metadata: { "napplet-cvm-operation": operationId, "napplet-cvm-policy": PRODUCTION_WORKER_POLICY.version, "napplet-cvm-role": "isolated-worker" } } }), { status: 200 });
      return new Response(null, { status: 204 });
    },
  });
  await expect(transport.terminate({ operationId })).resolves.toEqual({ status: "terminated" });
  await expect(transport.terminate({ operationId: "op-foreign" })).resolves.toEqual({ status: "blocked" });
  expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE", "GET"]);
});

test("Fly never executes or cleans a legacy record without persisted provider creation identity", async () => {
  const operationId = "op-legacy";
  const journal = createMemoryWorkerOperationJournal([{ operationId, requestSha256: digest("d"), state: "dispatched", resourceName: `napplet-cvm-${operationId}`, resourceId: "machine-legacy", image, region: "ams", policyVersion: PRODUCTION_WORKER_POLICY.version, createdAtMs: 1, sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 }]);
  let deletes = 0;
  const machine = { id: "machine-legacy", name: `napplet-cvm-${operationId}`, created_at: "2026-10-27T00:00:00.000Z", state: "started", config: { image, guest: { cpus: 1, memory_mb: 1024 }, services: [], env: { NAPPLET_CVM_POLICY_VERSION: PRODUCTION_WORKER_POLICY.version }, metadata: { "napplet-cvm-operation": operationId, "napplet-cvm-policy": PRODUCTION_WORKER_POLICY.version, "napplet-cvm-role": "isolated-worker" } } };
  const transport = createFlyMachinesHttpTransport({ appName: "napplet-cvm-workers", getAccessToken: async () => "valid-access-token", journal, fetch: async (_url, init) => { if (init.method === "DELETE") deletes += 1; return new Response(JSON.stringify(machine), { status: 200 }); } });
  await expect(transport.terminate({ operationId })).resolves.toEqual({ status: "unknown" });
  await expect(transport.exec({ operationId, command: ["/usr/local/bin/napplet-cvm-probe"] })).resolves.toEqual({ status: "unknown" });
  expect(deletes).toBe(0);
});

test("Fly readiness exec is bounded, authenticated, and cannot run against a substituted image", async () => {
  const operationId = "op-probe";
  const journal = createMemoryWorkerOperationJournal([{ operationId, requestSha256: digest("d"), state: "dispatched", resourceName: `napplet-cvm-${operationId}`, resourceId: "machine-probe", image, region: "ams", policyVersion: PRODUCTION_WORKER_POLICY.version, createdAtMs: 1, providerCreatedAtMs: Date.parse("2026-10-27T00:00:00.000Z"), sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 }]);
  const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
  const machine = { id: "machine-probe", name: `napplet-cvm-${operationId}`, created_at: "2026-10-27T00:00:00.000Z", state: "started", config: { image, guest: { cpus: 1, memory_mb: 1024 }, services: [], env: { NAPPLET_CVM_POLICY_VERSION: PRODUCTION_WORKER_POLICY.version }, metadata: { "napplet-cvm-operation": operationId, "napplet-cvm-policy": PRODUCTION_WORKER_POLICY.version, "napplet-cvm-role": "isolated-worker" } } };
  const transport = createFlyMachinesHttpTransport({ appName: "napplet-cvm-workers", getAccessToken: async () => "valid-access-token", journal, fetch: async (url, init) => {
    requests.push({ url, init });
    return init.method === "POST" ? new Response(JSON.stringify({ stdout: "{}", stderr: "", exit_code: 0 }), { status: 200 }) : new Response(JSON.stringify(machine), { status: 200 });
  } });
  await expect(transport.exec({ operationId, command: ["/usr/local/bin/napplet-cvm-probe", "observe-isolation"], timeoutSeconds: 61 })).rejects.toThrow();
  await expect(transport.exec({ operationId, command: ["/usr/local/bin/napplet-cvm-probe", "observe-isolation"], timeoutSeconds: 60 })).resolves.toEqual({ status: "completed", stdout: "{}", stderr: "", exitCode: 0 });
  const exec = requests.find((request) => request.init.method === "POST")!;
  expect(exec.url).toContain(`/machines/machine-probe/exec`);
  expect(JSON.parse(String(exec.init.body))).toEqual({ command: ["/usr/local/bin/napplet-cvm-probe", "observe-isolation"], stdin: "", timeout: 60 });
  expect(exec.init.headers).toMatchObject({ authorization: "Bearer valid-access-token" });
});

test("trusted harness refuses the default unbounded workspace and never turns run-proposal into a success placeholder", async () => {
  const run = (args: string[], env: Record<string, string> = {}) => Bun.spawn(["bun", "infra/toolchain/production-worker.ts", ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", ...env } });
  const readiness = run(["ready", "--session-lease-sha256", digest("a"), "--provider-image-sha256", digest("b"), "--toolchain-sha256", digest("c"), "--provider-deadline-epoch-ms", String(Date.now() + 60_000)], { NAPPLET_CVM_POLICY_VERSION: PRODUCTION_WORKER_POLICY.version });
  expect(await readiness.exited).not.toBe(0);
  const proposal = run(["run-proposal"]);
  expect(await proposal.exited).toBe(0);
  expect(await new Response(proposal.stdout).text()).toContain('"status":"unavailable"');
  const traversal = run(["build-source", "--source", "/tmp/not-a-worker-source.json"]);
  expect(await traversal.exited).not.toBe(0);
});
