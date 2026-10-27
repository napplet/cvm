import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "../promotion/schema";
import { D122_FAULT_MATRIX, EffectOracleSchema, FaultExecutionSchema, NO_EFFECTS_ORACLE, type FaultSchedule } from "../resilience/fault-harness";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationReceipt, validateAuthorizationRequest } from "../release/authorization";
import { assertContextVmCertificationClient, type ContextVmCertificationClient } from "../release/deployment/contextvm-client";
import { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { ProductionConfig } from "./config";
import type { ProductionGenerationRuntime } from "./generation-runtime";
import { ProductionCertificationCoreServices } from "./certification-services";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const Operation = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const Recorded = z.object({
  version: z.literal(1),
  controlOperationId: z.string().min(1).max(256),
  operationId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  fault: z.enum(["duplicate", "out_of_order"]),
  childOperationIds: z.array(Operation).min(1).max(2),
  provider: z.enum(["modal", "fly"]),
  oracle: z.object({ activeWriters: z.literal(1), effects: EffectOracleSchema }).strict(),
  state: z.enum(["prepared", "observed"]),
  eventIds: z.array(z.string().regex(/^[a-f0-9]{64}$/iu)).max(2).optional(),
  deliveryOrder: z.array(z.string().regex(/^[a-f0-9]{64}$/iu)).max(2).optional(),
}).strict();

type RelayFaultRecord = z.infer<typeof Recorded>;
const RELAY_EFFECTS = Object.freeze({ ...NO_EFFECTS_ORACLE, worker: 1 });

function scheduleFor(value: unknown): FaultSchedule {
  const found = D122_FAULT_MATRIX.find(item => canonicalJson(item) === canonicalJson(value));
  if (!found || (found.faultClass !== "duplicate_relay" && found.faultClass !== "out_of_order_relay")) {
    throw new Error("PRODUCTION_RELAY_CHAOS_SCHEDULE_REQUIRED");
  }
  return found;
}

/**
 * Receipt-bound D-122 relay fault executor. It uses the mounted official
 * ContextVM client, whose SDK relay handler captures and republishes the
 * exact signed Nostr event. The chaos journal persists all child operation
 * IDs before the first network publication; a prepared record is deliberately
 * non-retryable after uncertainty.
 */
export class ProductionRelayChaosCertification {
  readonly #scope: string;
  readonly #journal: PostgresOperationJournal;
  readonly #originals: PostgresOperationJournal;

  constructor(private readonly input: Readonly<{
    config: ProductionConfig;
    generation: ProductionGenerationRuntime;
    contextvm: ContextVmCertificationClient;
    core: ProductionCertificationCoreServices;
    now?: () => number;
  }>) {
    if (input.config.realm !== "production-real"
      || input.generation.config.candidateSha256 !== input.config.candidateSha256
      || input.generation.config.topologySha256 !== input.config.topologySha256) {
      throw new Error("PRODUCTION_RELAY_CHAOS_BINDING_REQUIRED");
    }
    assertContextVmCertificationClient(input.contextvm);
    if (input.core !== input.generation.admissionObserver) throw new Error("PRODUCTION_RELAY_CHAOS_CORE_BINDING_REQUIRED");
    this.#scope = hash({
      candidateSha256: input.config.candidateSha256,
      topologySha256: input.config.topologySha256,
      authorizationRequestSha256: input.generation.authorization.authorizationRequestSha256,
    });
    const pool = bindAccountingRealmPool(input.generation.dependencies.pool, createAccountingRealm("production-real"));
    this.#journal = new PostgresOperationJournal(pool, { namespace: "production-chaos-relay", scopeSha256: this.#scope });
    this.#originals = input.generation.dependencies.journal;
  }

  async #authorize(readOnly: boolean): Promise<void> {
    const request = await validateAuthorizationRequest(this.input.generation.authorization.request);
    const receipt = ReleaseAuthorizationReceiptSchema.parse(this.input.generation.authorization.receipt);
    const now = (this.input.now ?? Date.now)();
    await validateAuthorizationReceipt({ request, receipt, nowMs: readOnly ? Math.min(now, receipt.expiresAtMs - 1) : now });
    if (request.candidateSha256 !== this.input.config.candidateSha256
      || request.topologySha256 !== this.input.config.topologySha256
      || request.authorizationRequestSha256 !== this.input.generation.authorization.authorizationRequestSha256
      || !request.providerScopes.some(scope => scope.provider === "contextvm")
      || !request.orderedEffects.some(effect => effect.provider === "contextvm")
      || !request.providerScopes.some(scope => scope.provider === this.input.config.worker.selectedProvider)
      || !request.orderedEffects.some(effect => effect.provider === this.input.config.worker.selectedProvider)) {
      throw new Error("PRODUCTION_RELAY_CHAOS_SCOPE_INVALID");
    }
  }

  async inject(input: Readonly<{ controlOperationId: string; schedule: unknown }>): Promise<Readonly<{
    operationId: string;
    sessionId: string;
    oracle: Readonly<{ activeWriters: 1; effects: typeof RELAY_EFFECTS }>;
  }>> {
    await this.#authorize(false);
    const schedule = scheduleFor(input.schedule);
    const operationId = schedule.input.operationId!;
    const sessionId = schedule.initialState.sessionId!;
    const fault = schedule.faultClass === "duplicate_relay" ? "duplicate" as const : "out_of_order" as const;
    const provider = this.input.config.worker.selectedProvider;
    const admissionOperationId = Operation.parse(`relay_${hash({ scope: this.#scope, operationId, sessionId, fault, admission: true }).slice(0, 56)}`);
    const childOperationIds = Object.freeze(fault === "duplicate"
      ? [admissionOperationId]
      : [admissionOperationId, Operation.parse(`relay_${hash({ scope: this.#scope, operationId, sessionId, fault, status: true }).slice(0, 56)}`)]);
    const prepared = Recorded.parse({ version: 1, controlOperationId: input.controlOperationId, operationId, sessionId, fault, childOperationIds, provider, state: "prepared", oracle: { activeWriters: 1, effects: RELAY_EFFECTS } });
    const identity = hash({ schedule, controlOperationId: input.controlOperationId, scope: this.#scope });
    const claim = await this.#journal.claimBounded(operationId, identity, prepared, 2);
    if (!claim.claimed) {
      if (claim.record.value.controlOperationId !== input.controlOperationId) throw new Error("PRODUCTION_RELAY_CHAOS_CONTROL_ORIGINAL_MISMATCH");
      await this.observe({ operationId, sessionId });
      return Object.freeze({ operationId, sessionId, oracle: Object.freeze({ activeWriters: 1, effects: RELAY_EFFECTS }) });
    }
    await this.#authorize(false);
    const faultClass = schedule.faultClass === "duplicate_relay" ? "duplicate_relay" as const : "out_of_order_relay" as const;
    const preparedCohort = await this.input.core.prepareRelayFault({ operationId: admissionOperationId, candidateId: this.input.config.candidateSha256, provider, faultClass });
    const result = await this.input.contextvm.exerciseRelayDeliveryFault({
      fault,
      first: { operationId: childOperationIds[0], candidateId: this.input.config.candidateSha256, requestedCap: preparedCohort.requestedCap },
      ...(fault === "out_of_order" ? { second: { operationId: childOperationIds[1], candidateId: this.input.config.candidateSha256 } } : {}),
    });
    if (canonicalJson(result.operationIds) !== canonicalJson(childOperationIds) || result.fault !== fault) {
      throw new Error("PRODUCTION_RELAY_CHAOS_TRANSPORT_BINDING_INVALID");
    }
    const observed = Recorded.parse({ ...prepared, state: "observed", eventIds: result.eventIds, deliveryOrder: result.deliveryOrder });
    if (!await this.#journal.compareAndSet(operationId, identity, claim.record.revision, observed)) {
      throw new Error("PRODUCTION_RELAY_CHAOS_OBSERVATION_COMMIT_UNCERTAIN");
    }
    const cleaned = await this.input.core.observeRelayFault({ operationId: admissionOperationId }) as Readonly<{ sample?: Readonly<{ outcome?: unknown; cleanup?: unknown; readyLeaseCount?: unknown }> }>;
    if (cleaned.sample?.outcome !== "accepted" || cleaned.sample.cleanup !== "passed" || cleaned.sample.readyLeaseCount !== 1) throw new Error("PRODUCTION_RELAY_CHAOS_COHORT_CLEANUP_REQUIRED");
    return Object.freeze({ operationId, sessionId, oracle: Object.freeze({ activeWriters: 1, effects: RELAY_EFFECTS }) });
  }

  async observe(input: Readonly<{ operationId: string; sessionId: string }>) {
    await this.#authorize(true);
    const record = Recorded.parse((await this.#journal.read<RelayFaultRecord>(input.operationId))?.value);
    if (record.state !== "observed" || record.sessionId !== input.sessionId || !record.eventIds || !record.deliveryOrder) {
      throw new Error("PRODUCTION_RELAY_CHAOS_ORIGINAL_UNRESOLVED");
    }
    if (canonicalJson(record.oracle) !== canonicalJson({ activeWriters: 1, effects: RELAY_EFFECTS }) || record.provider !== this.input.config.worker.selectedProvider) throw new Error("PRODUCTION_RELAY_CHAOS_ORACLE_CHANGED");
    if (record.fault === "duplicate") {
      if (record.childOperationIds.length !== 1 || record.eventIds.length !== 1 || canonicalJson(record.deliveryOrder) !== canonicalJson([record.eventIds[0], record.eventIds[0]])) {
        throw new Error("PRODUCTION_RELAY_CHAOS_DELIVERY_INVALID");
      }
    } else if (record.childOperationIds.length !== 2 || record.eventIds.length !== 2 || canonicalJson(record.deliveryOrder) !== canonicalJson([record.eventIds[1], record.eventIds[0]])) {
      throw new Error("PRODUCTION_RELAY_CHAOS_DELIVERY_INVALID");
    }
    const admissionOperationId = record.childOperationIds[0]!;
    {
      const original = await this.#originals.read<{ operationId?: unknown; state?: unknown; admissionReference?: unknown; outcome?: unknown }>(`contextvm-admission:${admissionOperationId}`);
      if (!original || original.value.operationId !== admissionOperationId || original.value.state !== "responded" || typeof original.value.admissionReference !== "string" || original.value.outcome !== "accepted") {
        throw new Error("PRODUCTION_RELAY_CHAOS_CLIENT_ORIGINAL_UNRESOLVED");
      }
    }
    if (record.fault === "out_of_order") {
      const status = await this.#originals.read<{ operationId?: unknown; state?: unknown }>(`contextvm-relay-status:${record.childOperationIds[1]}`);
      if (!status || status.value.operationId !== record.childOperationIds[1] || !["responded", "method_unavailable"].includes(String(status.value.state))) throw new Error("PRODUCTION_RELAY_CHAOS_STATUS_ORIGINAL_UNRESOLVED");
    }
    const cohort = await this.input.core.reconcileRelayFault({ operationId: admissionOperationId });
    if (!cohort || cohort.outcome !== "accepted" || cohort.cleanup !== "passed" || cohort.readyLeaseCount !== 1 || cohort.durableBacklogCount !== 0) throw new Error("PRODUCTION_RELAY_CHAOS_COHORT_ORIGINAL_UNRESOLVED");
    return FaultExecutionSchema.parse({
      operationId: record.operationId,
      sessionId: record.sessionId,
      observed: record.fault === "duplicate" ? "duplicate" : "out_of_order",
      activeWriters: cohort.readyLeaseCount,
      // One admission creates then releases one owned worker/hold. The
      // reordered ping is signed but read-only; it cannot dispatch a model.
      effects: { ...NO_EFFECTS_ORACLE, worker: cohort.readyLeaseCount },
    });
  }

  async reconcile(input: Readonly<{ controlOperationId: string; schedule: unknown }>) {
    const schedule = scheduleFor(input.schedule);
    const operationId = schedule.input.operationId!; const sessionId = schedule.initialState.sessionId!;
    await this.observe({ operationId, sessionId });
    const record = Recorded.parse((await this.#journal.read(operationId))?.value);
    if (record.controlOperationId !== input.controlOperationId) throw new Error("PRODUCTION_RELAY_CHAOS_CONTROL_ORIGINAL_MISMATCH");
    return Object.freeze({ operationId, sessionId, oracle: record.oracle });
  }
}
