import { createHash } from "node:crypto";
import { z } from "zod";
import { LifecycleObservationSchema, type LifecycleTelemetryPort } from "../telemetry/contracts";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type NonGoogleCoreBinding = Readonly<{ candidateSha256: string; topologySha256: string }>;
export type NonGoogleCoreHeld = Readonly<{ status: "held"; reason: "SUCCESSOR_AUTHORITY_HELD" | "COLLECTOR_OBSERVATION_HELD" }>;

/**
 * Project-owned collector seam. It emits only the existing finite redacted
 * lifecycle vocabulary and preserves exact candidate/topology correlation.
 * Construction is intentionally I/O-free; the future verified authority owns
 * the collector reader and durable journal materialization.
 */
export class NonGoogleAuthenticatedCollector {
  readonly #telemetry: LifecycleTelemetryPort;
  constructor(readonly binding: NonGoogleCoreBinding, telemetry: LifecycleTelemetryPort) {
    Digest.parse(binding.candidateSha256); Digest.parse(binding.topologySha256);
    this.#telemetry = telemetry;
    Object.freeze(this);
  }
  async emit(observation: unknown): Promise<void> {
    const parsed = LifecycleObservationSchema.parse(observation);
    if (parsed.correlationDigest !== `sha256:${this.binding.candidateSha256}`) throw new Error("NON_GOOGLE_TELEMETRY_CORRELATION_DENIED");
    await this.#telemetry.observe(parsed);
  }
}

/**
 * Native telemetry producer/query service. With a future verified authority it
 * claims the original operation in PostgreSQL before emitting. Without that
 * authority it remains an explicit held result, never a fabricated pass.
 */
export class NonGoogleTelemetryCertification {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; collector?: NonGoogleAuthenticatedCollector; journal?: PostgresOperationJournal }>) {
    if (input.collector && (input.collector.binding.candidateSha256 !== input.binding.candidateSha256 || input.collector.binding.topologySha256 !== input.binding.topologySha256)) throw new Error("NON_GOOGLE_TELEMETRY_BINDING_DENIED");
    Digest.parse(input.binding.candidateSha256); Digest.parse(input.binding.topologySha256);
    Object.freeze(this);
  }
  async emit(input: Readonly<{ operationId: string; observation: unknown }>): Promise<Readonly<{ status: "emitted" } | NonGoogleCoreHeld>> {
    const observation = LifecycleObservationSchema.parse(input.observation);
    if (observation.correlationDigest !== `sha256:${this.input.binding.candidateSha256}`) throw new Error("NON_GOOGLE_TELEMETRY_CORRELATION_DENIED");
    if (!this.input.journal || !this.input.collector) return Object.freeze({ status: "held" as const, reason: "SUCCESSOR_AUTHORITY_HELD" as const });
    const identity = sha({ version: 1, binding: this.input.binding, operationId: input.operationId, observation });
    const claim = await this.input.journal.claim(`non-google-telemetry:${input.operationId}`, identity, { version: 1, binding: this.input.binding, operationId: input.operationId, observation, state: "pending" });
    if (!claim.claimed) return Object.freeze({ status: "emitted" as const });
    await this.input.collector.emit(observation);
    return Object.freeze({ status: "emitted" as const });
  }
  async query(input: Readonly<{ operationId: string; binding: unknown }>): Promise<Readonly<{ status: "observed" } | NonGoogleCoreHeld>> {
    const binding = z.object({ candidateId: Digest, topologySha256: Digest }).passthrough().parse(input.binding);
    if (binding.candidateId !== this.input.binding.candidateSha256 || binding.topologySha256 !== this.input.binding.topologySha256) throw new Error("NON_GOOGLE_TELEMETRY_WINDOW_BINDING_DENIED");
    if (!this.input.journal) return Object.freeze({ status: "held" as const, reason: "COLLECTOR_OBSERVATION_HELD" as const });
    const original = await this.input.journal.read(`non-google-telemetry:${input.operationId}`);
    if (!original) throw new Error("NON_GOOGLE_TELEMETRY_ORIGINAL_REQUIRED");
    return Object.freeze({ status: "observed" as const });
  }
}
