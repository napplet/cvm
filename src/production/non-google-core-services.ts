import { z } from "zod";
import { CoreControlPayloadSchemas, type CoreServiceControlKind } from "../release/deployment/production-core-suite-protocol";
import { NonGoogleAdmissionCertification } from "./non-google-admission-certification";
import { NonGoogleChaosCertification } from "./non-google-chaos-certification";
import { NonGoogleFreshRestoreProvisioner } from "./non-google-fresh-restore-provisioner";
import { NonGoogleCoreJournal, NonGoogleNativeCapacity, type NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleTelemetryCertification } from "./non-google-telemetry-certification";
import { assertNonGoogleNativeCoreDriverSet, NonGoogleNativeCoreDriverSet } from "./non-google-native-core-drivers";
import { assertNonGoogleInvocationAuthority, type NonGoogleInvocationAuthority } from "./non-google-invocation-authority";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

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
  readonly #admission: NonGoogleAdmissionCertification;
  readonly #telemetry: NonGoogleTelemetryCertification;
  readonly #chaos: NonGoogleChaosCertification;
  readonly #restore: NonGoogleFreshRestoreProvisioner;
  constructor(readonly drivers: NonGoogleNativeCoreDriverSet) {
    assertNonGoogleNativeCoreDriverSet(drivers);
    this.binding = Object.freeze({ candidateSha256: drivers.candidateSha256, topologySha256: drivers.topologySha256 });
    const journal = NonGoogleCoreJournal.fromPostgres(drivers.journal);
    this.#admission = new NonGoogleAdmissionCertification({ binding: this.binding, journal, capacity: NonGoogleNativeCapacity.fromProduction(drivers.capacity) });
    this.#telemetry = new NonGoogleTelemetryCertification({ binding: this.binding, journal, collector: drivers.signoz });
    this.#chaos = new NonGoogleChaosCertification({ binding: this.binding, journal, coolify: drivers.coolify });
    this.#restore = new NonGoogleFreshRestoreProvisioner({ binding: this.binding, journal, driver: drivers.restore, postgres: drivers.postgres });
    Object.freeze(this);
  }
  readonly binding: NonGoogleCoreBinding;
  async execute(input: Readonly<{ authority: NonGoogleInvocationAuthority; requestSha256: string; operationId: string; kind: CoreServiceControlKind; payload: unknown }>): Promise<unknown> {
    assertNonGoogleInvocationAuthority(input.authority);
    this.#assertDispatch(input);
    switch (input.kind) {
      case "cohort.prepare": return this.#admission.prepare({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "cohort.observe": return this.#admission.observe({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "telemetry.emit": return this.#telemetry.emit({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "telemetry.window": return this.#telemetry.query({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "fault.inject": return this.#chaos.inject({ operationId: input.operationId, ...CoreControlPayloadSchemas[input.kind].parse(input.payload) });
      case "fault.observe": return this.#chaos.observe(CoreControlPayloadSchemas[input.kind].parse(input.payload));
      default: return this.#restore.restore({ action: input.kind, payload: CoreControlPayloadSchemas[input.kind].parse(input.payload) });
    }
  }
  /** Reconciliation is only a read/observe route over the persisted domain
   * identity. It never repeats capacity reservation, fault injection, or a
   * fresh-instance create after an ambiguous acknowledgement. */
  async reconcile(input: Readonly<{ authority: NonGoogleInvocationAuthority; requestSha256: string; operationId: string; kind: CoreServiceControlKind; payload: unknown }>): Promise<unknown> {
    assertNonGoogleInvocationAuthority(input.authority);
    input.authority.assertOriginalObservation({ scope: "production.core", effect: input.kind, candidateSha256: this.binding.candidateSha256, topologySha256: this.binding.topologySha256, requestSha256: Digest.parse(input.requestSha256), roleCostBoundSha256: this.drivers.roleCostBoundSha256, originalRecorded: await this.#originalRecorded(input.kind, input.payload) });
    switch (input.kind) {
      case "cohort.prepare":
      case "cohort.observe": return this.#admission.observe({ operationId: input.operationId, ...CoreControlPayloadSchemas["cohort.observe"].parse(input.payload) });
      case "telemetry.emit":
      case "telemetry.window": return this.#telemetry.query({ operationId: input.operationId, ...CoreControlPayloadSchemas["telemetry.window"].parse(input.payload) });
      case "fault.inject":
      case "fault.observe": return this.#chaos.observe(CoreControlPayloadSchemas["fault.observe"].parse(input.payload));
      default: return this.#restore.restore({ action: input.kind, payload: CoreControlPayloadSchemas[input.kind].parse(input.payload) });
    }
  }
  #assertDispatch(input: Readonly<{ authority: NonGoogleInvocationAuthority; requestSha256: string; kind: CoreServiceControlKind }>): void {
    input.authority.assertDispatch({ scope: "production.core", effect: input.kind, candidateSha256: this.binding.candidateSha256, topologySha256: this.binding.topologySha256, requestSha256: Digest.parse(input.requestSha256), roleCostBoundSha256: this.drivers.roleCostBoundSha256 });
  }
  async #originalRecorded(_kind: CoreServiceControlKind, _payload: unknown): Promise<boolean> {
    const operationId = this.#domainOperation(_kind, _payload);
    /* This is an exact canonical-original probe, not a broad journal search;
     * observation authority is therefore never supplied by the caller. */
    const client = await this.drivers.postgres.open();
    try { return (await (await client.connect()).query("SELECT EXISTS (SELECT 1 FROM production_real.release_operation_journal WHERE operation_id=$1) AS recorded", [`non-google-core:${operationId}`])).rows[0]?.recorded === true; }
    finally { await client.end(); }
  }
  #domainOperation(kind: CoreServiceControlKind, payload: unknown): string {
    switch (kind) {
      case "cohort.prepare": case "cohort.observe": { const value = CoreControlPayloadSchemas["cohort.observe"].parse(payload); return `admission:${value.provider}:${value.sample.id}`; }
      case "telemetry.emit": { const value = CoreControlPayloadSchemas["telemetry.emit"].parse(payload); return `telemetry:${this.binding.candidateSha256}:${this.binding.topologySha256}:stage:${value.observation.stage}`; }
      case "telemetry.window": return `telemetry:${this.binding.candidateSha256}:${this.binding.topologySha256}:stage:generation`;
      case "fault.inject": { const value = CoreControlPayloadSchemas["fault.inject"].parse(payload); return `fault:${z.object({ input: z.object({ operationId: z.string().min(1) }).strict() }).strict().parse(value.schedule).input.operationId}`; }
      case "fault.observe": { const value = CoreControlPayloadSchemas["fault.observe"].parse(payload); return `fault:${value.operationId}`; }
      case "restore.create": return `restore:${this.binding.candidateSha256}:${this.binding.topologySha256}:fresh`;
      default: return `restore:${this.binding.candidateSha256}:${this.binding.topologySha256}:prepare`;
    }
  }
}
export function assertNonGoogleNativeCoreServices(value: unknown): asserts value is NonGoogleNativeCoreServices {
  if (!(value instanceof NonGoogleNativeCoreServices)) throw new Error("NON_GOOGLE_NATIVE_CORE_SERVICES_REQUIRED");
}
export function createNonGoogleNativeCoreServices(input: Readonly<{ drivers: NonGoogleNativeCoreDriverSet }>): NonGoogleNativeCoreServices {
  return new NonGoogleNativeCoreServices(input.drivers);
}
