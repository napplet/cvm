import { expect, test } from "bun:test";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { createGcpBootstrapAdapter, deriveGcpProjectScopeSha256, type GcpBootstrapPort } from "../../src/release/native/gcp-bootstrap";

const digest = (letter: string) => letter.repeat(64);
const now = 1_000;

async function authorized() {
  const scope = {
    projectId: "napplet-cvm-run-1",
    billingAccountId: "billingAccounts/abc",
    accountScopeSha256: digest("f"),
  };
  const request = await createAuthorizationRequest({
    candidateSha256: digest("a"), topologySha256: digest("b"), effectPlanSha256: digest("c"), controllerStateSha256: digest("d"), providerCapabilitiesSha256: digest("e"),
    orderedEffects: [{ id: "cloud-run-ingress", provider: "cloud_run", operation: "create_or_update", estimatedCostMicros: 1 }],
    providerScopes: [{ provider: "cloud_run", accountScopeSha256: scope.accountScopeSha256, projectScopeSha256: await deriveGcpProjectScopeSha256(scope) }],
    estimate: { currency: "USD", maximumMicros: 1, sourceId: "gcp-catalog", observedAtMs: 1, freshUntilMs: 10_000 },
    maximumRunDurationMs: 1_000, cleanupByMs: 9_000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["run.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"] },
    expiresAtMs: 9_000,
  });
  return { request, receipt: await createAuthorizationReceipt(request), scope: { ...scope, projectScopeSha256: await deriveGcpProjectScopeSha256(scope) } };
}

function port(transcript: string[], state = new Set<string>(), persisted: Array<Record<string, string>> = []): GcpBootstrapPort {
  return {
    persist: async (input) => { persisted.push(input); transcript.push(`persist:${input.operationId}`); },
    observe: async ({ projectId, billingAccountId, service }) => {
      transcript.push(`observe:${projectId}:${billingAccountId}:${service ?? "project"}`);
      return { status: state.has(service ?? "project") ? "completed" : "missing" };
    },
    createProject: async ({ projectId }) => { transcript.push(`create:${projectId}`); state.add("project"); },
    linkBilling: async ({ projectId, billingAccountId }) => { transcript.push(`billing:${projectId}:${billingAccountId}`); state.add("billing"); },
    enableService: async ({ projectId, service }) => { transcript.push(`enable:${projectId}:${service}`); state.add(service); },
    deleteProject: async ({ projectId }) => { transcript.push(`delete:${projectId}`); state.delete("project"); },
  };
}

test("plans read-only and applies each authorized GCP bootstrap effect only after durable original-operation persistence", async () => {
  const transcript: string[] = [];
  const persisted: Array<Record<string, string>> = [];
  const adapter = createGcpBootstrapAdapter({ port: port(transcript, new Set(), persisted), now: () => now });
  const { request, receipt, scope } = await authorized();
  const input = { request, receipt, operationId: "gcp-bootstrap-1", ...scope };

  const plan = await adapter.plan(input);
  expect(plan.effects.map((effect) => effect.kind)).toEqual(["create_project", "link_billing", "enable_service", "enable_service", "enable_service"]);
  expect(transcript).toEqual([]);

  await adapter.apply(input);
  expect(transcript).toEqual([
    "persist:gcp-bootstrap-1:project", "observe:napplet-cvm-run-1:billingAccounts/abc:project", "create:napplet-cvm-run-1",
    "persist:gcp-bootstrap-1:billing", "observe:napplet-cvm-run-1:billingAccounts/abc:billing", "billing:napplet-cvm-run-1:billingAccounts/abc",
    "persist:gcp-bootstrap-1:service:run.googleapis.com", "observe:napplet-cvm-run-1:billingAccounts/abc:run.googleapis.com", "enable:napplet-cvm-run-1:run.googleapis.com",
    "persist:gcp-bootstrap-1:service:sqladmin.googleapis.com", "observe:napplet-cvm-run-1:billingAccounts/abc:sqladmin.googleapis.com", "enable:napplet-cvm-run-1:sqladmin.googleapis.com",
    "persist:gcp-bootstrap-1:service:storage.googleapis.com", "observe:napplet-cvm-run-1:billingAccounts/abc:storage.googleapis.com", "enable:napplet-cvm-run-1:storage.googleapis.com",
  ]);
  expect(persisted).toHaveLength(5);
  expect(persisted.every((entry) => entry.authorizationRequestSha256 === request.authorizationRequestSha256 && entry.authorizationReceiptSha256 === receipt.authorizationReceiptSha256 && entry.operationId.startsWith("gcp-bootstrap-1:"))).toBeTrue();
});

test("rejects a non-exact receipt before any port interaction and observes original operations on idempotent retry", async () => {
  const transcript: string[] = [];
  const adapter = createGcpBootstrapAdapter({ port: port(transcript, new Set(["project", "billing", "run.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"])), now: () => now });
  const { request, receipt, scope } = await authorized();
  const input = { request, receipt, operationId: "gcp-bootstrap-1", ...scope };

  await expect(adapter.apply({ ...input, receipt: { ...receipt, authorizationReceiptSha256: digest("9") } })).rejects.toThrow("GCP_BOOTSTRAP_AUTHORIZATION_INVALID");
  expect(transcript).toEqual([]);
  await adapter.apply(input);
  expect(transcript.filter((entry) => entry.startsWith("observe:"))).toHaveLength(5);
  expect(transcript.some((entry) => /^(create|billing|enable):/.test(entry))).toBeFalse();
});

test("blocks cross-project cleanup and only deletes the authorized run-owned project before receipt expiry", async () => {
  const transcript: string[] = [];
  const adapter = createGcpBootstrapAdapter({ port: port(transcript, new Set(["project"])), now: () => now });
  const { request, receipt, scope } = await authorized();
  const input = { request, receipt, operationId: "gcp-bootstrap-1", ...scope };

  await expect(adapter.cleanup({ ...input, runOwnedProjectId: "another-project" })).rejects.toThrow("GCP_BOOTSTRAP_CLEANUP_SCOPE_INVALID");
  await adapter.cleanup({ ...input, runOwnedProjectId: input.projectId });
  expect(transcript).toEqual(["persist:gcp-bootstrap-1:cleanup", "observe:napplet-cvm-run-1:billingAccounts/abc:project", "delete:napplet-cvm-run-1"]);
});

test("rechecks receipt expiry at the mutation boundary after reconciliation", async () => {
  const transcript: string[] = [];
  let clock = now;
  const delayedPort = {
    ...port(transcript),
    observe: async ({ projectId, billingAccountId, service }: { projectId: string; billingAccountId: string; service?: string }) => {
      transcript.push(`observe:${projectId}:${billingAccountId}:${service ?? "project"}`);
      clock = 9_000;
      return { status: "missing" as const };
    },
  };
  const adapter = createGcpBootstrapAdapter({ port: delayedPort, now: () => clock });
  const { request, receipt, scope } = await authorized();
  const input = { request, receipt, operationId: "gcp-bootstrap-1", ...scope };

  await expect(adapter.apply(input)).rejects.toThrow("GCP_BOOTSTRAP_AUTHORIZATION_INVALID");
  expect(transcript).toEqual(["persist:gcp-bootstrap-1:project", "observe:napplet-cvm-run-1:billingAccounts/abc:project"]);
});
