import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { LifecycleObservationSchema, LifecycleOutcomeSchema, LifecycleStageSchema, type LifecycleObservation } from "../telemetry/contracts";
import { lifecycleCardinalityUpperBound } from "../telemetry/redaction";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const digest = (value: string) => { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("COLLECTOR_WINDOW_DIGEST_INVALID"); return value; };
const metricKeys = ["cvm.lifecycle.outcome", "cvm.lifecycle.stage", "cvm.lifecycle.version"];
const traceKeys = [...metricKeys, "cvm.certification.window", "cvm.correlation.digest", "cvm.monotonic_ms"].sort();

/** OTLP/HTTP JSON uses hex IDs and decimal strings for uint64 fields.
 * https://opentelemetry.io/docs/specs/otlp/ */
export function collectorLifecyclePackets(input: Readonly<{ operationId: string; windowSha256: string; observation: unknown; nowMs: number }>) {
  const observation = LifecycleObservationSchema.parse(input.observation);
  digest(input.windowSha256);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u.test(input.operationId) || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error("COLLECTOR_OPERATION_INVALID");
  const identity = sha({ operationId: input.operationId, windowSha256: input.windowSha256 });
  const traceId = identity.slice(0, 32), spanId = identity.slice(32, 48);
  const time = (BigInt(input.nowMs) * 1_000_000n).toString();
  const attributes = (values: Record<string, string>) => Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }));
  const metricAttributes = { "cvm.lifecycle.version": "v1", "cvm.lifecycle.stage": observation.stage, "cvm.lifecycle.outcome": observation.outcome ?? "none" };
  const scope = { name: "cvm.certification.v1" };
  return Object.freeze({ traceId, spanId, observation,
    traces: { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope, spans: [{ traceId, spanId, name: `cvm.lifecycle.${observation.stage}`, kind: 1, startTimeUnixNano: time, endTimeUnixNano: time,
      attributes: attributes({ ...metricAttributes, "cvm.correlation.digest": observation.correlationDigest, "cvm.monotonic_ms": String(observation.monotonicMs), "cvm.certification.window": input.windowSha256 }) }] }] }] },
    metrics: { resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [{ scope, metrics: [{ name: "cvm.lifecycle.observations", sum: { aggregationTemporality: 1, isMonotonic: true,
      dataPoints: [{ attributes: attributes(metricAttributes), startTimeUnixNano: time, timeUnixNano: time, asInt: "1" }] } }] }] }] },
  });
}

function attrs(text: string, expected: readonly string[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.includes("->")) continue;
    const match = /^\s+-> ([a-z0-9_.]+): Str\(([^\r\n()]*)\)$/u.exec(line);
    if (!match || Object.hasOwn(attributes, match[1]!)) throw new Error("COLLECTOR_EXPORTED_ATTRIBUTE_INVALID");
    attributes[match[1]!] = match[2]!;
  }
  if (canonicalJson(Object.keys(attributes).sort()) !== canonicalJson([...expected].sort()) || attributes["cvm.lifecycle.version"] !== "v1") throw new Error("COLLECTOR_EXPORTED_ATTRIBUTE_INVALID");
  LifecycleStageSchema.parse(attributes["cvm.lifecycle.stage"]);
  if (attributes["cvm.lifecycle.outcome"] !== "none") LifecycleOutcomeSchema.parse(attributes["cvm.lifecycle.outcome"]);
  return attributes;
}

/** Parse only detailed exports from the pinned 0.153.0 collector. Production
 * must first authenticate Cloud Logging's exact project/service/revision and
 * time window. Raw JSON payloads are never retained as certification evidence. */
export function parseCollectorLifecycleWindow(input: Readonly<{
  windowSha256: string; entries: readonly unknown[];
  expected: readonly Readonly<{ traceId: string; spanId: string; observation: LifecycleObservation }>[];
}>) {
  digest(input.windowSha256);
  if (input.entries.length > 2_000 || input.expected.length < 1 || input.expected.length > 120) throw new Error("COLLECTOR_WINDOW_BOUND_EXCEEDED");
  const expected = new Map(input.expected.map(value => [value.traceId, value]));
  if (expected.size !== input.expected.length) throw new Error("COLLECTOR_EXPECTATION_DUPLICATE");
  const observed = new Map<string, LifecycleObservation>();
  const series = new Set<string>();
  for (const raw of input.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("COLLECTOR_EXPORT_INVALID");
    const entry = raw as Record<string, unknown>;
    if (entry["otelcol.component.id"] !== "debug" || entry["otelcol.component.kind"] !== "exporter") continue;
    const resource = entry.resource as Record<string, unknown> | undefined;
    if (resource?.["service.version"] !== "0.153.0" || resource?.["service.name"] !== "otelcol") throw new Error("COLLECTOR_VERSION_MISMATCH");
    if (typeof entry.msg !== "string" || Buffer.byteLength(entry.msg) > 1_048_576) throw new Error("COLLECTOR_EXPORT_INVALID");
    const message = entry.msg;
    if (entry["otelcol.signal"] === "traces" && message.startsWith("ResourceSpans #")) {
      for (const resourceBlock of message.split(/^ResourceSpans #\d+\n/mu).slice(1)) {
        if (!resourceBlock.includes("InstrumentationScope cvm.certification.v1 \n")) continue;
        for (const span of resourceBlock.split(/^Span #\d+\n/mu).slice(1)) {
          const attributesStart = span.indexOf("\nAttributes:\n");
          if (attributesStart < 0) throw new Error("COLLECTOR_EXPORTED_ATTRIBUTE_INVALID");
          const values = attrs(span.slice(attributesStart + "\nAttributes:\n".length), traceKeys);
          if (values["cvm.certification.window"] !== input.windowSha256) continue;
          const traceId = /^\s+Trace ID\s+: ([a-f0-9]{32})$/mu.exec(span)?.[1];
          const spanId = /^\s+ID\s+: ([a-f0-9]{16})$/mu.exec(span)?.[1];
          const intent = traceId ? expected.get(traceId) : undefined;
          if (!intent || intent.spanId !== spanId) throw new Error("COLLECTOR_ORIGINAL_TRACE_REQUIRED");
          const observation = LifecycleObservationSchema.parse({ version: "admission-lifecycle-v1", correlationDigest: values["cvm.correlation.digest"], stage: values["cvm.lifecycle.stage"], monotonicMs: Number(values["cvm.monotonic_ms"]), ...(values["cvm.lifecycle.outcome"] === "none" ? {} : { outcome: values["cvm.lifecycle.outcome"] }) });
          if (canonicalJson(observation) !== canonicalJson(intent.observation)) throw new Error("COLLECTOR_OBSERVATION_MISMATCH");
          observed.set(traceId!, observation);
        }
      }
    }
    if (entry["otelcol.signal"] === "metrics" && message.startsWith("ResourceMetrics #")) {
      for (const resourceBlock of message.split(/^ResourceMetrics #\d+\n/mu).slice(1)) {
        if (!resourceBlock.includes("InstrumentationScope cvm.certification.v1 \n")) continue;
        for (const metric of resourceBlock.split(/^Metric #\d+\n/mu).slice(1)) {
          if (!metric.includes("-> Name: cvm.lifecycle.observations\n") || !metric.includes("-> AggregationTemporality: Delta\n") || !metric.includes("-> IsMonotonic: true\n")) throw new Error("COLLECTOR_METRIC_INVALID");
          for (const point of metric.split(/^NumberDataPoints #\d+\n/mu).slice(1)) {
            const values = attrs(point, metricKeys);
            if (!/^Value: [1-9][0-9]*$/mu.test(point)) throw new Error("COLLECTOR_METRIC_INVALID");
            series.add(canonicalJson(values));
          }
        }
      }
    }
  }
  if (observed.size !== expected.size || series.size > lifecycleCardinalityUpperBound()) throw new Error("COLLECTOR_WINDOW_INCOMPLETE");
  const observations = [...observed.values()];
  for (const value of observations) if (!series.has(canonicalJson({ "cvm.lifecycle.version": "v1", "cvm.lifecycle.stage": value.stage, "cvm.lifecycle.outcome": value.outcome ?? "none" }))) throw new Error("COLLECTOR_WINDOW_INCOMPLETE");
  return Object.freeze({ observations, metricSeriesCount: series.size });
}

/** OTLP permits an absent or empty partialSuccess on full acceptance. Any
 * rejected count or warning is release-blocking; HTTP 200 alone is insufficient. */
export function assertCollectorAccepted(value: unknown): void {
  z.object({ partialSuccess: z.object({
    rejectedSpans: z.union([z.literal(0), z.literal("0")]).optional(),
    rejectedDataPoints: z.union([z.literal(0), z.literal("0")]).optional(),
    errorMessage: z.literal("").optional(),
  }).strict().optional() }).strict().parse(value);
}
