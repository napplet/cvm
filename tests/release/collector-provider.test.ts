import { expect, test } from "bun:test";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { createNativeCollectorProvider, type CollectorControlPlanePort } from "../../src/release/native/collector";
import { LifecycleStageSchema } from "../../src/telemetry/contracts";

const digest = (letter: string) => letter.repeat(64);
const now = 1_000;

async function authorized() {
  const config = { candidateSha256: digest("a"), topologySha256: digest("b"), effectPlanSha256: digest("c"), accountScopeSha256: digest("d"), projectScopeSha256: digest("e"), projectId: "napplet-cvm-run-1", endpointReference: "collector/phase-07", endpointReferenceSha256: digest("f"), collectorDigest: `sha256:${digest("1")}`, configSha256: digest("2") };
  const request = await createAuthorizationRequest({
    candidateSha256: config.candidateSha256, topologySha256: config.topologySha256, effectPlanSha256: config.effectPlanSha256, controllerStateSha256: digest("3"), providerCapabilitiesSha256: digest("4"),
    orderedEffects: [{ id: "collector", provider: "collector", operation: "configure", estimatedCostMicros: 1 }],
    providerScopes: [{ provider: "collector", accountScopeSha256: config.accountScopeSha256, projectScopeSha256: config.projectScopeSha256 }],
    estimate: { currency: "USD", maximumMicros: 1, sourceId: "gcp-catalog", observedAtMs: 1, freshUntilMs: 10_000 }, maximumRunDurationMs: 1_000, cleanupByMs: 9_000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: true, billing: true, apiEnablement: ["run.googleapis.com"] }, expiresAtMs: 9_000,
  });
  return { config, request, receipt: await createAuthorizationReceipt(request) };
}

function port(transcript: string[], records: unknown[] = []): CollectorControlPlanePort {
  let configured = false;
  return {
    persist: async ({ operationId }) => { transcript.push(`persist:${operationId}`); },
    observe: async ({ operationId }) => {
      if (operationId === "collector-1" && !configured) return { status: "missing" as const };
      return { status: "completed" as const, endpointReferenceSha256: digest("f") };
    },
    observeCleanup: async () => ({ status: "missing" as const }),
    configure: async ({ operationId }) => { transcript.push(`configure:${operationId}`); configured = true; },
    deleteCollector: async ({ operationId }) => { transcript.push(`delete:${operationId}`); },
    emit: async ({ observation }) => { records.push(observation); },
    queryWindow: async ({ binding }) => ({ status: "observed", binding, observations: records, rejectedCanaries: true, metricSeriesCount: 15 }),
  };
}

test("applies only after receipt-gated original-operation persistence and returns a reference-only candidate-bound endpoint", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const provider = createNativeCollectorProvider({ config, port: port(transcript), now: () => now });
  const input = { request, receipt, operationId: "collector-1" };
  await provider.plan(input);
  expect(transcript).toEqual([]);
  await provider.apply(input);
  await expect(provider.observe(input)).resolves.toMatchObject({ status: "completed", endpointReferenceSha256: config.endpointReferenceSha256 });
  expect(JSON.stringify(await provider.observe(input))).not.toContain(config.endpointReference);
});

test("bridges concurrent complete lifecycle vocabulary through the exact candidate/topology window and rejects sensitive canaries", async () => {
  const transcript: string[] = [];
  const records: unknown[] = [];
  const { config, request, receipt } = await authorized();
  const provider = createNativeCollectorProvider({ config, port: port(transcript, records), now: () => now });
  const input = { request, receipt, operationId: "collector-1" };
  await provider.apply(input);
  await Promise.all(LifecycleStageSchema.options.map((stage, index) => provider.telemetry.emit({ version: "admission-lifecycle-v1", correlationDigest: `sha256:${digest("a")}`, stage, outcome: stage === "capacity_refused" ? "capacity_unavailable" : "succeeded", monotonicMs: index + 1 })));
  const binding = { candidateId: config.candidateSha256, topologySha256: config.topologySha256, datasetSha256: digest("b"), profileSha256: digest("c"), collectorDigest: config.collectorDigest, configSha256: config.configSha256 };
  const window = await provider.telemetry.queryWindow(binding);
  expect(window).toMatchObject({ status: "observed", binding, rejectedCanaries: true });
  expect((window as { observations: unknown[] }).observations).toHaveLength(LifecycleStageSchema.options.length);
  await expect(provider.telemetry.emit({ version: "admission-lifecycle-v1", correlationDigest: `sha256:${digest("a")}`, stage: "generation", outcome: "succeeded", monotonicMs: 99, prompt: "secret" } as never)).rejects.toThrow("COLLECTOR_OBSERVATION_INVALID");
});

test("revalidates before configure and scopes cleanup to the candidate-bound collector", async () => {
  let clock = now;
  const { config, request, receipt } = await authorized();
  const base = port([]);
  const provider = createNativeCollectorProvider({ config, port: { ...base, observe: async () => { clock = 9_000; return { status: "missing" as const }; } }, now: () => clock });
  const input = { request, receipt, operationId: "collector-1" };
  await expect(provider.apply(input)).rejects.toThrow("COLLECTOR_AUTHORIZATION_INVALID");
  clock = now;
  await expect(provider.cleanup({ ...input, runOwnedEndpointReference: "collector/other" })).rejects.toThrow("COLLECTOR_CLEANUP_SCOPE_INVALID");
});

test("cleanup accepts a terminal query-only recovery observation without redispatching deletion", async () => {
  const transcript: string[] = [];
  const { config, request, receipt } = await authorized();
  const base = port(transcript);
  const provider = createNativeCollectorProvider({ config, port: { ...base, observeCleanup: async () => ({ status: "cleaned" as const }) }, now: () => now });
  await expect(provider.cleanup({ request, receipt, operationId: "collector-1", runOwnedEndpointReference: config.endpointReference })).resolves.toMatchObject({ status: "cleaned" });
  expect(transcript).toEqual(["persist:collector-1:cleanup"]);
});


test("historical cleanup observation validates original scope and receipt without writes or deletion", async () => {
  const { config, request, receipt } = await authorized();
  const transcript: string[] = [];
  for (const status of ["cleaned", "missing", "pending", "unknown", "blocked"] as const) {
    const provider = createNativeCollectorProvider({ config, port: { ...port(transcript), async observeCleanup(value) { transcript.push(value.operationId); return { status }; } }, now: () => 10_000 });
    const original = { request, receipt, operationId: "collector-1", runOwnedEndpointReference: config.endpointReference };
    expect(await provider.observeCleanup(original)).toEqual({ status });
    expect(transcript.splice(0)).toEqual(["collector-1:cleanup"]);
    await expect(provider.observeCleanup({ ...original, runOwnedEndpointReference: "collector/other" })).rejects.toThrow("CLEANUP_SCOPE_INVALID");
    await expect(provider.observeCleanup({ ...original, receipt: { ...receipt, authorizationReceiptSha256: digest("9") } })).rejects.toThrow("AUTHORIZATION_INVALID");
    await expect(provider.cleanup(original)).rejects.toThrow("AUTHORIZATION_INVALID");
    expect(transcript).toEqual([]);
  }
});
