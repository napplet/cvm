import { expect, test } from "bun:test";
import { createMemoryWorkerOperationJournal, createWorkerDeploymentClients, PRODUCTION_WORKER_POLICY, WORKER_RUNNER_DEFINITION } from "../../src/release/deployment/worker-clients";

const digest = (letter: string) => letter.repeat(64);
const image = `registry.example/worker@sha256:${digest("a")}`;

test("uses one immutable, unselected worker runner definition for Modal and Fly", async () => {
  const calls: string[] = [];
  const clients = createWorkerDeploymentClients({
    image,
    workspaceRoot: "/workspace",
    policyVersion: PRODUCTION_WORKER_POLICY.version,
    modalAppName: "napplet-cvm-workers", modalTags: {}, journal: createMemoryWorkerOperationJournal(),
    modalSdk: { apps: { fromName: async () => (calls.push("modal-app"), {}) }, images: { fromRegistry: () => (calls.push("modal-image"), {}) }, sandboxes: { create: async () => (calls.push("modal-create"), { id: "fake", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), poll: async () => ({ state: "ready" }), terminate: async () => {}, filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } }), findByName: async () => ({ kind: "missing" as const }) } },
    fly: {} as never,
  });
  expect(clients.modal.definition).toEqual(clients.fly.definition);
  expect(clients.modal.definition).toEqual(WORKER_RUNNER_DEFINITION);
  expect(clients.modal.schedules.map((entry) => entry.cohort)).toEqual(clients.fly.schedules.map((entry) => entry.cohort));
  expect(calls).toEqual([]);
  expect(clients.selection).toEqual({ status: "unselected", reasonCode: "FRESH_PROTECTED_EVIDENCE_REQUIRED" });
});

test("requires the production worker policy and does not permit a durable backlog schedule", () => {
  expect(() => createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: "phase-02-policy-2026-08-04", modalAppName: "napplet-cvm-workers", modalTags: {}, journal: createMemoryWorkerOperationJournal(), modalSdk: {} as never, fly: {} as never })).toThrow("WORKER_CLIENT_CONFIG_INVALID");
  expect(WORKER_RUNNER_DEFINITION.durableBacklog).toBe(0);
  expect(WORKER_RUNNER_DEFINITION.blockNetwork).toBeTrue();
  expect(WORKER_RUNNER_DEFINITION.noInboundPorts).toBeTrue();
});

test("constructs a real Modal lifecycle with the production image policy and no replacement after ambiguity", async () => {
  const calls: string[] = [];
  let tags: Record<string, string> = {};
  const sandbox = { id: "modal-original", getTags: async () => tags, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), poll: async () => ({}), terminate: async () => {}, filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } };
  let found = false;
  const clients = createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: PRODUCTION_WORKER_POLICY.version, modalAppName: "napplet-cvm-workers", modalTags: { run: "test" }, journal: createMemoryWorkerOperationJournal(), fly: {} as never,
    modalSdk: { apps: { fromName: async () => (calls.push("app"), {}) }, images: { fromRegistry: () => (calls.push("image"), {}) }, sandboxes: { create: async (_app, _image, options) => { tags = { ...options.tags }; calls.push(`create:${options.timeoutMs}:${options.idleTimeoutMs}:${options.command[0]}`); found = true; return sandbox; }, findByName: async () => found ? ({ kind: "found" as const, sandbox }) : ({ kind: "missing" as const }) } },
  });
  const intent = { operationId: "op-modal", sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 };
  await expect(clients.modal.create(intent)).resolves.toEqual({ status: "created", operationId: "op-modal", resourceId: "modal-original" });
  await expect(clients.modal.create(intent)).resolves.toEqual({ status: "reconciled", operationId: "op-modal", resourceId: "modal-original" });
  expect(calls).toEqual(["app", "image", `create:${PRODUCTION_WORKER_POLICY.totalLifetimeMs}:${PRODUCTION_WORKER_POLICY.idleGraceMs}:/usr/local/bin/napplet-cvm-bootstrap`]);
});

test("Modal accepts only a trusted probe bound to its returned immutable sandbox ID", async () => {
  const lease = digest("b"); const toolchain = digest("c");
  const execs: string[][] = [];
  let tags: Record<string, string> = {};
  const report = JSON.stringify({
    checks: { toolchain_readonly: true, workspace_bounded: true, non_root: true, no_ambient_credentials: true, network_denied: true, no_inbound_ports: true, minimal_capabilities: true },
    exactReady: { image, sessionLeaseSha256: lease, toolchainSha256: toolchain, remainingLifetimeMs: 60_000 },
  });
  let found = false;
  const sandbox = { id: "modal-bound", getTags: async () => tags, exec: async (argv: readonly string[]) => { execs.push([...argv]); return { stdout: report, stderr: "", exitCode: 0 }; }, poll: async () => ({}), terminate: async () => {}, filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } };
  const clients = createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: PRODUCTION_WORKER_POLICY.version, modalAppName: "napplet-cvm-workers", modalTags: {}, journal: createMemoryWorkerOperationJournal(), fly: {} as never,
    modalSdk: { apps: { fromName: async () => ({}) }, images: { fromRegistry: () => ({}) }, sandboxes: { create: async (_app, _image, options) => { tags = { ...options.tags }; found = true; return sandbox; }, findByName: async () => found ? ({ kind: "found" as const, sandbox }) : ({ kind: "missing" as const }) } },
  });
  const intent = { operationId: "op-modal-probe", sessionLeaseSha256: lease, toolchainSha256: toolchain, providerDeadlineEpochMs: Date.now() + 60_000 };
  await expect(clients.modal.create(intent)).resolves.toEqual({ status: "created", operationId: intent.operationId, resourceId: "modal-bound" });
  await expect(clients.modal.observe({ operationId: intent.operationId })).resolves.toEqual({ status: "completed", resourceId: "modal-bound" });
  await expect(clients.modal.exec({ operationId: intent.operationId, command: ["/usr/local/bin/napplet-cvm-worker", "build-source"] })).resolves.toMatchObject({ status: "completed", exitCode: 0 });
  expect(execs).toHaveLength(2);
  expect(execs[0]!.slice(0, 3)).toEqual(["/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-probe", "observe-isolation"]);
  expect(execs[1]).toEqual(["/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-worker", "build-source"]);
});

test("Modal refuses a deterministic-name collision without a durably returned sandbox ID", async () => {
  let creates = 0;
  const sandbox = { id: "foreign-sandbox", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), poll: async () => ({}), terminate: async () => {}, filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } };
  const clients = createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: PRODUCTION_WORKER_POLICY.version, modalAppName: "napplet-cvm-workers", modalTags: {}, journal: createMemoryWorkerOperationJournal(), fly: {} as never,
    modalSdk: { apps: { fromName: async () => ({}) }, images: { fromRegistry: () => ({}) }, sandboxes: { create: async () => { creates += 1; return sandbox; }, findByName: async () => ({ kind: "found" as const, sandbox }) } },
  });
  await expect(clients.modal.create({ operationId: "op-modal-collision", sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 })).resolves.toEqual({ status: "unknown", operationId: "op-modal-collision" });
  expect(creates).toBe(0);
});

test("Modal query-only recovery adopts only an exact server-held request tag set", async () => {
  let tags: Record<string, string> = {}; let found = false; let creates = 0;
  const sandbox = { id: "modal-recovered", getTags: async () => tags, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), poll: async () => ({}), terminate: async () => {}, filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } };
  const clients = createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: PRODUCTION_WORKER_POLICY.version, modalAppName: "napplet-cvm-workers", modalTags: { cohort: "test" }, journal: createMemoryWorkerOperationJournal(), fly: {} as never,
    modalSdk: { apps: { fromName: async () => ({}) }, images: { fromRegistry: () => ({}) }, sandboxes: { create: async (_app, _image, options) => { creates += 1; tags = { ...options.tags }; found = true; throw new Error("lost response"); }, findByName: async () => found ? ({ kind: "found" as const, sandbox }) : ({ kind: "missing" as const }) } },
  });
  const intent = { operationId: "op-modal-lost", sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 60_000 };
  await expect(clients.modal.create(intent)).resolves.toEqual({ status: "unknown", operationId: intent.operationId });
  await expect(clients.modal.create(intent)).resolves.toEqual({ status: "reconciled", operationId: intent.operationId, resourceId: "modal-recovered" });
  expect(creates).toBe(1);
  tags["napplet-cvm-lease-sha256"] = digest("d");
  await expect(clients.modal.create(intent)).resolves.toEqual({ status: "unknown", operationId: intent.operationId });
});
