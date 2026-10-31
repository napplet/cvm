import { createHash } from "node:crypto";
import { z } from "zod";
import { LifecycleObservationSchema } from "../telemetry/contracts";
import type { NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleAuthenticatedTelemetryProducer, NonGoogleCoreJournal } from "./non-google-native-runtime";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Emission = Readonly<{ version: 1; binding: NonGoogleCoreBinding; telemetryRunId: string; controlOperationId: string; observation: z.infer<typeof LifecycleObservationSchema>; state: "claimed" | "emitted" }>;

/** Authenticated producer/query pair. The telemetry-window identity is one
 * candidate/topology run; individual control IDs remain audit correlations and
 * are never used to discover a different window. */
export class NonGoogleTelemetryCertification {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; collector: NonGoogleAuthenticatedTelemetryProducer; journal: NonGoogleCoreJournal }>) { Object.freeze(this); }
  #run() { return `telemetry:${this.input.binding.candidateSha256}:${this.input.binding.topologySha256}`; }
  #key(stage: string) { return `${this.#run()}:${stage}`; }
  async emit(input: Readonly<{ operationId: string; observation: unknown }>): Promise<Readonly<{ status: "emitted"; telemetryRunId: string }>> {
    const observation = LifecycleObservationSchema.parse(input.observation);
    if (observation.correlationDigest !== `sha256:${this.input.binding.candidateSha256}`) throw new Error("NON_GOOGLE_TELEMETRY_CORRELATION_DENIED");
    const telemetryRunId = this.#run();
    const original: Emission = Object.freeze({ version: 1, binding: this.input.binding, telemetryRunId, controlOperationId: z.string().min(1).parse(input.operationId), observation, state: "claimed" });
    const claim = await this.input.journal.claim(this.#key(observation.stage), hash(original), original);
    if (!claim.claimed) return Object.freeze({ status: "emitted" as const, telemetryRunId });
    await this.input.collector.emit(observation);
    if (!await this.input.journal.replace(this.#key(observation.stage), claim.record.identitySha256, claim.record.revision, Object.freeze({ ...original, state: "emitted" as const }))) throw new Error("NON_GOOGLE_TELEMETRY_EMISSION_CONFLICT");
    return Object.freeze({ status: "emitted" as const, telemetryRunId });
  }
  async query(input: Readonly<{ operationId: string; binding: unknown }>): Promise<Readonly<{ status: "observed"; telemetryRunId: string; stages: readonly string[] }>> {
    const binding = z.object({ candidateId: z.string().regex(/^[a-f0-9]{64}$/u), topologySha256: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough().parse(input.binding);
    if (binding.candidateId !== this.input.binding.candidateSha256 || binding.topologySha256 !== this.input.binding.topologySha256) throw new Error("NON_GOOGLE_TELEMETRY_WINDOW_BINDING_DENIED");
    const stages = ["generation", "checkpoint", "resume", "publish"] as const;
    const emitted: string[] = [];
    for (const stage of stages) {
      const original = await this.input.journal.read<Emission>(this.#key(stage));
      if (original?.value.state === "emitted" && original.value.telemetryRunId === this.#run()) emitted.push(stage);
    }
    if (!emitted.length) throw new Error("NON_GOOGLE_TELEMETRY_ORIGINAL_REQUIRED");
    z.string().min(1).parse(input.operationId);
    return Object.freeze({ status: "observed" as const, telemetryRunId: this.#run(), stages: Object.freeze(emitted) });
  }
}
