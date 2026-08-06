import { z } from "zod";
import { CertificationInputSchema, ProtectedSuiteResultSchema, WorkerCandidateSchema, type ProtectedSuiteResult } from "../contracts";
import { LifecycleObservationSchema, LifecycleStageSchema, type LifecycleObservation } from "../../telemetry/contracts";
import { lifecycleCardinalityUpperBound } from "../../telemetry/redaction";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const CollectorDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/iu);
const WindowBindingSchema = z.object({
  candidateId: DigestSchema,
  topologySha256: DigestSchema,
  datasetSha256: DigestSchema,
  profileSha256: DigestSchema,
  collectorDigest: CollectorDigestSchema,
  configSha256: DigestSchema,
}).strict();
const WindowSchema = z.object({
  status: z.literal("observed"),
  binding: WindowBindingSchema,
  observations: z.array(LifecycleObservationSchema),
  rejectedCanaries: z.literal(true),
  metricSeriesCount: z.number().int().nonnegative(),
}).strict();

export type LiveTelemetryObservationPort = Readonly<{
  evidenceClass: "protected_live" | "deterministic";
  emit(observation: LifecycleObservation): Promise<void>;
  queryWindow(binding: unknown): Promise<unknown>;
}>;

export type LiveTelemetryCertificationInput = Readonly<{
  candidate: unknown;
  input: unknown;
  collector: Readonly<{ collectorDigest: string; configSha256: string }>;
  observationPort?: LiveTelemetryObservationPort;
}>;

function nonPass(status: "blocked" | "failed", reasonCode: ProtectedSuiteResult["reasonCode"], limitation: string): ProtectedSuiteResult {
  return ProtectedSuiteResultSchema.parse({ status, claims: [], limitations: [limitation], reasonCode });
}

/**
 * Emits the complete finite lifecycle vocabulary through the collector seam,
 * then validates the returned candidate-bound window. The port has no evidence
 * writer, provider client, or claim authority; Plan 07-25 supplies it only
 * after protected authorization.
 */
export async function runLiveTelemetryCertification(input: LiveTelemetryCertificationInput): Promise<ProtectedSuiteResult> {
  const candidate = WorkerCandidateSchema.safeParse(input.candidate);
  const certificationInput = CertificationInputSchema.safeParse(input.input);
  const binding = WindowBindingSchema.safeParse({
    candidateId: candidate.success ? candidate.data.id : "",
    topologySha256: certificationInput.success ? certificationInput.data.topologySha256 : "",
    datasetSha256: certificationInput.success ? certificationInput.data.datasetSha256 : "",
    profileSha256: certificationInput.success ? certificationInput.data.profileSha256 : "",
    collectorDigest: input.collector.collectorDigest,
    configSha256: input.collector.configSha256,
  });
  const port = input.observationPort;
  if (!candidate.success || !certificationInput.success || !binding.success || !port || port.evidenceClass !== "protected_live") {
    return nonPass("blocked", "INPUT_UNAVAILABLE", "protected-live-collector-required");
  }

  try {
    let monotonicMs = 1;
    for (const stage of LifecycleStageSchema.options) {
      await port.emit(LifecycleObservationSchema.parse({
        version: "admission-lifecycle-v1",
        correlationDigest: `sha256:${candidate.data.id}`,
        stage,
        outcome: stage === "capacity_refused" ? "capacity_unavailable" : "succeeded",
        monotonicMs: monotonicMs++,
      }));
    }
    const window = WindowSchema.safeParse(await port.queryWindow(binding.data));
    if (!window.success) return nonPass("blocked", "INPUT_UNAVAILABLE", "collector-window-unavailable");
    const stages = new Set(window.data.observations.map((observation) => observation.stage));
    const lifecycleComplete = LifecycleStageSchema.options.every((stage) => stages.has(stage));
    const exactBinding = JSON.stringify(window.data.binding) === JSON.stringify(binding.data);
    const cardinalitySafe = window.data.metricSeriesCount <= lifecycleCardinalityUpperBound();
    if (!lifecycleComplete || !exactBinding || !cardinalitySafe) return nonPass("failed", "EVIDENCE_INVALID", "collector-window-invalid");
    return ProtectedSuiteResultSchema.parse({
      status: "passed", claims: ["release.telemetry_policy"], limitations: ["selection-external"], reasonCode: "OBSERVATION_COMPLETE",
    });
  } catch {
    return nonPass("blocked", "PROVIDER_UNAVAILABLE", "collector-observation-unavailable");
  }
}
