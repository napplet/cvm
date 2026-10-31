import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationReceipt, validateAuthorizationRequest } from "../release/authorization";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { CoreControlPayloadSchemas } from "../release/deployment/production-core-suite-protocol";
import { CertificationEdgePayloadSchemas, CertificationEdgeKindSchema as EdgeKindSchema, type CertificationEdgeKind } from "./certification-edge-protocol";
import { assertProductionCertificationEdgeService, type ProductionCertificationEdgeService } from "./certification-edge";
import { createWorkerBenchmarkSchedule } from "../admission/benchmark";
import { IDENTICAL_WORKER_COHORT_PROFILE } from "../certification/live/worker-ports";
import { LifecycleStageSchema } from "../telemetry/contracts";
import { D122_FAULT_MATRIX, DURABILITY_SUBJECT_KINDS } from "../resilience/fault-harness";
import { CORE_RESTORE_CHUNK_BYTES, CORE_RESTORE_MAX_BYTES } from "../release/deployment/production-core-suite-protocol";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Id = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u);
export const ProductionControlKindSchema = z.enum(["cohort.prepare", "cohort.observe", "telemetry.emit", "telemetry.window", "fault.inject", "fault.observe", "restore.prepare", "restore.inventory", "restore.lose-local", "restore.create", "restore.subject", "restore.expiry", "restore.topology", "restore.cleanup"]);
export type ProductionControlKind = z.infer<typeof ProductionControlKindSchema>;
const AnyKindSchema = z.union([ProductionControlKindSchema, EdgeKindSchema]);
const CommandSchema = z.object({ operationId: Id, kind: AnyKindSchema, payload: z.unknown(), candidateSha256: Digest, topologySha256: Digest, authorizationRequestSha256: Digest, roleCostBoundSha256: Digest.optional(), requestSha256: Digest }).strict();
const StoredSchema = z.object({ operationId: Id, kind: AnyKindSchema, requestSha256: Digest, state: z.enum(["pending", "completed", "unknown", "failed"]), result: z.unknown().optional() }).strict();
const StoredInternalSchema = StoredSchema.extend({ payload: z.unknown().optional() });
export type ProductionControlObservation = z.infer<typeof StoredSchema>;
/** Exact finite certification inventory. Restore reads are bounded by the
 * protocol's 512 MiB maximum and 128 KiB chunks; this is an upper bound from
 * the reviewed command graph, not an arbitrary request-rate threshold. */
const RESTORE_CHUNKS_PER_STREAM = Math.ceil(CORE_RESTORE_MAX_BYTES / CORE_RESTORE_CHUNK_BYTES);
/** This is the closed restore command graph, not a loose numeric budget. */
export const PRODUCTION_RESTORE_PREAMBLE = Object.freeze(["restore.prepare", "restore.inventory", "restore.lose-local", "restore.create"] as const);
export const PRODUCTION_RESTORE_SUBJECT_OPERATIONS = Object.freeze(["describe", "read-ciphertext", "read-plaintext", "decrypt", "reattach"] as const);
export const PRODUCTION_RESTORE_EPILOGUE = Object.freeze(["restore.expiry", "restore.topology", "restore.cleanup"] as const);
export const PRODUCTION_CERTIFICATION_OPERATION_LIMIT =
  (2 * createWorkerBenchmarkSchedule(IDENTICAL_WORKER_COHORT_PROFILE).length * 2)
  + (LifecycleStageSchema.options.length + 1)
  + (D122_FAULT_MATRIX.length * 2 + 1)
  + (PRODUCTION_RESTORE_PREAMBLE.length + DURABILITY_SUBJECT_KINDS.length * (RESTORE_CHUNKS_PER_STREAM * 2 + (PRODUCTION_RESTORE_SUBJECT_OPERATIONS.length - 2)) + PRODUCTION_RESTORE_EPILOGUE.length)
  + Object.keys(CertificationEdgePayloadSchemas).length;

export type { ProductionCertificationServices } from "../release/deployment/production-core-suite-protocol";
import type { ProductionCertificationServices } from "../release/deployment/production-core-suite-protocol";

async function sha256(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unresolvedModelObservation(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { status?: unknown }).status === "unknown";
}

export class ProductionCertificationControl {
  constructor(private readonly input: Readonly<{ candidateSha256: string; topologySha256: string; authorizationRequestSha256: string; authorizationRequest: unknown; authorizationReceipt: unknown; journal: PostgresOperationJournal; services: ProductionCertificationServices; edge?: ProductionCertificationEdgeService; now?: () => number }>) {
    Digest.parse(input.candidateSha256); Digest.parse(input.topologySha256); Digest.parse(input.authorizationRequestSha256); assertPostgresOperationJournal(input.journal);
    if (input.edge) assertProductionCertificationEdgeService(input.edge);
  }
  async execute(value: unknown): Promise<ProductionControlObservation> {
    await this.#authorize();
    const command = CommandSchema.parse(value);
    if (command.candidateSha256 !== this.input.candidateSha256 || command.topologySha256 !== this.input.topologySha256 || command.authorizationRequestSha256 !== this.input.authorizationRequestSha256) throw new Error("PRODUCTION_CONTROL_SCOPE_MISMATCH");
    const { requestSha256, ...unsigned } = command;
    if (requestSha256 !== await sha256(unsigned)) throw new Error("PRODUCTION_CONTROL_REQUEST_DIGEST_MISMATCH");
    const identity = requestSha256;
    const payloadSchema = (CoreControlPayloadSchemas as Readonly<Record<string, z.ZodType>>)[command.kind] ?? (CertificationEdgePayloadSchemas as Readonly<Record<string, z.ZodType>>)[command.kind];
    if (!payloadSchema) throw new Error("PRODUCTION_CONTROL_KIND_UNAVAILABLE");
    payloadSchema.parse(command.payload);
    const pending = StoredInternalSchema.parse({ operationId: command.operationId, kind: command.kind, requestSha256, state: "pending", payload: command.payload });
    const claim = await this.input.journal.claimBounded(command.operationId, identity, pending, PRODUCTION_CERTIFICATION_OPERATION_LIMIT); const prior = StoredInternalSchema.parse(claim.record.value);
    if (!claim.claimed) return this.#public(prior);
    try {
      const result = await this.#run(command);
      /* A Responses GET can be transiently unavailable after a durable response
       * ID exists. Keep that original operation reconcilable rather than
       * persisting an unknown observation as a completed receipt. */
      const terminal = StoredInternalSchema.parse(command.kind === "edge.payment.model" && unresolvedModelObservation(result)
        ? { ...pending, state: "unknown" }
        : { ...pending, state: "completed", result });
      return this.#public(StoredInternalSchema.parse((await this.input.journal.compareAndSet(command.operationId, identity, claim.record.revision, terminal))?.value ?? pending));
    } catch {
      const terminal = StoredInternalSchema.parse({ ...pending, state: "unknown" });
      return this.#public(StoredInternalSchema.parse((await this.input.journal.compareAndSet(command.operationId, identity, claim.record.revision, terminal))?.value ?? terminal));
    }
  }
  async observe(input: Readonly<{ operationId: string }>): Promise<ProductionControlObservation> {
    await this.#authorize(true);
    const record = await this.input.journal.read<unknown>(Id.parse(input.operationId));
    if (!record) throw new Error("PRODUCTION_CONTROL_ORIGINAL_REQUIRED");
    const current = StoredInternalSchema.parse(record.value);
    if ((current.state !== "pending" && current.state !== "unknown") || current.payload === undefined) return this.#public(current);
    let reconciled: unknown;
    if (current.kind in CertificationEdgePayloadSchemas) {
      if (!this.input.edge || !["edge.payment.model", "edge.publication.source", "edge.publication.submit", "edge.publication.reconcile", "edge.publication.direct.source", "edge.publication.direct.submit", "edge.publication.direct.reconcile"].includes(current.kind)) return this.#public(current);
      try { reconciled = await this.input.edge.reconcile({ operationId: current.operationId, kind: current.kind, payload: current.payload }); }
      catch { return this.#public(current); }
    } else reconciled = await this.input.services.reconcile({ operationId: current.operationId, kind: current.kind as ProductionControlKind, payload: current.payload });
    if (current.kind === "edge.payment.model" && unresolvedModelObservation(reconciled)) return this.#public(current);
    const terminal = StoredInternalSchema.parse({ ...current, state: "completed", result: reconciled });
    const saved = await this.input.journal.compareAndSet(current.operationId, current.requestSha256, record.revision, terminal);
    const latest = saved ? StoredInternalSchema.parse(saved.value) : StoredInternalSchema.parse((await this.input.journal.read<unknown>(current.operationId))?.value);
    return this.#public(latest);
  }
  async #run(command: z.infer<typeof CommandSchema>): Promise<unknown> {
    const schema = (CoreControlPayloadSchemas as Readonly<Record<string, z.ZodType>>)[command.kind]
      ?? (CertificationEdgePayloadSchemas as Readonly<Record<string, z.ZodType>>)[command.kind];
    if (!schema) throw new Error("PRODUCTION_CONTROL_KIND_UNAVAILABLE");
    const payload = schema.parse(command.payload) as Record<string, unknown>;
    if (command.kind in CertificationEdgePayloadSchemas) {
      if (!this.input.edge) throw new Error("PRODUCTION_EDGE_CONTROL_UNAVAILABLE");
      return this.input.edge.execute({ operationId: command.operationId, kind: command.kind as CertificationEdgeKind, payload });
    }
    switch (command.kind) {
      case "cohort.prepare": return this.input.services.prepareCohort({ operationId: command.operationId, candidateId: z.string().min(1).parse(payload?.candidateId), provider: z.enum(["modal", "fly"]).parse(payload?.provider), sample: z.object({ id: z.string().min(1), cohort: z.string().min(1) }).strict().parse(payload?.sample) });
      case "cohort.observe": return this.input.services.observeCohort({ operationId: command.operationId, candidateId: z.string().min(1).parse(payload?.candidateId), provider: z.enum(["modal", "fly"]).parse(payload?.provider), sample: z.object({ id: z.string().min(1), cohort: z.string().min(1) }).strict().parse(payload?.sample) });
      case "telemetry.emit": return this.input.services.emitTelemetry({ operationId: command.operationId, observation: payload?.observation });
      case "telemetry.window": return this.input.services.telemetryWindow({ operationId: command.operationId, binding: payload?.binding });
      case "fault.inject": return this.input.services.injectFault({ operationId: command.operationId, schedule: payload?.schedule });
      case "fault.observe": return this.input.services.observeFault({ operationId: z.string().min(1).parse(payload?.operationId), sessionId: z.string().min(1).parse(payload?.sessionId) });
      default: return this.input.services.restore({ operationId: command.operationId, action: z.enum(["restore.prepare", "restore.topology", "restore.inventory", "restore.lose-local", "restore.create", "restore.subject", "restore.cleanup", "restore.expiry"]).parse(command.kind), payload: command.payload });
    }
  }
  async #authorize(readOnly = false): Promise<void> {
    const request = await validateAuthorizationRequest(this.input.authorizationRequest);
    const receipt = ReleaseAuthorizationReceiptSchema.parse(this.input.authorizationReceipt);
    const now = (this.input.now ?? Date.now)();
    await validateAuthorizationReceipt({ request, receipt, nowMs: readOnly ? Math.min(now, receipt.expiresAtMs - 1) : now });
    if (request.authorizationRequestSha256 !== this.input.authorizationRequestSha256 || request.candidateSha256 !== this.input.candidateSha256 || request.topologySha256 !== this.input.topologySha256 || !request.orderedEffects.some(effect => effect.provider === "cloud_run") || !request.providerScopes.some(scope => scope.provider === "cloud_run")) throw new Error("PRODUCTION_CONTROL_AUTHORIZATION_INVALID");
  }
  #public(value: z.infer<typeof StoredInternalSchema>): ProductionControlObservation {
    const { payload: _payload, ...observation } = value;
    return StoredSchema.parse(observation);
  }
}
