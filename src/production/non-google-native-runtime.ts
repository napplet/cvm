import { createHash } from "node:crypto";
import { z } from "zod";
import type { LifecycleTelemetryPort } from "../telemetry/contracts";
import type { ImmutableObjectReference } from "../continuity/object-store";
import { DurabilitySubjectSchema, RestoreDrillInputSchema } from "../resilience/fault-harness";
import { assertPostgresOperationJournal, type OperationRecord, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { assertProductionReadyCapacity, type ProductionReadyCapacityPort } from "./worker-capacity";
import type { ProductionFreshRestoreInstance } from "./restore-certification";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type NonGoogleCoreBinding = Readonly<{ candidateSha256: string; topologySha256: string }>;
export type NonGoogleJournalRecord<T = unknown> = OperationRecord<T>;

/** A bounded operation journal that uses an actual restricted PostgreSQL journal
 * in production. The in-memory implementation is exported solely for focused
 * mechanism tests and is never a release-evidence source. */
export class NonGoogleCoreJournal {
  readonly #postgres?: PostgresOperationJournal;
  readonly #entries?: Map<string, NonGoogleJournalRecord>;
  private constructor(postgres?: PostgresOperationJournal, entries?: Map<string, NonGoogleJournalRecord>) {
    this.#postgres = postgres; this.#entries = entries; Object.freeze(this);
  }
  static fromPostgres(journal: PostgresOperationJournal): NonGoogleCoreJournal {
    assertPostgresOperationJournal(journal);
    return new NonGoogleCoreJournal(journal);
  }
  static forTest(): NonGoogleCoreJournal { return new NonGoogleCoreJournal(undefined, new Map()); }
  #key(operationId: string) { return `non-google-core:${Identity.parse(operationId)}`; }
  async claim<T>(operationId: string, identitySha256: string, value: T): Promise<Readonly<{ claimed: boolean; record: NonGoogleJournalRecord<T> }>> {
    const key = this.#key(operationId); Digest.parse(identitySha256);
    if (this.#postgres) return this.#postgres.claim(key, identitySha256, value);
    const entries = this.#entries!; const prior = entries.get(key) as NonGoogleJournalRecord<T> | undefined;
    if (prior) {
      if (prior.identitySha256 !== identitySha256) throw new Error("NON_GOOGLE_CORE_ORIGINAL_IDENTITY_CONFLICT");
      return Object.freeze({ claimed: false, record: prior });
    }
    const record = Object.freeze({ operationId: key, identitySha256, revision: 1, value: structuredClone(value) });
    entries.set(key, record); return Object.freeze({ claimed: true, record });
  }
  async read<T>(operationId: string): Promise<NonGoogleJournalRecord<T> | undefined> {
    const key = this.#key(operationId);
    return this.#postgres ? this.#postgres.read<T>(key) : this.#entries!.get(key) as NonGoogleJournalRecord<T> | undefined;
  }
  async replace<T>(operationId: string, identitySha256: string, revision: number, value: T): Promise<NonGoogleJournalRecord<T> | undefined> {
    const key = this.#key(operationId); Digest.parse(identitySha256);
    if (this.#postgres) return this.#postgres.compareAndSet(key, identitySha256, revision, value);
    const prior = this.#entries!.get(key) as NonGoogleJournalRecord<T> | undefined;
    if (!prior || prior.identitySha256 !== identitySha256 || prior.revision !== revision) return undefined;
    const record = Object.freeze({ operationId: key, identitySha256, revision: revision + 1, value: structuredClone(value) });
    this.#entries!.set(key, record); return record;
  }
}

export class NonGoogleNativeCapacity {
  private constructor(readonly port: Pick<ProductionReadyCapacityPort, "reserveNow" | "observe">) { Object.freeze(this); }
  static fromProduction(port: ProductionReadyCapacityPort): NonGoogleNativeCapacity { assertProductionReadyCapacity(port); return new NonGoogleNativeCapacity(port); }
  static forTest(port: Pick<ProductionReadyCapacityPort, "reserveNow" | "observe">): NonGoogleNativeCapacity { return new NonGoogleNativeCapacity(port); }
  async reserve(input: Readonly<{ intentReference: string; expectedSessionBindingDigest: string }>) {
    return this.port.reserveNow(input);
  }
  async observe(input: Readonly<{ intentReference: string; expectedSessionBindingDigest: string; reference?: string }>) {
    return this.port.observe(input);
  }
}

export class NonGoogleAuthenticatedTelemetryProducer {
  constructor(readonly telemetry: LifecycleTelemetryPort) {
    if (!telemetry || typeof telemetry.observe !== "function") throw new Error("NON_GOOGLE_TELEMETRY_PRODUCER_REQUIRED");
    Object.freeze(this);
  }
  async emit(observation: Parameters<LifecycleTelemetryPort["observe"]>[0]): Promise<void> { await this.telemetry.observe(observation); }
}

/** Production composition accepts only the project-owned PostgreSQL journal,
 * ready-capacity implementation, safe lifecycle exporter and fixed low-level
 * transports. It performs no client, credential, network or resource effect. */
export function createNonGoogleNativeCoreMaterial(input: Readonly<{
  journal: PostgresOperationJournal;
  capacity: ProductionReadyCapacityPort;
  telemetry: LifecycleTelemetryPort;
  chaos: NonGoogleChaosEffectPort;
  restore: NonGoogleFreshRestorePort;
}>): NonGoogleNativeCoreMaterial {
  return new NonGoogleNativeCoreMaterial({
    journal: NonGoogleCoreJournal.fromPostgres(input.journal),
    capacity: NonGoogleNativeCapacity.fromProduction(input.capacity),
    telemetry: new NonGoogleAuthenticatedTelemetryProducer(input.telemetry),
    chaos: new NonGoogleChaosTransport(input.chaos),
    restore: new NonGoogleFreshRestoreTransport(input.restore),
  });
}

export type NonGoogleChaosEffectPort = Readonly<{
  injectOriginal(input: Readonly<{ operationId: string; sessionId: string; schedule: unknown; binding: NonGoogleCoreBinding }>): Promise<Readonly<{ status: "applied" | "pending" | "blocked"; operationId: string; sessionId: string }>>;
  observeOriginal(input: Readonly<{ operationId: string; sessionId: string; binding: NonGoogleCoreBinding }>): Promise<Readonly<{ status: "observed" | "pending" | "missing" | "blocked"; operationId: string; sessionId: string }>>;
}>;
const chaosPorts = new WeakSet<object>();
/** Fixed project-owned transport wrapper; it never accepts a caller result. */
export class NonGoogleChaosTransport {
  constructor(private readonly port: NonGoogleChaosEffectPort) {
    if (!port || typeof port.injectOriginal !== "function" || typeof port.observeOriginal !== "function") throw new Error("NON_GOOGLE_CHAOS_TRANSPORT_REQUIRED");
    chaosPorts.add(this); Object.freeze(this);
  }
  async injectOriginal(input: Parameters<NonGoogleChaosEffectPort["injectOriginal"]>[0]) { return this.port.injectOriginal(input); }
  async observeOriginal(input: Parameters<NonGoogleChaosEffectPort["observeOriginal"]>[0]) { return this.port.observeOriginal(input); }
}
export function assertNonGoogleChaosTransport(value: unknown): asserts value is NonGoogleChaosTransport {
  if (!value || typeof value !== "object" || !chaosPorts.has(value)) throw new Error("NON_GOOGLE_CHAOS_TRANSPORT_REQUIRED");
}

export type NonGoogleFreshRestorePort = Readonly<{
  planOriginal(input: Readonly<{ operationId: string; sourceInstanceId: string; backupSha256: string; binding: NonGoogleCoreBinding }>): Readonly<{ freshInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string }>;
  prepareOriginal(input: Readonly<{ operationId: string; binding: NonGoogleCoreBinding }>): Promise<Readonly<{ sourceInstanceId: string; backupSha256: string; scope: Readonly<{ checkpointId: string; sessionId: string; ownerId: string }>; expected: z.infer<typeof RestoreDrillInputSchema>["expected"]; subjects: readonly z.infer<typeof DurabilitySubjectSchema>[] }>>;
  importOriginal(input: Readonly<{ operationId: string; backupSha256: string; instance: ProductionFreshRestoreInstance; binding: NonGoogleCoreBinding }>): Promise<Readonly<{ status: "imported"; backupSha256: string }>>;
  createOriginal(input: Readonly<{ operationId: string; sourceInstanceId: string; backupSha256: string; binding: NonGoogleCoreBinding }>): Promise<ProductionFreshRestoreInstance>;
  attachOriginal(input: Readonly<{ freshInstanceId: string; sourceInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string; binding: NonGoogleCoreBinding }>): Promise<ProductionFreshRestoreInstance>;
  observeCleanup(input: Readonly<{ freshInstanceId: string; sourceInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string; binding: NonGoogleCoreBinding }>): Promise<Readonly<{ state: "absent" | "unknown" }>>;
}>;
const restorePorts = new WeakSet<object>();
/** The low-level provisioner is deliberately distinct from historical Google
 * controls: its source IDs are persisted before any create and it only exposes
 * exact fresh-instance observation/cleanup. */
export class NonGoogleFreshRestoreTransport {
  constructor(private readonly port: NonGoogleFreshRestorePort) {
    if (!port || typeof port.planOriginal !== "function" || typeof port.prepareOriginal !== "function" || typeof port.importOriginal !== "function" || typeof port.createOriginal !== "function" || typeof port.attachOriginal !== "function" || typeof port.observeCleanup !== "function") throw new Error("NON_GOOGLE_FRESH_RESTORE_TRANSPORT_REQUIRED");
    restorePorts.add(this); Object.freeze(this);
  }
  planOriginal(input: Parameters<NonGoogleFreshRestorePort["planOriginal"]>[0]) { return this.port.planOriginal(input); }
  async prepareOriginal(input: Parameters<NonGoogleFreshRestorePort["prepareOriginal"]>[0]) { return this.port.prepareOriginal(input); }
  async importOriginal(input: Parameters<NonGoogleFreshRestorePort["importOriginal"]>[0]) { return this.port.importOriginal(input); }
  async createOriginal(input: Parameters<NonGoogleFreshRestorePort["createOriginal"]>[0]) { return this.port.createOriginal(input); }
  async attachOriginal(input: Parameters<NonGoogleFreshRestorePort["attachOriginal"]>[0]) { return this.port.attachOriginal(input); }
  async observeCleanup(input: Parameters<NonGoogleFreshRestorePort["observeCleanup"]>[0]) { return this.port.observeCleanup(input); }
}
export function assertNonGoogleFreshRestoreTransport(value: unknown): asserts value is NonGoogleFreshRestoreTransport {
  if (!value || typeof value !== "object" || !restorePorts.has(value)) throw new Error("NON_GOOGLE_FRESH_RESTORE_TRANSPORT_REQUIRED");
}

const materials = new WeakSet<object>();
export class NonGoogleNativeCoreMaterial {
  constructor(readonly input: Readonly<{ journal: NonGoogleCoreJournal; capacity: NonGoogleNativeCapacity; telemetry: NonGoogleAuthenticatedTelemetryProducer; chaos: NonGoogleChaosTransport; restore: NonGoogleFreshRestoreTransport }>) {
    if (!(input.journal instanceof NonGoogleCoreJournal) || !(input.capacity instanceof NonGoogleNativeCapacity) || !(input.telemetry instanceof NonGoogleAuthenticatedTelemetryProducer)) throw new Error("NON_GOOGLE_CORE_NATIVE_MATERIAL_REQUIRED");
    assertNonGoogleChaosTransport(input.chaos); assertNonGoogleFreshRestoreTransport(input.restore);
    materials.add(this); Object.freeze(this);
  }
}
export function assertNonGoogleNativeCoreMaterial(value: unknown): asserts value is NonGoogleNativeCoreMaterial {
  if (!value || typeof value !== "object" || !materials.has(value)) throw new Error("NON_GOOGLE_CORE_NATIVE_MATERIAL_REQUIRED");
}

/** Deterministic test-only native mechanism wiring. It proves service control
 * flow, never topology, provider, or release evidence. */
export function createNonGoogleCoreTestMaterial(input: Readonly<{
  onCapacity(value: Readonly<{ intentReference: string; expectedSessionBindingDigest: string }>): Awaited<ReturnType<ProductionReadyCapacityPort["reserveNow"]>>;
  onFault(value: Readonly<{ operationId: string; sessionId: string }>): Readonly<{ status: "applied"; operationId: string; sessionId: string }>;
  onRestore(value: Readonly<{ operationId: string; sourceInstanceId: string; backupSha256: string }>): Readonly<{ operationId: string; sourceInstanceId: string; backupSha256: string }>;
}>): NonGoogleNativeCoreMaterial {
  const capacity = NonGoogleNativeCapacity.forTest({
    async reserveNow(value) { return input.onCapacity(value); }, async observe(value) { return input.onCapacity(value); },
  });
  const telemetry = new NonGoogleAuthenticatedTelemetryProducer({ async observe() {} });
  const chaos = new NonGoogleChaosTransport({
    async injectOriginal(value) { return input.onFault(value); },
    async observeOriginal(value) { return Object.freeze({ status: "observed" as const, operationId: value.operationId, sessionId: value.sessionId }); },
  });
  const restore = new NonGoogleFreshRestoreTransport({
    planOriginal(value) { const suffix = hash(value.operationId).slice(0, 20); return Object.freeze({ freshInstanceId: `fresh-${suffix}`, databaseInstanceId: `db-${suffix}`, migrationDatabaseInstanceId: `verify-${suffix}`, applicationInstanceId: `app-${suffix}`, providerOperationId: `operation-${suffix}` }); },
    async prepareOriginal(value) {
      const suffix = hash(value.operationId).slice(0, 20);
      const kinds = ["checkpoint", "sealed_artifact", "validation_evidence", "usage_receipt", "promotion_evidence", "owner_event", "attestation"] as const;
      return Object.freeze({ sourceInstanceId: `source-${suffix}`, backupSha256: "a".repeat(64), scope: { checkpointId: `checkpoint-${suffix}`, sessionId: "session:one", ownerId: "owner:one" }, expected: { ownerId: "owner:one", sessionId: "session:one", pendingActionReference: "action:one", sessionVersion: 1, artifactVersion: 1, leaseToken: "lease:one", compatibility: { policyVersion: "policy:v1", modelIdentity: "model:v1", nappletSdkIdentity: "sdk:v1", toolchainIdentity: "toolchain:v1" } }, subjects: kinds.map(kind => Object.freeze({ kind, sourceIdentity: `${kind}:source-${suffix}`, object: { key: `source/${suffix}/${kind}`, generation: 1, checksum: "c".repeat(64) }, payloadSha256: "d".repeat(64), ownerId: "owner:one", retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained" as const })) });
    },
    async importOriginal(value) { return Object.freeze({ status: "imported" as const, backupSha256: value.backupSha256 }); },
    async createOriginal(value) {
      input.onRestore(value);
      const suffix = hash(value.operationId).slice(0, 20);
      const object: ImmutableObjectReference = { key: `restore/${suffix}`, generation: 1, checksum: value.backupSha256 };
      const unavailable = async (): Promise<never> => { throw new Error("NON_GOOGLE_TEST_RESTORE_UNAVAILABLE"); };
      return Object.freeze({ freshInstanceId: `fresh-${suffix}`, sourceInstanceId: value.sourceInstanceId, databaseInstanceId: `db-${suffix}`, migrationDatabaseInstanceId: `verify-${suffix}`, applicationInstanceId: `app-${suffix}`, providerOperationId: `operation-${suffix}`, pool: { connect: unavailable }, migrationTargetPool: { connect: unavailable }, objectStore: { createImmutable: unavailable, observeExactByKey: unavailable, readExact: unavailable, scheduleExactDeletion: unavailable }, startAfterRestore: async () => {}, openRetainedArchive: unavailable, reattachOriginal: unavailable, observeReattach: unavailable, exerciseExpiryDeletion: unavailable, observeExpiryDeletion: unavailable, observeTopology: unavailable, cleanup: async () => ({ state: "absent" as const }), observeCleanup: async () => ({ state: "absent" as const }) });
    },
    async attachOriginal() { throw new Error("NON_GOOGLE_TEST_ATTACH_NOT_USED"); },
    async observeCleanup() { return Object.freeze({ state: "absent" as const }); },
  });
  return new NonGoogleNativeCoreMaterial({ journal: NonGoogleCoreJournal.forTest(), capacity, telemetry, chaos, restore });
}
