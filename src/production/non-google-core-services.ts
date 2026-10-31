import { z } from "zod";
import { CoreControlPayloadSchemas, type CoreServiceControlKind } from "../release/deployment/production-core-suite-protocol";
import { NonGoogleAdmissionCertification } from "./non-google-admission-certification";
import { NonGoogleChaosCertification } from "./non-google-chaos-certification";
import { NonGoogleFreshRestoreProvisioner } from "./non-google-fresh-restore-provisioner";
import { assertNonGoogleNativeCoreMaterial, type NonGoogleCoreBinding, NonGoogleNativeCoreMaterial } from "./non-google-native-runtime";
import { NonGoogleTelemetryCertification } from "./non-google-telemetry-certification";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const suites = new WeakSet<object>();

/** Concrete Plan-68 component graph. Construction is I/O-free; it only seals
 * controller-owned PostgreSQL/capacity/collector/fault/restore implementations.
 * Plan 70 remains responsible for validating the successor authority before it
 * exposes this graph to the normal exact-eight execution path. */
export class NonGoogleNativeCoreServices {
  readonly provenance = Object.freeze({
    admission: Object.freeze({ module: "src/production/non-google-admission-certification.ts", export: "NonGoogleAdmissionCertification", purpose: "scheduled_sample_capacity_original" }),
    telemetry: Object.freeze({ module: "src/production/non-google-telemetry-certification.ts", export: "NonGoogleTelemetryCertification", purpose: "authenticated_candidate_topology_window" }),
    chaos: Object.freeze({ module: "src/production/non-google-chaos-certification.ts", export: "NonGoogleChaosCertification", purpose: "d122_original_operation_transport" }),
    restore: Object.freeze({ module: "src/production/non-google-fresh-restore-provisioner.ts", export: "NonGoogleFreshRestoreProvisioner", purpose: "fresh_postgres_object_key_application_restore" }),
  });
  readonly admission: NonGoogleAdmissionCertification;
  readonly telemetry: NonGoogleTelemetryCertification;
  readonly chaos: NonGoogleChaosCertification;
  readonly restore: NonGoogleFreshRestoreProvisioner;
  constructor(readonly binding: NonGoogleCoreBinding, readonly material: NonGoogleNativeCoreMaterial) {
    assertNonGoogleNativeCoreMaterial(material);
    Digest.parse(binding.candidateSha256); Digest.parse(binding.topologySha256);
    this.admission = new NonGoogleAdmissionCertification({ binding, journal: material.input.journal, capacity: material.input.capacity });
    this.telemetry = new NonGoogleTelemetryCertification({ binding, journal: material.input.journal, collector: material.input.telemetry });
    this.chaos = new NonGoogleChaosCertification({ binding, journal: material.input.journal, transport: material.input.chaos });
    this.restore = new NonGoogleFreshRestoreProvisioner({ binding, journal: material.input.journal, transport: material.input.restore });
    suites.add(this); Object.freeze(this);
  }
  async execute(input: Readonly<{ operationId: string; kind: CoreServiceControlKind; payload: unknown }>): Promise<unknown> {
    switch (input.kind) {
      case "cohort.prepare": return this.admission.prepare({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "cohort.observe": return this.admission.observe({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "telemetry.emit": return this.telemetry.emit({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "telemetry.window": return this.telemetry.query({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "fault.inject": return this.chaos.inject({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "fault.observe": return this.chaos.observe(CoreControlPayloadSchemas[input.kind].parse(input.payload));
      default: return this.restore.restore({ operationId: input.operationId, action: input.kind, payload: CoreControlPayloadSchemas[input.kind].parse(input.payload) });
    }
  }
  async dispatch(input: Readonly<{ operationId: string; kind: CoreServiceControlKind; payload: unknown }>): Promise<unknown> { return this.execute(input); }
  /** Reconciliation is only a read/observe route over the persisted domain
   * identity. It never repeats capacity reservation, fault injection, or a
   * fresh-instance create after an ambiguous acknowledgement. */
  async reconcile(input: Readonly<{ operationId: string; kind: CoreServiceControlKind; payload: unknown }>): Promise<unknown> {
    switch (input.kind) {
      case "cohort.prepare":
      case "cohort.observe": return this.admission.observe({ operationId: input.operationId, ...CoreControlPayloadSchemas["cohort.observe"].parse(input.payload) });
      case "telemetry.emit":
      case "telemetry.window": return this.telemetry.query({ operationId: input.operationId, ...CoreControlPayloadSchemas["telemetry.window"].parse(input.payload) });
      case "fault.inject":
      case "fault.observe": return this.chaos.observe(CoreControlPayloadSchemas["fault.observe"].parse(input.payload));
      default: return this.restore.restore({ operationId: input.operationId, action: input.kind, payload: CoreControlPayloadSchemas[input.kind].parse(input.payload) });
    }
  }
}
export function assertNonGoogleNativeCoreServices(value: unknown): asserts value is NonGoogleNativeCoreServices {
  if (!value || typeof value !== "object" || !suites.has(value)) throw new Error("NON_GOOGLE_NATIVE_CORE_SERVICES_REQUIRED");
}

export function createNonGoogleNativeCoreServices(input: Readonly<{ candidateSha256: string; topologySha256: string; material: NonGoogleNativeCoreMaterial }>): NonGoogleNativeCoreServices {
  return new NonGoogleNativeCoreServices(Object.freeze({ candidateSha256: Digest.parse(input.candidateSha256), topologySha256: Digest.parse(input.topologySha256) }), input.material);
}
