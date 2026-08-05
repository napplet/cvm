import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  lifecycleMetricAttributes,
  redactLifecycleObservation,
  type RedactedLifecycleObservation,
  type TelemetryRedactionOptions,
} from "./redaction";

type ObservationExporter = Readonly<{ observe(observation: unknown): Promise<void> | void }>;
type ExporterOptions = TelemetryRedactionOptions & Readonly<{ endpoint?: string; onRedactedObservation?: (observation: RedactedLifecycleObservation) => void }>;

/** Bounded instrument registry; provider, region, image, and cohort stay in certification evidence. */
export const LIFECYCLE_INSTRUMENTS = Object.freeze([
  "cvm.admission.receipt_to_ready_ms", "cvm.admission.outcomes", "cvm.admission.refusal_latency_ms",
  "cvm.admission.lease_without_ready", "cvm.admission.zero_backlog", "cvm.generation.model_usage",
  "cvm.ledger.settlement", "cvm.checkpoint.outcomes", "cvm.resume.outcomes", "cvm.validation.outcomes",
  "cvm.preview.outcomes", "cvm.publication.outcomes", "cvm.reconciliation.outcomes", "cvm.promotion.outcomes",
  "cvm.telemetry_policy_violation",
] as const);

function metricKey(observation: RedactedLifecycleObservation): string { return JSON.stringify(lifecycleMetricAttributes(observation)); }

/** Test sink and policy oracle. It contains only already-redacted observations. */
export class InMemoryLifecycleExporter implements ObservationExporter {
  readonly observations: RedactedLifecycleObservation[] = [];
  readonly #series = new Set<string>();
  #violations = 0;
  constructor(private readonly options: TelemetryRedactionOptions) {}
  get metricSeriesCount(): number { return this.#series.size; }
  get telemetryPolicyViolations(): number { return this.#violations; }
  observe(input: unknown): void {
    const observation = redactLifecycleObservation(input, this.options);
    if (!observation) { this.#violations += 1; return; }
    this.observations.push(observation); this.#series.add(metricKey(observation));
  }
}

/** Manual OTel only: no automatic instrumentation and no domain authority crosses this class. */
export class OpenTelemetryLifecycleExporter implements ObservationExporter {
  #violations = 0;
  readonly #tracerProvider?: BasicTracerProvider;
  readonly #meterProvider?: MeterProvider;
  constructor(private readonly options: ExporterOptions) {
    if (options.onRedactedObservation) return;
    const endpoint = options.endpoint ?? "http://127.0.0.1:4318";
    this.#tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))] });
    this.#meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }), exportIntervalMillis: 1_000 })] });
  }
  get telemetryPolicyViolations(): number { return this.#violations; }
  observe(input: unknown): void {
    const observation = redactLifecycleObservation(input, this.options);
    if (!observation) { this.#violations += 1; return; }
    try {
      if (this.options.onRedactedObservation) { this.options.onRedactedObservation(observation); return; }
      const attributes = { ...lifecycleMetricAttributes(observation), "cvm.correlation.digest": observation.correlationDigest };
      const span = this.#tracerProvider!.getTracer("cvm.lifecycle.v1").startSpan(`cvm.lifecycle.${observation.stage}`, { attributes });
      span.end();
      this.#meterProvider!.getMeter("cvm.lifecycle.v1").createCounter("cvm.lifecycle.observations").add(1, lifecycleMetricAttributes(observation));
    } catch { this.#violations += 1; }
  }
}

class SafeLifecycleTelemetry implements ObservationExporter {
  #violations = 0;
  constructor(private readonly options: TelemetryRedactionOptions & Readonly<{ exporter: ObservationExporter }>) {}
  get telemetryPolicyViolations(): number { return this.#violations; }
  async observe(input: unknown): Promise<void> {
    const observation = redactLifecycleObservation(input, this.options);
    if (!observation) { this.#violations += 1; return; }
    try { await this.options.exporter.observe(observation); } catch { this.#violations += 1; }
  }
}

/** Returns a total, non-throwing observer port for coordinator composition. */
export function createLifecycleTelemetry(options: TelemetryRedactionOptions & Readonly<{ exporter?: ObservationExporter }>): SafeLifecycleTelemetry {
  return new SafeLifecycleTelemetry({ key: options.key, exporter: options.exporter ?? new OpenTelemetryLifecycleExporter({ key: options.key }) });
}
