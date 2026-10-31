import { z } from "zod";
import { CORE_NATIVE_BACKEND_PROVENANCE, type CoreServiceControlKind } from "../release/deployment/production-core-suite-protocol";
import { NonGoogleAdmissionCertification } from "./non-google-admission-certification";
import { NonGoogleChaosCertification } from "./non-google-chaos-certification";
import { NonGoogleFreshRestoreProvisioner } from "./non-google-fresh-restore-provisioner";
import { NonGoogleTelemetryCertification, type NonGoogleCoreBinding } from "./non-google-telemetry-certification";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Held = z.object({ state: z.literal("held") }).strict();

/** Private Plan-68 constructor seam. It does not verify or mint v4 authority;
 * Plan 70 alone may replace this held authority with a verified sealed graph. */
export function createNonGoogleNativeCoreServices(input: Readonly<{ candidateSha256: string; topologySha256: string; successorAuthority: unknown }>) {
  const binding: NonGoogleCoreBinding = Object.freeze({ candidateSha256: Digest.parse(input.candidateSha256), topologySha256: Digest.parse(input.topologySha256) });
  Held.parse(input.successorAuthority);
  const admission = new NonGoogleAdmissionCertification({ binding });
  const telemetry = new NonGoogleTelemetryCertification({ binding });
  const chaos = new NonGoogleChaosCertification({ binding });
  const restore = new NonGoogleFreshRestoreProvisioner({ binding });
  const provenance = Object.freeze({
    ...CORE_NATIVE_BACKEND_PROVENANCE,
    admission: Object.freeze({ module: "src/production/non-google-admission-certification.ts", export: "NonGoogleAdmissionCertification", purpose: "candidate_bound_original_admission_journal" }),
    telemetry: Object.freeze({ module: "src/production/non-google-telemetry-certification.ts", export: "NonGoogleTelemetryCertification", purpose: "candidate_bound_authenticated_collector_journal" }),
    chaos: Object.freeze({ module: "src/production/non-google-chaos-certification.ts", export: "NonGoogleChaosCertification", purpose: "non_google_d122_original_journal" }),
    restore: Object.freeze({ module: "src/production/non-google-fresh-restore-provisioner.ts", export: "NonGoogleFreshRestoreProvisioner", purpose: "fresh_instance_original_intent" }),
  });
  async function dispatch(input: Readonly<{ operationId: string; kind: CoreServiceControlKind; payload: unknown }>): Promise<unknown> {
    switch (input.kind) {
      case "cohort.prepare": return admission.prepare({ operationId: input.operationId, ...z.object({ candidateId: z.string(), provider: z.enum(["modal", "fly"]), sample: z.unknown() }).strict().parse(input.payload) });
      case "cohort.observe": return admission.observe({ operationId: input.operationId, ...z.object({ candidateId: z.string(), provider: z.enum(["modal", "fly"]), sample: z.unknown() }).strict().parse(input.payload) });
      case "telemetry.emit": return telemetry.emit({ operationId: input.operationId, observation: z.object({ observation: z.unknown() }).strict().parse(input.payload).observation });
      case "telemetry.window": return telemetry.query({ operationId: input.operationId, binding: z.object({ binding: z.unknown() }).strict().parse(input.payload).binding });
      case "fault.inject": return chaos.inject({ operationId: input.operationId, schedule: z.object({ schedule: z.unknown() }).strict().parse(input.payload).schedule });
      case "fault.observe": return chaos.observe(z.object({ operationId: z.string(), sessionId: z.string() }).strict().parse(input.payload));
      // `restore.create` has no caller-supplied source or backup identity in
      // the public control schema. Until a sealed successor supplies the
      // journaled originals, it must not synthesize either one.
      case "restore.create": return Object.freeze({ status: "held" as const, reason: "SUCCESSOR_AUTHORITY_HELD" as const });
      default: return Object.freeze({ status: "held" as const, reason: "SUCCESSOR_AUTHORITY_HELD" as const });
    }
  }
  return Object.freeze({ binding, provenance, admission, telemetry, chaos, restore, dispatch });
}
