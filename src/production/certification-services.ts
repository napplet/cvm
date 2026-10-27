import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import type { ContextVmTransportPort, ContextVmInboundEnvelope } from "../contextvm/sdk-bridge";
import type { ReadyCapacityPort } from "../funding/funded-admission";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { WorkerBenchmarkSampleSchema, type WorkerBenchmarkSample } from "../admission/benchmark";
import { CoreControlPayloadSchemas } from "../release/deployment/production-core-suite-protocol";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { assertProductionReadyCapacity, type ProductionReadyCapacityPort } from "./worker-capacity";
import { ProductionUnusedAdmissionRelease } from "./unused-admission";
import type { ProductionCertificationServices } from "../release/deployment/production-core-suite-protocol";
import { ProductionRestoreCertification, assertProductionRestoreCertification } from "./restore-certification";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Arguments = z.object({ idempotencyKey: z.string(), requestedCap: z.string(), unit: z.literal("sat") }).strict();
type Prepare = Parameters<ProductionCertificationServices["prepareCohort"]>[0];
type RelayFault = Readonly<{ operationId: string; candidateId: string; provider: "modal" | "fly"; faultClass: "duplicate_relay" | "out_of_order_relay" }>;
type Cohort = Readonly<{
  authorizationRequestSha256: string;
  candidateId: string; provider: "modal" | "fly"; sample: Prepare["sample"];
  clientOperationId: string; accountId: string; intentReference: string; binding: string;
  state: "preparing" | "prepared" | "received" | "observed" | "cleaning" | "complete";
  requestEventId?: string; receiptMonotonicMs?: number; coordinatorId?: string;
  observation?: z.infer<typeof WorkerBenchmarkSampleSchema>; admissionReference?: string;
}>;
const observers = new WeakSet<object>();
export function assertProductionAdmissionObserver(value: unknown): asserts value is ProductionCertificationCoreServices {
  if (!value || typeof value !== "object" || !observers.has(value)) throw new Error("PRODUCTION_ADMISSION_OBSERVER_REQUIRED");
}

/** Signed admission and its exact worker share one coordinator clock. SQL
 * supplies lease/backlog facts; the immutable worker probe supplies isolation.
 * Unsupported fault cohorts cannot be relabeled ordinary admission attempts. */
export class ProductionCertificationCoreServices implements Pick<ProductionCertificationServices, "prepareCohort" | "observeCohort" | "restore" | "reconcile"> {
  readonly #pool: PostgresSqlPool;
  readonly #coordinatorId = randomUUID();
  readonly #release: ProductionUnusedAdmissionRelease;
  constructor(private readonly input: Readonly<{
    candidates: Readonly<Record<"modal" | "fly", string>>;
    certificationOwnerPubkey: string; requestedCap: string;
    authorizationRequestSha256: string;
    capacities: Readonly<Record<"modal" | "fly", ProductionReadyCapacityPort>>;
    selectedProvider: "modal" | "fly";
    journal: PostgresOperationJournal; pool: PostgresSqlPool;
    /** The restore authority is constructed from mounted SQL/GCS/KEK/worker
     * material by the server bootstrap. It is never supplied by a control
     * payload or the session-material client graph. */
    restore?: ProductionRestoreCertification;
  }>) {
    Digest.parse(input.candidates.modal); Digest.parse(input.candidates.fly); Digest.parse(input.certificationOwnerPubkey);
    Digest.parse(input.authorizationRequestSha256);
    z.literal("1").parse(input.requestedCap); assertPostgresOperationJournal(input.journal);
    assertProductionReadyCapacity(input.capacities.modal); assertProductionReadyCapacity(input.capacities.fly);
    if (input.restore) assertProductionRestoreCertification(input.restore);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#release = new ProductionUnusedAdmissionRelease(input.pool); observers.add(this);
  }
  #operation(input: Prepare) {
    const { operationId: _operationId, ...payload } = input;
    const parsed = CoreControlPayloadSchemas["cohort.prepare"].parse(payload);
    if (parsed.candidateId !== this.input.candidates[parsed.provider]) throw new Error("PRODUCTION_COHORT_CANDIDATE_MISMATCH");
    return `admission-${parsed.provider}-${parsed.sample.id}`;
  }
  #key(operationId: string) { return `cohort-operation:${operationId}`; }
  async #load(operationId: string) {
    const record = await this.input.journal.read<Cohort>(this.#key(operationId));
    if (record && (record.value.authorizationRequestSha256 !== this.input.authorizationRequestSha256 || record.value.candidateId !== this.input.candidates[record.value.provider])) throw new Error("PRODUCTION_COHORT_AUTHORIZATION_BINDING_CHANGED");
    return record;
  }
  async prepareCohort(input: Prepare): Promise<Readonly<{ requestedCap: string }>> {
    const operation = this.#operation(input);
    if (!["pool_hit", "pool_miss", "cold", "ambiguity", "cleanup"].includes(input.sample.cohort)) throw new Error("PRODUCTION_COHORT_FAULT_PREPARATION_REQUIRED");
    const accountId = await accountIdForPrincipal({ pubkey: this.input.certificationOwnerPubkey });
    const command = { principal: { pubkey: this.input.certificationOwnerPubkey }, idempotencyKey: operation, policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: this.input.requestedCap, unit: "sat" } };
    const intentReference = `capacity-intent:${hash(`${accountId}:${operation}`)}`;
    const binding = `sha256:${hash(`admission-session-binding:${JSON.stringify(command)}`)}`;
    const base = { authorizationRequestSha256: this.input.authorizationRequestSha256, candidateId: input.candidateId, provider: input.provider, sample: input.sample, clientOperationId: operation, accountId, intentReference, binding };
    const identity = hash(JSON.stringify(base));
    const claim = await this.input.journal.claim<Cohort>(this.#key(operation), identity, { ...base, state: "preparing" });
    if (!claim.claimed) {
      if (claim.record.value.state === "preparing") throw new Error("PRODUCTION_COHORT_ORIGINAL_PREPARATION_PENDING");
      return Object.freeze({ requestedCap: this.input.requestedCap });
    }
    await this.input.journal.claim(`cohort-route:${hash(intentReference)}`, identity, { operation, provider: input.provider, binding });
    const capacity = this.input.capacities[input.provider];
    if (input.sample.cohort === "pool_hit") {
      const ready = await capacity.prewarm({ intentReference, expectedSessionBindingDigest: binding });
      if (ready.status !== "available") throw new Error("PRODUCTION_COHORT_PREWARM_NOT_READY");
    } else if (await capacity.inspect({ intentReference })) throw new Error("PRODUCTION_COHORT_COLD_WORKER_ALREADY_EXISTS");
    if (!await this.input.journal.compareAndSet<Cohort>(this.#key(operation), identity, claim.record.revision, { ...base, state: "prepared" })) throw new Error("PRODUCTION_COHORT_PREPARATION_CONFLICT");
    return Object.freeze({ requestedCap: this.input.requestedCap });
  }
  /** Internal-only relay certification cohort. Unlike the SLO sample route it
   * accepts no HTTP label and uses a fixed fault-bound operation ID. It still
   * registers the actual capacity route before the SDK receives admission. */
  async prepareRelayFault(input: RelayFault): Promise<Readonly<{ requestedCap: string }>> {
    const operation = z.string().regex(/^relay_[a-f0-9]{56}$/u).parse(input.operationId);
    if (input.candidateId !== this.input.candidates[input.provider]) throw new Error("PRODUCTION_RELAY_COHORT_CANDIDATE_MISMATCH");
    const sample = WorkerBenchmarkSampleSchema.pick({ id: true, cohort: true }).parse({ id: `relay-fault-${input.faultClass}-${operation.slice(-12)}`, cohort: "pool_hit" });
    const accountId = await accountIdForPrincipal({ pubkey: this.input.certificationOwnerPubkey });
    const command = { principal: { pubkey: this.input.certificationOwnerPubkey }, idempotencyKey: operation, policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: this.input.requestedCap, unit: "sat" } };
    const intentReference = `capacity-intent:${hash(`${accountId}:${operation}`)}`;
    const binding = `sha256:${hash(`admission-session-binding:${JSON.stringify(command)}`)}`;
    const base = { authorizationRequestSha256: this.input.authorizationRequestSha256, candidateId: input.candidateId, provider: input.provider, sample, clientOperationId: operation, accountId, intentReference, binding };
    const identity = hash(JSON.stringify(base));
    const claim = await this.input.journal.claim<Cohort>(this.#key(operation), identity, { ...base, state: "preparing" });
    if (!claim.claimed) {
      if (claim.record.value.state === "preparing") throw new Error("PRODUCTION_RELAY_COHORT_ORIGINAL_PREPARATION_PENDING");
      return Object.freeze({ requestedCap: this.input.requestedCap });
    }
    await this.input.journal.claim(`cohort-route:${hash(intentReference)}`, identity, { operation, provider: input.provider, binding });
    const capacity = this.input.capacities[input.provider];
    const ready = await capacity.prewarm({ intentReference, expectedSessionBindingDigest: binding });
    if (ready.status !== "available") throw new Error("PRODUCTION_RELAY_COHORT_PREWARM_NOT_READY");
    if (!await this.input.journal.compareAndSet<Cohort>(this.#key(operation), identity, claim.record.revision, { ...base, state: "prepared" })) throw new Error("PRODUCTION_RELAY_COHORT_PREPARATION_CONFLICT");
    return Object.freeze({ requestedCap: this.input.requestedCap });
  }
  /** Installed before the durable SDK journal: receipt latency includes SQL. */
  wrap(source: ContextVmTransportPort): ContextVmTransportPort {
    const wrapped = Object.freeze<ContextVmTransportPort>({
      onInbound: handler => source.onInbound(async envelope => {
        const receiptMonotonicMs = Math.floor(performance.now());
        const operation = await this.#match(envelope);
        if (operation) {
          const record = (await this.#load(operation))!;
          if (record.value.state === "prepared") {
            const saved = await this.input.journal.compareAndSet<Cohort>(this.#key(operation), record.identitySha256, record.revision, { ...record.value, state: "received", requestEventId: envelope.requestEventId, receiptMonotonicMs, coordinatorId: this.#coordinatorId });
            if (!saved) throw new Error("PRODUCTION_COHORT_RECEIPT_CONFLICT");
            await this.input.journal.claim(`cohort-event:${envelope.requestEventId}`, record.identitySha256, { operation });
          } else if (record.value.requestEventId !== envelope.requestEventId) throw new Error("PRODUCTION_COHORT_REPLACEMENT_EVENT_DENIED");
        }
        await handler(envelope);
      }),
      configureAnnouncement: announcement => source.configureAnnouncement(announcement),
      canonicalInvocation: (pubkey, method, params) => source.canonicalInvocation(pubkey, method, params),
      sendNotification: (pubkey, notification, eventId) => source.sendNotification(pubkey, notification, eventId),
      sendResponse: async (pubkey, response, eventId) => {
        const event = await this.input.journal.read<{ operation: string }>(`cohort-event:${eventId}`);
        if (event && pubkey === this.input.certificationOwnerPubkey) await this.#capture(event.value.operation, response.result);
        await source.sendResponse(pubkey, response, eventId);
      },
    });
    return wrapped;
  }
  async #match(envelope: ContextVmInboundEnvelope): Promise<string | undefined> {
    if (envelope.verifiedClientPubkey !== this.input.certificationOwnerPubkey) return;
    const params = z.object({ name: z.literal("funded_admission"), arguments: Arguments }).passthrough().safeParse(envelope.request.params);
    if (!params.success) return;
    const record = await this.#load(params.data.arguments.idempotencyKey);
    if (!record) return;
    if (params.data.arguments.requestedCap !== this.input.requestedCap) throw new Error("PRODUCTION_COHORT_CAP_CHANGED");
    return params.data.arguments.idempotencyKey;
  }
  /** Registered hashes select their provider; ordinary work uses selected provider. */
  capacityRouter(): ReadyCapacityPort {
    const route = async (value: { intentReference: string; expectedSessionBindingDigest?: string }) => {
      const record = await this.input.journal.read<{ operation: string; provider: "modal" | "fly"; binding: string }>(`cohort-route:${hash(value.intentReference)}`);
      if (record && value.expectedSessionBindingDigest !== undefined && record.value.binding !== value.expectedSessionBindingDigest) throw new Error("PRODUCTION_COHORT_WORKER_BINDING_CHANGED");
      const cohort = record ? await this.#load(record.value.operation) : undefined;
      return { capacity: this.input.capacities[record?.value.provider ?? this.input.selectedProvider], cohort };
    };
    const router = Object.freeze<ReadyCapacityPort>({
      reserveNow: async value => {
        const { capacity, cohort } = await route(value);
        const observed = await capacity.reserveNow(value);
        if (cohort?.value.sample.cohort === "ambiguity" && observed.status === "available") {
          // Lose the actual successful provider response at the capacity
          // boundary, after preserving the original identity. Funding must
          // recover it through observe(), never another reserve/create.
          const original = { operation: cohort.value.clientOperationId, intentReference: value.intentReference, reference: observed.reference, state: "dropped" as const };
          const claim = await this.input.journal.claim(`cohort-ambiguity:${hash(value.intentReference)}`, cohort.identitySha256, original);
          if (!claim.claimed) throw new Error("PRODUCTION_COHORT_AMBIGUITY_ALREADY_DISPATCHED");
          throw new Error("PRODUCTION_COHORT_CAPACITY_ACK_LOST");
        }
        return observed;
      },
      observe: async value => {
        const { capacity, cohort } = await route(value);
        const observed = await capacity.observe(value);
        if (cohort?.value.sample.cohort === "ambiguity" && observed.status === "available") {
          const key = `cohort-ambiguity:${hash(value.intentReference)}`;
          const dropped = await this.input.journal.read<{ operation: string; intentReference: string; reference: string; state: "dropped" | "recovered" }>(key);
          if (!dropped || dropped.identitySha256 !== cohort.identitySha256 || dropped.value.operation !== cohort.value.clientOperationId || dropped.value.intentReference !== value.intentReference || dropped.value.reference !== observed.reference) throw new Error("PRODUCTION_COHORT_AMBIGUITY_ORIGINAL_REQUIRED");
          if (dropped.value.state === "dropped" && !await this.input.journal.compareAndSet(key, dropped.identitySha256, dropped.revision, { ...dropped.value, state: "recovered" })) throw new Error("PRODUCTION_COHORT_AMBIGUITY_RECOVERY_PENDING");
        }
        return observed;
      },
      release: async value => (await route(value)).capacity.release(value),
    });
    return router;
  }
  async #capture(operation: string, response: unknown): Promise<void> {
    const responseMonotonicMs = Math.floor(performance.now());
    const record = await this.#load(operation);
    if (!record || ["observed", "cleaning", "complete"].includes(record.value.state)) return;
    const cohort = record.value;
    if (cohort.state !== "received" || cohort.coordinatorId !== this.#coordinatorId || cohort.receiptMonotonicMs === undefined) throw new Error("PRODUCTION_COHORT_RECEIPT_UNAVAILABLE");
    const wire = z.object({ status: z.enum(["accepted", "capacity_unavailable", "reconciliation_pending"]), admissionReference: z.string().min(1), unit: z.literal("sat") }).passthrough().parse(response);
    const capacity = await this.input.capacities[cohort.provider].inspect({ intentReference: cohort.intentReference });
    const client = await this.#pool.connect();
    let readyLeaseCount: number, durableBacklogCount: number;
    try {
      const observed = (await client.query("SELECT (SELECT count(*) FROM production_real.admissions a JOIN production_real.capacity_intents c ON c.account_id=a.account_id AND c.capacity_reference=a.capacity_reference WHERE a.account_id=$1 AND a.reference=$2 AND a.state='accepted' AND c.state='available' AND c.intent_reference=$3)::int AS ready_count, (SELECT count(*) FROM production_real.admissions a JOIN production_real.session_cap_holds h ON h.account_id=a.account_id AND h.reference=a.reference WHERE a.state='accepted' AND h.state='active' AND NOT EXISTS(SELECT 1 FROM production_real.capacity_intents c WHERE c.account_id=a.account_id AND c.capacity_reference=a.capacity_reference AND c.state='available'))::int AS backlog_count", [cohort.accountId, wire.admissionReference, cohort.intentReference])).rows[0];
      if (!observed) throw new Error("PRODUCTION_COHORT_LEDGER_OBSERVATION_REQUIRED");
      readyLeaseCount = Number(observed.ready_count); durableBacklogCount = Number(observed.backlog_count);
    } finally { client.release(); }
    const accepted = wire.status === "accepted";
    if (accepted && (!capacity?.readiness || capacity.reference !== wire.admissionReference || capacity.expectedSessionBindingDigest !== cohort.binding || capacity.readiness.readyMonotonicMs < cohort.receiptMonotonicMs || (cohort.sample.cohort === "pool_hit") !== (capacity.prewarmed === true))) throw new Error("PRODUCTION_COHORT_EXACT_READY_REQUIRED");
    if (accepted && cohort.sample.cohort === "ambiguity") {
      const fault = await this.input.journal.read<{ reference: string; state: string }>(`cohort-ambiguity:${hash(cohort.intentReference)}`);
      if (fault?.identitySha256 !== record.identitySha256 || fault.value.reference !== wire.admissionReference || fault.value.state !== "recovered") throw new Error("PRODUCTION_COHORT_AMBIGUITY_NOT_OBSERVED");
    }
    // Acceptance includes the final SQL cap hold and any original-response
    // reconciliation. The first ready probe alone can precede both, so it
    // cannot be used to understate receipt-to-usable-acceptance latency.
    const observation = WorkerBenchmarkSampleSchema.parse({ ...cohort.sample, outcome: accepted ? "accepted" : wire.status === "capacity_unavailable" ? "capacity_unavailable" : "ambiguous", receiptMonotonicMs: cohort.receiptMonotonicMs, readyMonotonicMs: accepted ? Math.max(responseMonotonicMs, capacity!.readiness!.readyMonotonicMs) : null, readyLeaseCount, durableBacklogCount, isolation: accepted ? "passed" : "not_observed", cleanup: "not_observed" });
    if (!await this.input.journal.compareAndSet<Cohort>(this.#key(operation), record.identitySha256, record.revision, { ...cohort, state: "observed", observation, admissionReference: wire.admissionReference })) throw new Error("PRODUCTION_COHORT_OBSERVATION_CONFLICT");
  }
  async observeCohort(input: Prepare): Promise<unknown> { return this.#observe(this.#operation(input)); }
  async observeRelayFault(input: Readonly<{ operationId: string }>): Promise<unknown> {
    const operation = z.string().regex(/^relay_[a-f0-9]{56}$/u).parse(input.operationId);
    return this.#observe(operation);
  }
  async #observe(operation: string): Promise<unknown> {
    const record = await this.#load(operation);
    if (!record || !record.value.observation || !record.value.requestEventId || !record.value.admissionReference) throw new Error("PRODUCTION_COHORT_ORIGINAL_OBSERVATION_REQUIRED");
    let cohort = record.value;
    if (cohort.state !== "complete") {
      if (cohort.observation!.outcome !== "accepted") throw new Error("PRODUCTION_COHORT_NON_ACCEPTED_CLEANUP_REQUIRED");
      /* A process can lose the provider termination acknowledgement after the
       * SQL release committed.  Keep the original cleaning record and retry
       * only idempotent/query-only recovery paths; capacity termination owns
       * its separate durable destructive claim. */
      const cleaning = cohort.state === "cleaning"
        ? record
        : await this.input.journal.compareAndSet<Cohort>(this.#key(operation), record.identitySha256, record.revision, { ...cohort, state: "cleaning" });
      if (!cleaning) throw new Error("PRODUCTION_COHORT_CLEANUP_PENDING");
      const cleanupFaultKey = `cohort-cleanup-fault:${hash(cohort.intentReference)}`;
      const cleanupFault = cohort.sample.cohort === "cleanup"
        ? await this.input.journal.claim(cleanupFaultKey, record.identitySha256, { reference: cohort.admissionReference!, state: "armed" })
        : undefined;
      if (cleanupFault && !cleanupFault.claimed) {
        await this.#reconcileCleanup(operation);
        return this.#project((await this.#load(operation))!.value);
      }
      // SQL fences new actions before terminating this entirely unused worker.
      const releaseInput = { accountId: cohort.accountId, admissionReference: cohort.admissionReference!, intentReference: cohort.intentReference };
      if (!await this.#release.observe(releaseInput)) await this.#release.release(releaseInput);
      await this.input.capacities[cohort.provider].release({ intentReference: cohort.intentReference, reference: cohort.admissionReference! });
      if (cleanupFault) {
        if (!await this.input.journal.compareAndSet(cleanupFaultKey, record.identitySha256, cleanupFault.record.revision, { reference: cohort.admissionReference!, state: "dropped" })) throw new Error("PRODUCTION_COHORT_CLEANUP_FAULT_PENDING");
        // Discard the actual termination acknowledgement before completing
        // this control command. Only original read-only recovery can finish.
        throw new Error("PRODUCTION_COHORT_CLEANUP_ACK_LOST");
      }
      const next: Cohort = { ...cohort, state: "complete", observation: { ...cohort.observation!, cleanup: "passed" } };
      const saved = await this.input.journal.compareAndSet<Cohort>(this.#key(operation), record.identitySha256, cleaning.revision, next);
      if (!saved) throw new Error("PRODUCTION_COHORT_CLEANUP_CONFLICT"); cohort = saved.value;
    }
    return this.#project(cohort);
  }
  /** Internal HTTP admission lookup is derived only from the durable cohort
   * original.  It cannot trigger admission, readiness, release, or cleanup. */
  async observeAdmissionOperation(input: Readonly<{ operationId: string }>): Promise<WorkerBenchmarkSample | undefined> {
    const operation = z.string().regex(/^(?:admission-(?:modal|fly)-[a-zA-Z0-9._:-]{1,192}|relay_[a-f0-9]{56})$/u).parse(input.operationId);
    const record = await this.#load(operation);
    return record?.value.observation;
  }
  /** Query-only provider recovery after a release/termination acknowledgement
   * is lost. An unstarted cleanup remains unresolved; this cannot release a
   * hold or issue a worker deletion. Only the completion projection is saved. */
  async reconcileRelayFault(input: Readonly<{ operationId: string }>): Promise<WorkerBenchmarkSample> {
    const operation = z.string().regex(/^relay_[a-f0-9]{56}$/u).parse(input.operationId);
    return this.#reconcileCleanup(operation);
  }
  async #reconcileCleanup(operation: string): Promise<WorkerBenchmarkSample> {
    const record = await this.#load(operation);
    if (!record?.value.observation || !record.value.admissionReference) throw new Error("PRODUCTION_RELAY_COHORT_ORIGINAL_REQUIRED");
    const cohort = record.value;
    if (cohort.state === "complete") return cohort.observation!;
    if (cohort.state !== "cleaning" || !await this.#release.observe({ accountId: cohort.accountId, admissionReference: cohort.admissionReference!, intentReference: cohort.intentReference })) throw new Error("PRODUCTION_RELAY_COHORT_CLEANUP_PENDING");
    const cleanup = await this.input.capacities[cohort.provider].observeRelease({ intentReference: cohort.intentReference, reference: cohort.admissionReference! });
    if (cleanup.status !== "terminated") throw new Error("PRODUCTION_RELAY_COHORT_CLEANUP_PENDING");
    if (cohort.sample.cohort === "cleanup") {
      const key = `cohort-cleanup-fault:${hash(cohort.intentReference)}`;
      const fault = await this.input.journal.read<{ reference: string; state: string }>(key);
      if (!fault || fault.identitySha256 !== record.identitySha256 || fault.value.reference !== cohort.admissionReference || !["dropped", "recovered"].includes(fault.value.state)) throw new Error("PRODUCTION_COHORT_CLEANUP_FAULT_PENDING");
      if (fault.value.state === "dropped" && !await this.input.journal.compareAndSet(key, fault.identitySha256, fault.revision, { ...fault.value, state: "recovered" })) throw new Error("PRODUCTION_COHORT_CLEANUP_FAULT_PENDING");
    }
    const observation = WorkerBenchmarkSampleSchema.parse({ ...cohort.observation, cleanup: "passed" });
    const saved = await this.input.journal.compareAndSet<Cohort>(this.#key(operation), record.identitySha256, record.revision, { ...cohort, state: "complete", observation });
    if (saved) return observation;
    const current = await this.#load(operation);
    if (current?.value.state !== "complete" || !current.value.observation) throw new Error("PRODUCTION_RELAY_COHORT_CLEANUP_PENDING");
    return current.value.observation;
  }
  #project(cohort: Cohort) { return Object.freeze({ candidateId: cohort.candidateId, provider: cohort.provider, sample: cohort.observation, correlation: { clientOperationId: cohort.clientOperationId, admissionReference: cohort.admissionReference, requestEventId: cohort.requestEventId } }); }
  async restore(input: Parameters<ProductionCertificationServices["restore"]>[0]): Promise<unknown> {
    if (!this.input.restore) throw new Error("PRODUCTION_RESTORE_CERTIFICATION_REQUIRED");
    return this.input.restore.restore(input);
  }
  async reconcile(input: Parameters<ProductionCertificationServices["reconcile"]>[0]): Promise<unknown> {
    if (input.kind.startsWith("restore.")) {
      if (!this.input.restore) throw new Error("PRODUCTION_RESTORE_CERTIFICATION_REQUIRED");
      return this.input.restore.reconcile(input);
    }
    if (input.kind !== "cohort.prepare" && input.kind !== "cohort.observe") throw new Error("PRODUCTION_CORE_RECONCILIATION_UNAVAILABLE");
    const payload = CoreControlPayloadSchemas[input.kind].parse(input.payload);
    const operation = this.#operation({ operationId: input.operationId, ...payload });
    const record = await this.#load(operation);
    if (input.kind === "cohort.prepare" && record && record.value.state !== "preparing") return Object.freeze({ requestedCap: this.input.requestedCap });
    if (input.kind === "cohort.observe" && record && ["cleaning", "complete"].includes(record.value.state)) {
      await this.#reconcileCleanup(operation);
      return this.#project((await this.#load(operation))!.value);
    }
    throw new Error("PRODUCTION_COHORT_ORIGINAL_OPERATION_PENDING");
  }
}
