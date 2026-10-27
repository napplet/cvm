import { expect, test } from "bun:test";
import { createWorkerDeploymentClients, PRODUCTION_WORKER_POLICY, WORKER_RUNNER_DEFINITION } from "../../src/release/deployment/worker-clients";

const digest = (letter: string) => letter.repeat(64);
const image = `registry.example/worker@sha256:${digest("a")}`;

test("uses one immutable, unselected worker runner definition for Modal and Fly", async () => {
  const calls: string[] = [];
  const clients = createWorkerDeploymentClients({
    image,
    workspaceRoot: "/workspace",
    policyVersion: PRODUCTION_WORKER_POLICY.version,
    modalSdk: { apps: { fromName: async () => (calls.push("modal-app"), {}) }, images: { fromRegistry: () => (calls.push("modal-image"), {}) }, sandboxes: { create: async () => (calls.push("modal-create"), { id: "fake", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), poll: async () => ({ state: "ready" }), terminate: async () => {}, filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } }) } },
    fly: {} as never,
  });
  expect(clients.modal.definition).toEqual(clients.fly.definition);
  expect(clients.modal.definition).toEqual(WORKER_RUNNER_DEFINITION);
  expect(clients.modal.schedules.map((entry) => entry.cohort)).toEqual(clients.fly.schedules.map((entry) => entry.cohort));
  expect(calls).toEqual([]);
  expect(clients.selection).toEqual({ status: "unselected", reasonCode: "FRESH_PROTECTED_EVIDENCE_REQUIRED" });
});

test("requires the production worker policy and does not permit a durable backlog schedule", () => {
  expect(() => createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: "phase-02-policy-2026-08-04", modalSdk: {} as never, fly: {} as never })).toThrow("WORKER_CLIENT_CONFIG_INVALID");
  expect(WORKER_RUNNER_DEFINITION.durableBacklog).toBe(0);
  expect(WORKER_RUNNER_DEFINITION.blockNetwork).toBeTrue();
  expect(WORKER_RUNNER_DEFINITION.noInboundPorts).toBeTrue();
});
