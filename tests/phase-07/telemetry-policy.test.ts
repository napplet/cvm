import { expect, test } from "bun:test";
import {
  LIFECYCLE_OUTCOMES,
  LIFECYCLE_STAGES,
  lifecycleCardinalityUpperBound,
  protectedCorrelationId,
  redactLifecycleObservation,
} from "../../src/telemetry/redaction";
import {
  InMemoryLifecycleExporter,
  OpenTelemetryLifecycleExporter,
  createLifecycleTelemetry,
} from "../../src/telemetry/otel";
import { LifecycleOutcomeSchema, LifecycleStageSchema } from "../../src/telemetry/contracts";

const key = new Uint8Array(32).fill(7);
const canaries = [
  "prompt: private idea", "generated source: const secret = 1", "nsec1privatekey", "signer-token-123",
  "cashu-proof-123", "lightning-preimage-123", "credential-123", "raw ContextVM envelope",
  "native receipt", "cli output", "runtime message", "provider payload", "/private/local/path", "user-defined-label",
];

function observation(stage: typeof LIFECYCLE_STAGES[number] = LIFECYCLE_STAGES[0], outcome: typeof LIFECYCLE_OUTCOMES[number] = LIFECYCLE_OUTCOMES[0]) {
  return { version: "cvm.lifecycle.v1", correlationId: "account/session/action", stage, outcome, monotonicMs: 42 };
}

test("uses the same closed lifecycle vocabulary at trusted coordinator and exporter boundaries", () => {
  expect(LifecycleStageSchema.options).toEqual([...LIFECYCLE_STAGES]);
  expect(LifecycleOutcomeSchema.options).toEqual([...LIFECYCLE_OUTCOMES]);
});

test("every finite lifecycle stage and outcome exports with protected correlation and no unknown attributes", async () => {
  const exporter = new InMemoryLifecycleExporter({ key });
  for (const stage of LIFECYCLE_STAGES) for (const outcome of LIFECYCLE_OUTCOMES) await exporter.observe(observation(stage, outcome));
  expect(exporter.observations).toHaveLength(LIFECYCLE_STAGES.length * LIFECYCLE_OUTCOMES.length);
  expect(exporter.observations.every((entry) => entry.correlationDigest.startsWith("sha256:"))).toBe(true);
  expect(exporter.observations.some((entry) => JSON.stringify(entry).includes("account/session/action"))).toBe(false);
  expect(protectedCorrelationId("account/session/action", key)).toEqual(exporter.observations[0]?.correlationDigest);
});

test("forbidden canaries and unknown or free-text attributes reach neither in-memory nor OTLP sink", async () => {
  const memory = new InMemoryLifecycleExporter({ key });
  const otlpRecords: unknown[] = [];
  const otlp = new OpenTelemetryLifecycleExporter({ key, onRedactedObservation: (entry) => otlpRecords.push(entry) });
  for (const canary of canaries) {
    const unsafe = { ...observation(), prompt: canary, provider: canary, labels: { user: canary } };
    await memory.observe(unsafe as never);
    await otlp.observe(unsafe as never);
    expect(redactLifecycleObservation(unsafe, { key })).toBeNull();
  }
  expect(memory.observations).toEqual([]);
  expect(otlpRecords).toEqual([]);
  expect(memory.telemetryPolicyViolations).toBe(canaries.length);
  expect(otlp.telemetryPolicyViolations).toBe(canaries.length);
});

test("parallel adversarial observations stay within the schema-computed finite metric cardinality bound", async () => {
  const exporter = new InMemoryLifecycleExporter({ key });
  await Promise.all(Array.from({ length: 1_000 }, (_, index) => exporter.observe({
    ...observation(LIFECYCLE_STAGES[index % LIFECYCLE_STAGES.length]!, LIFECYCLE_OUTCOMES[index % LIFECYCLE_OUTCOMES.length]!),
    correlationId: `user-controlled-${index}`,
  })));
  await Promise.all(Array.from({ length: 1_000 }, (_, index) => exporter.observe({
    ...observation(), provider: `provider-${index}`, region: `region-${index}`,
  } as never)));
  expect(exporter.metricSeriesCount).toBeLessThanOrEqual(lifecycleCardinalityUpperBound());
  expect(exporter.observations).toHaveLength(1_000);
  expect(exporter.telemetryPolicyViolations).toBe(1_000);
});

test("exporter failure is contained as one bounded policy fact and cannot change the caller's effect", async () => {
  let effects = 0;
  const telemetry = createLifecycleTelemetry({ key, exporter: { observe: () => { throw new Error("collector unavailable"); } } });
  const domainResult = async () => { await telemetry.observe(observation()); effects += 1; return { status: "accepted", effects }; };
  await expect(domainResult()).resolves.toEqual({ status: "accepted", effects: 1 });
  expect(telemetry.telemetryPolicyViolations).toBe(1);
  expect(effects).toBe(1);
});
