import { expect, test } from "bun:test";
import { createWorkerDeploymentClients, WORKER_RUNNER_DEFINITION } from "../../src/release/deployment/worker-clients";

const digest = (letter: string) => letter.repeat(64);
const image = `registry.example/worker@sha256:${digest("a")}`;

test("uses one immutable, unselected worker runner definition for Modal and Fly", async () => {
  const calls: string[] = [];
  const clients = createWorkerDeploymentClients({
    image,
    workspaceRoot: "/workspace",
    policyVersion: "phase-02-policy-2026-08-04",
    modalSdk: { apps: { fromName: async () => (calls.push("modal-app"), {}) }, images: { fromRegistry: () => (calls.push("modal-image"), {}) }, sandboxes: { create: async () => (calls.push("modal-create"), { id: "fake", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), poll: async () => ({ state: "ready" }), terminate: async () => {}, filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } }) } },
    flyFetch: async () => (calls.push("fly-fetch"), new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    flyApiOrigin: "http://127.0.0.1:8787",
  });
  expect(clients.modal.definition).toEqual(clients.fly.definition);
  expect(clients.modal.definition).toEqual(WORKER_RUNNER_DEFINITION);
  expect(clients.modal.schedules.map((entry) => entry.cohort)).toEqual(clients.fly.schedules.map((entry) => entry.cohort));
  expect(calls).toEqual([]);
  expect(clients.selection).toEqual({ status: "unselected", reasonCode: "FRESH_PROTECTED_EVIDENCE_REQUIRED" });
});

test("rejects non-loopback Fly transport and does not permit a durable backlog schedule", () => {
  expect(() => createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: "phase-02-policy-2026-08-04", modalSdk: {} as never, flyFetch: fetch, flyApiOrigin: "https://api.machines.dev" })).toThrow("WORKER_CLIENT_LOOPBACK_REQUIRED");
  expect(WORKER_RUNNER_DEFINITION.durableBacklog).toBe(0);
  expect(WORKER_RUNNER_DEFINITION.blockNetwork).toBeTrue();
  expect(WORKER_RUNNER_DEFINITION.noInboundPorts).toBeTrue();
});
