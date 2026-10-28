import { createHash } from "node:crypto";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { ContinuationDeadlineReconciler, type DeadlineCandidate, type RetentionCandidate } from "../continuity/deadline-reconciler";
import { ContinuationService } from "../continuity/continuation-service";
import type { ResumeCompatibility } from "../continuity/contracts";
import type { ReadyCapacityPort } from "../funding/funded-admission";
import type { ContinuationFundingStore } from "../persistence/funding-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { ProductionCheckpointCoordinator, assertProductionCheckpointCoordinator } from "./checkpoint-coordinator";
import { ProductionInitialPendingCheckpoint } from "./initial-pending-checkpoint";
import { ProductionWorkerBridge } from "./worker-bridge";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const frozen = <T>(value: T): T => Object.freeze(value);

/** Production-only lifecycle composition. It creates no queue: SQL candidates
 * are already-paused sessions and every worker action remains an original,
 * lease-bound operation through the real bridge. */
export class ProductionContinuationCoordinator {
  readonly service: ContinuationService;
  readonly deadlines: ContinuationDeadlineReconciler;
  readonly initialPending: ProductionInitialPendingCheckpoint;
  readonly #pool: PostgresSqlPool;
  constructor(private readonly input: Readonly<{
    pool: PostgresSqlPool;
    store: ContinuationFundingStore;
    capacity: ReadyCapacityPort;
    worker: ProductionWorkerBridge;
    checkpoint: ProductionCheckpointCoordinator;
    compatibility: ResumeCompatibility;
    now?: () => number;
  }>) {
    assertProductionCheckpointCoordinator(input.checkpoint);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    const now = input.now ?? Date.now;
    this.initialPending = new ProductionInitialPendingCheckpoint({ pool: input.pool, checkpoint: input.checkpoint, capacity: input.capacity, commands: input.checkpoint.pendingCommands, now });
    this.deadlines = new ContinuationDeadlineReconciler({
      initialPending: this.initialPending,
      store: input.store, worker: input.worker, envelope: input.checkpoint,
      retention: { destroyExpired: value => input.checkpoint.destroyExpired(value) },
      clock: { nowMs: now }, candidates: {
        listDue: value => this.#due(value), listRetentionDue: value => this.#retention(value),
      },
    });
    this.service = new ContinuationService({
      store: input.store, clock: { nowMs: now }, includeAdmissionHold: true, pendingCommands: input.checkpoint.pendingCommands,
      resume: {
        compatibility: input.compatibility,
        checkpoint: {
          loadExact: value => input.checkpoint.loadExact(value),
          restore: material => input.checkpoint.restore({ checkpointId: material.manifest.checkpointId, accountId: material.manifest.accountId, sessionId: material.manifest.sessionId }),
        },
        allocate: value => this.#allocate(value),
      },
    });
  }

  async scan(): Promise<Readonly<{ deadline: readonly unknown[]; retention: readonly unknown[]; capacityReleases: readonly unknown[] }>> {
    return frozen({ deadline: await this.deadlines.scan(), capacityReleases: await this.initialPending.reconcileReleases(), retention: await this.deadlines.scanRetention() });
  }
  async resumeSession(input: unknown) { return this.service.resumeSession(input); }

  async #due(nowMs: number): Promise<readonly DeadlineCandidate[]> {
    const client = await this.#pool.connect();
    try {
      const rows = await client.query<Record<string, unknown>>("SELECT account_id,session_id,pause_generation,live_lease_token FROM continuation_pauses WHERE state IN ('needs_top_up','checkpointing') AND live_lease_token IS NOT NULL AND grace_deadline_ms <= $1 ORDER BY grace_deadline_ms,session_id,pause_generation LIMIT 100", [nowMs]);
      return frozen(rows.rows.map(row => frozen({ accountId: String(row.account_id), sessionId: String(row.session_id), pauseGeneration: Number(row.pause_generation), liveLeaseToken: String(row.live_lease_token) })));
    } finally { client.release(); }
  }
  async #retention(nowMs: number): Promise<readonly RetentionCandidate[]> {
    const client = await this.#pool.connect();
    try {
      const rows = await client.query<Record<string, unknown>>("SELECT account_id,session_id,pause_generation,checkpoint_id FROM continuation_checkpoints WHERE state='resume_required' AND retention_deadline_ms <= $1 ORDER BY retention_deadline_ms,checkpoint_id LIMIT 100", [nowMs]);
      return frozen(rows.rows.map(row => frozen({ accountId: String(row.account_id), sessionId: String(row.session_id), pauseGeneration: Number(row.pause_generation), checkpointId: String(row.checkpoint_id) })));
    } finally { client.release(); }
  }
  async #allocate(input: Readonly<{ accountId: string; sessionId: string; checkpointId: string; leaseToken: string; allocationIntentReference: string; actionId: string; expectedVersion: number; policyVersion: string; workspaceId: string; sourceActionId: string; payloadKind?: "pending_command" }>) {
    const capacityIntentReference = `capacity-intent:${sha({ checkpointId: input.checkpointId, allocation: input.allocationIntentReference })}`;
    const fingerprint = sha({ accountId: input.accountId, sessionId: input.sessionId, checkpointId: input.checkpointId, actionId: input.actionId, capacityIntentReference });
    const binding = `sha256:${sha({ accountId: input.accountId, sessionId: input.sessionId, actionId: input.actionId, expectedVersion: input.expectedVersion, leaseToken: input.leaseToken })}`;
    let intent = await this.input.store.transact(input.accountId, async tx => {
      const existing = await tx.findCapacityIntent(input.allocationIntentReference);
      return existing ?? tx.createCapacityIntent({ accountId: input.accountId, idempotencyKey: input.allocationIntentReference, fingerprint, intentReference: capacityIntentReference });
    });
    let observation;
    if (intent.state === "available") observation = await this.input.capacity.observe({ intentReference: capacityIntentReference, expectedSessionBindingDigest: binding, reference: intent.capacityReference });
    else if (intent.state === "created") {
      const claim = await this.input.store.transact(input.accountId, tx => tx.claimCapacityDispatch(capacityIntentReference));
      observation = claim.claimed ? await this.input.capacity.reserveNow({ intentReference: capacityIntentReference, expectedSessionBindingDigest: binding }) : await this.input.capacity.observe({ intentReference: capacityIntentReference, expectedSessionBindingDigest: binding, reference: claim.intent.capacityReference });
    } else observation = await this.input.capacity.observe({ intentReference: capacityIntentReference, expectedSessionBindingDigest: binding, reference: intent.capacityReference });
    if (observation.status !== "available") {
      const reference = "reference" in observation ? observation.reference : undefined;
      await this.input.store.transact(input.accountId, tx => tx.recordCapacityObservation({ intentReference: capacityIntentReference, state: observation.status === "refused" ? "refused" : "reconciliation_pending", ...(reference ? { capacityReference: reference } : {}) }));
      return frozen({ status: observation.status === "refused" ? "refused" as const : "unknown" as const });
    }
    intent = await this.input.store.transact(input.accountId, tx => tx.recordCapacityObservation({ intentReference: capacityIntentReference, state: "available", capacityReference: observation.reference, expiresAt: observation.expiresAt }));
    const client = await this.#pool.connect();
    try {
      const linked = await client.query<Record<string, unknown>>("INSERT INTO continuation_worker_allocations(checkpoint_id,account_id,session_id,action_id,allocation_intent_reference,capacity_intent_reference,capacity_reference,state) VALUES($1,$2,$3,$4,$5,$6,$7,'available') ON CONFLICT(checkpoint_id) DO NOTHING RETURNING checkpoint_id", [input.checkpointId, input.accountId, input.sessionId, input.actionId, input.allocationIntentReference, capacityIntentReference, observation.reference]);
      if (!linked.rows.length) {
        const existing = (await client.query<Record<string, unknown>>("SELECT account_id,session_id,action_id,allocation_intent_reference,capacity_intent_reference,capacity_reference,state FROM continuation_worker_allocations WHERE checkpoint_id=$1", [input.checkpointId])).rows[0];
        if (!existing || existing.account_id !== input.accountId || existing.session_id !== input.sessionId || existing.action_id !== input.actionId || existing.allocation_intent_reference !== input.allocationIntentReference || existing.capacity_intent_reference !== capacityIntentReference || existing.capacity_reference !== observation.reference || existing.state !== "available") return frozen({ status: "unknown" as const });
      }
    } finally { client.release(); }
    try {
      if (input.payloadKind !== "pending_command") await this.input.worker.registerContinuationRequest({ accountId: input.accountId, sessionId: input.sessionId, sourceActionId: input.sourceActionId, actionId: input.actionId, expectedVersion: input.expectedVersion, policyVersion: input.policyVersion, workspaceId: input.workspaceId });
      return frozen({ status: "allocated" as const, worker: this.input.worker });
    } catch { return frozen({ status: "unknown" as const }); }
  }
}
