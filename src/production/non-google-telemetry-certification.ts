import { createHash } from "node:crypto";
import { z } from "zod";
import { LifecycleObservationSchema } from "../telemetry/contracts";
import type { NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleCoreJournal } from "./non-google-native-runtime";
import { NonGoogleSigNozDriver } from "./non-google-signoz-driver";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const WindowBinding = z.object({ candidateId: z.string().regex(/^[a-f0-9]{64}$/u), topologySha256: z.string().regex(/^[a-f0-9]{64}$/u), datasetSha256: z.string().regex(/^[a-f0-9]{64}$/u), profileSha256: z.string().regex(/^[a-f0-9]{64}$/u), collectorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), configSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
type Emission = Readonly<{ version: 2; binding: NonGoogleCoreBinding; telemetryRunId: string; controlOperationId: string; observation: z.infer<typeof LifecycleObservationSchema>; state: "claimed" | "emitted" }>;

/** Native OTLP producer and authenticated SigNoz reader. The journal only
 * contains write-ahead intent/ack state; it never stands in for collector data. */
export class NonGoogleTelemetryCertification {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; collector: NonGoogleSigNozDriver; journal: NonGoogleCoreJournal }>) { Object.freeze(this); }
  #run() { return `telemetry:${this.input.binding.candidateSha256}:${this.input.binding.topologySha256}`; }
  #key(stage: string) { return `${this.#run()}:stage:${stage}`; }
  async emit(input: Readonly<{ operationId: string; observation: unknown }>): Promise<void> {
    const observation = LifecycleObservationSchema.parse(input.observation);
    if (observation.correlationDigest !== `sha256:${this.input.binding.candidateSha256}`) throw new Error("NON_GOOGLE_TELEMETRY_CORRELATION_DENIED");
    const original: Emission = Object.freeze({ version: 2, binding: this.input.binding, telemetryRunId: this.#run(), controlOperationId: z.string().min(1).parse(input.operationId), observation, state: "claimed" });
    const claim = await this.input.journal.claim(this.#key(observation.stage), hash(original), original);
    if (!claim.claimed && claim.record.value.state === "emitted") return;
    if (!claim.claimed) throw new Error("NON_GOOGLE_TELEMETRY_ORIGINAL_PENDING");
    await this.input.collector.emitOtlpJson({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: this.input.collector.reference.serviceName } }, { key: "napplet.candidate_sha256", value: { stringValue: this.input.binding.candidateSha256 } }, { key: "napplet.topology_sha256", value: { stringValue: this.input.binding.topologySha256 } }] }, scopeSpans: [{ spans: [{ name: `napplet.${observation.stage}`, attributes: Object.entries(observation).map(([key, value]) => ({ key: `napplet.${key}`, value: { stringValue: String(value) } })) }] }] }] });
    if (!await this.input.journal.replace(this.#key(observation.stage), claim.record.identitySha256, claim.record.revision, Object.freeze({ ...original, state: "emitted" as const }))) throw new Error("NON_GOOGLE_TELEMETRY_EMISSION_CONFLICT");
  }
  async query(input: Readonly<{ operationId: string; binding: unknown }>): Promise<unknown> {
    const binding = WindowBinding.parse(input.binding);
    if (binding.candidateId !== this.input.binding.candidateSha256 || binding.topologySha256 !== this.input.binding.topologySha256) throw new Error("NON_GOOGLE_TELEMETRY_WINDOW_BINDING_DENIED");
    const now = Date.now(); const window = await this.input.collector.queryRange({ start: now - 15 * 60_000, end: now, candidateSha256: binding.candidateId, topologySha256: binding.topologySha256 });
    const observations = window.observations.map(value => LifecycleObservationSchema.safeParse(value)).filter((value): value is z.ZodSafeParseSuccess<z.infer<typeof LifecycleObservationSchema>> => value.success).map(value => value.data);
    if (observations.length === 0 || !window.rejectedCanaries) throw new Error("NON_GOOGLE_TELEMETRY_COLLECTOR_OBSERVATION_REQUIRED");
    z.string().min(1).parse(input.operationId);
    return Object.freeze({ status: "observed" as const, binding, observations: Object.freeze(observations), rejectedCanaries: true as const, metricSeriesCount: window.metricSeriesCount });
  }
}
