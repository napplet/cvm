import { createHash } from "node:crypto";
import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { CheckpointManifestSchema } from "../continuity/checkpoint-envelope";
import type { ObjectStorePort } from "../continuity/object-store";
import { DurabilitySubjectSchema, RestoreDrillInputSchema, validateDurabilityInventory } from "../resilience/fault-harness";
import { createMigrationArchive, restoreMigrationArchiveToPostgres, type MigrationArchive } from "./migration";
import { MigrationArchiveCipher, ProductionMigrationSource, writeEncryptedMigrationArchive } from "./migration-control";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { ProductionCertificationServices } from "../release/deployment/production-core-suite-protocol";
import { CoreControlPayloadSchemas, CoreFreshInstanceSchema, CoreRestoreChunkSchema, CoreRestoreDescriptorSchema, CORE_RESTORE_CHUNK_BYTES } from "../release/deployment/production-core-suite-protocol";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const Expected = RestoreDrillInputSchema.shape.expected;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export type ProductionRestoreScope = Readonly<{ checkpointId: string; sessionId: string; ownerId: string }>;
export type ProductionRetainedArchive = z.infer<typeof Expected> & Readonly<{ archive: Uint8Array }>;

/** A run-owned Cloud SQL/Cloud Run pair.  This is intentionally an execution
 * authority, rather than a descriptor supplied by the certification client. */
export type ProductionFreshRestoreInstance = Readonly<{
  freshInstanceId: string;
  sourceInstanceId: string;
  databaseInstanceId: string;
  migrationDatabaseInstanceId: string;
  applicationInstanceId: string;
  providerOperationId: string;
  /** Empty migration-verification database.  It is distinct from the
   * read-only recovered authority so compatible history is never imported
   * into a cloned real-money ledger. */
  migrationTargetPool: PostgresSqlPool;
  pool: PostgresSqlPool;
  objectStore: ObjectStorePort;
  startAfterRestore(): Promise<void>;
  openRetainedArchive(input: Readonly<{ subject: z.infer<typeof DurabilitySubjectSchema>; expected: z.infer<typeof Expected> }>): Promise<ProductionRetainedArchive>;
  reattachOriginal(input: Readonly<{ sourceIdentity: string; archive: Uint8Array; expected: z.infer<typeof Expected> }>): Promise<Readonly<{ status: "reattached" | "replayed" | "reconciliation_pending"; workerId?: string }>>;
  /** Query-only recovery for a lost reattach acknowledgement. */
  observeReattach(input: Readonly<{ sourceIdentity: string; archiveSha256: string; expected: z.infer<typeof Expected> }>): Promise<Readonly<{ status: "reattached" | "replayed" | "reconciliation_pending"; workerId?: string }>>;
  exerciseExpiryDeletion(scope: ProductionRestoreScope): Promise<Readonly<{ expired: true; deleted: true }>>;
  /** Query-only recovery for a lost retention-deletion acknowledgement. */
  observeExpiryDeletion(scope: ProductionRestoreScope): Promise<Readonly<{ expired: true; deleted: true }>>;
  observeTopology(): Promise<unknown>;
  cleanup(): Promise<Readonly<{ state: "absent" }>>;
  /** Query-only recovery for a lost fresh-resource cleanup acknowledgement. */
  observeCleanup(): Promise<Readonly<{ state: "absent" | "unknown" }>>;
}>;

/** Implemented by the mounted production infrastructure client.  The control
 * service never gets a target database, application identity, or a fake
 * result from the HTTP caller. */
export type ProductionFreshRestoreProvisioner = Readonly<{
  create(input: Readonly<{ operationId: string; sourceInstanceId: string; backupSha256: string }>): Promise<ProductionFreshRestoreInstance>;
  /** Observation-only reconstruction after a control-plane restart. It may
   * inspect the original resources but must never provision replacements. */
  attach(input: Readonly<{ freshInstanceId: string; sourceInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string }>): Promise<ProductionFreshRestoreInstance>;
  observeCleanup(input: Readonly<{ freshInstanceId: string; sourceInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string }>): Promise<Readonly<{ state: "absent" | "unknown" }>>;
}>;

type FreshRun = Readonly<{ instance: ProductionFreshRestoreInstance; backupSha256: string; scope: ProductionRestoreScope; expected: z.infer<typeof Expected>; subjects: readonly z.infer<typeof DurabilitySubjectSchema>[] }>;
type RestoreSubjectCommand = z.infer<typeof CoreControlPayloadSchemas["restore.subject"]>;
const FreshRecord = z.object({
  freshInstanceId: Identity, sourceInstanceId: Identity, databaseInstanceId: Identity, migrationDatabaseInstanceId: Identity, applicationInstanceId: Identity, providerOperationId: Identity, backupSha256: Digest,
  expected: Expected, subjects: z.array(DurabilitySubjectSchema).length(7),
}).strict();
const services = new WeakSet<object>();

export function assertProductionRestoreCertification(value: unknown): asserts value is ProductionRestoreCertification {
  if (!value || typeof value !== "object" || !services.has(value)) throw new Error("PRODUCTION_RESTORE_CERTIFICATION_REQUIRED");
}

/**
 * Server-side restore control for the seven retained D-125 subjects.  It
 * captures an encrypted immutable migration archive before making a fresh
 * instance, imports that archive into the fresh SQL authority, then lets only
 * the fresh application decrypt and reattach its original fenced work.
 */
export class ProductionRestoreCertification implements Pick<ProductionCertificationServices, "restore"> {
  readonly #sourcePool: PostgresSqlPool;
  readonly #runs = new Map<string, FreshRun>();
  readonly #local = new Map<string, readonly z.infer<typeof DurabilitySubjectSchema>[]>();
  constructor(private readonly input: Readonly<{
    sourceInstanceId: string;
    scope: ProductionRestoreScope;
    sourcePool: PostgresSqlPool;
    migrationSource: ProductionMigrationSource;
    migrationCipher: MigrationArchiveCipher;
    backupStore: ObjectStorePort;
    journal: PostgresOperationJournal;
    provisioner: ProductionFreshRestoreProvisioner;
    candidateSha256: string;
    topologySha256: string;
    now?: () => number;
  }>) {
    Identity.parse(input.sourceInstanceId); Identity.parse(input.scope.checkpointId); Identity.parse(input.scope.sessionId); Identity.parse(input.scope.ownerId);
    Digest.parse(input.candidateSha256); Digest.parse(input.topologySha256);
    if (!input.provisioner || typeof input.provisioner.create !== "function" || typeof input.provisioner.attach !== "function" || typeof input.provisioner.observeCleanup !== "function") throw new Error("PRODUCTION_FRESH_RESTORE_PROVISIONER_REQUIRED");
    this.#sourcePool = bindAccountingRealmPool(input.sourcePool, createAccountingRealm("production-real"));
    services.add(this);
  }

  async restore(input: Parameters<ProductionCertificationServices["restore"]>[0]): Promise<unknown> {
    switch (input.action) {
      case "restore.inventory": CoreControlPayloadSchemas["restore.inventory"].parse(input.payload); return this.#inventory(this.#sourcePool, this.input.scope);
      case "restore.lose-local": CoreControlPayloadSchemas["restore.lose-local"].parse(input.payload); this.#local.clear(); return Object.freeze({ status: "lost" as const });
      case "restore.create": CoreControlPayloadSchemas["restore.create"].parse(input.payload); return this.#create(input.operationId);
      case "restore.subject": return this.#subject(CoreControlPayloadSchemas["restore.subject"].parse(input.payload));
      case "restore.expiry": return this.#expiry(CoreControlPayloadSchemas["restore.expiry"].parse(input.payload).freshInstanceId);
      case "restore.topology": return this.#topology(CoreControlPayloadSchemas["restore.topology"].parse(input.payload).freshInstanceId);
      case "restore.cleanup": return this.#cleanup(CoreControlPayloadSchemas["restore.cleanup"].parse(input.payload).freshInstanceId);
    }
  }

  /** Recovery is query-only: absent process memory never authorizes another
   * clone, backup, archive write, worker restore, or cleanup operation. */
  async reconcile(input: Readonly<{ operationId: string; kind: string; payload: unknown }>): Promise<unknown> {
    if (!input.kind.startsWith("restore.")) throw new Error("PRODUCTION_RESTORE_RECONCILIATION_UNAVAILABLE");
    switch (input.kind) {
      case "restore.create": {
        CoreControlPayloadSchemas["restore.create"].parse(input.payload);
        const run = this.#runs.get(input.operationId) ?? await this.#attach(input.operationId);
        if (!run) throw new Error("PRODUCTION_RESTORE_ORIGINAL_OPERATION_REQUIRED");
        return this.#fresh(run);
      }
      case "restore.inventory": CoreControlPayloadSchemas["restore.inventory"].parse(input.payload); return this.#inventory(this.#sourcePool, this.input.scope);
      case "restore.lose-local": CoreControlPayloadSchemas["restore.lose-local"].parse(input.payload); return Object.freeze({ status: "lost" as const });
      case "restore.subject": return this.#reconcileSubject(CoreControlPayloadSchemas["restore.subject"].parse(input.payload));
      case "restore.expiry": {
        const payload = CoreControlPayloadSchemas["restore.expiry"].parse(input.payload);
        return (await this.#run(payload.freshInstanceId)).instance.observeExpiryDeletion(this.input.scope);
      }
      case "restore.topology": {
        const payload = CoreControlPayloadSchemas["restore.topology"].parse(input.payload);
        return this.#topology(payload.freshInstanceId);
      }
      case "restore.cleanup": {
        const payload = CoreControlPayloadSchemas["restore.cleanup"].parse(input.payload);
        return this.#observeCleanup(payload.freshInstanceId);
      }
      default: throw new Error("PRODUCTION_RESTORE_RECONCILIATION_UNAVAILABLE");
    }
  }

  async #inventory(pool: PostgresSqlPool, scope: ProductionRestoreScope) {
    const client = await pool.connect();
    try {
      const rows = await client.query<Record<string, unknown>>("SELECT kind,source_identity,object_key,object_generation,object_checksum,payload_sha256,owner_id,retention_until::text AS retention_until,deletion_state FROM production_real.durability_subjects WHERE checkpoint_id=$1 AND session_id=$2 AND owner_id=$3 ORDER BY kind", [scope.checkpointId, scope.sessionId, scope.ownerId]);
      const subjects = validateDurabilityInventory(rows.rows.map(row => ({ kind: row.kind, sourceIdentity: row.source_identity, object: { key: row.object_key, generation: Number(row.object_generation), checksum: row.object_checksum }, payloadSha256: row.payload_sha256, ownerId: row.owner_id, retentionUntil: new Date(String(row.retention_until)).toISOString(), deletionState: row.deletion_state })));
      this.#local.set(scope.checkpointId, subjects);
      return subjects;
    } finally { client.release(); }
  }

  async #create(operationId: string) {
    const existing = this.#runs.get(operationId);
    if (existing) return this.#fresh(existing);
    const source = await this.input.migrationSource.capture();
    const archive = await createMigrationArchive({ source, candidateSha256: this.input.candidateSha256, topologySha256: this.input.topologySha256, now: this.input.now });
    // The encrypted GCS archive is durable before a fresh SQL/application
    // pair is provisioned.  The direct archive value is used only for the
    // same in-process transactional import and never returned to the client.
    await writeEncryptedMigrationArchive(this.input.backupStore, this.input.migrationCipher, archive, this.input.journal, `restore-backup:${sha(operationId).slice(0, 24)}`);
    const instance = await this.input.provisioner.create({ operationId, sourceInstanceId: this.input.sourceInstanceId, backupSha256: archive.manifest.archiveSha256 });
    if (instance.sourceInstanceId !== this.input.sourceInstanceId || instance.freshInstanceId === this.input.sourceInstanceId || instance.databaseInstanceId === this.input.sourceInstanceId || instance.migrationDatabaseInstanceId === this.input.sourceInstanceId || instance.applicationInstanceId === this.input.sourceInstanceId) throw new Error("PRODUCTION_RESTORE_FRESH_INSTANCE_REQUIRED");
    try {
      const client = await instance.migrationTargetPool.connect();
      try { await restoreMigrationArchiveToPostgres({ archive, expectedCandidateSha256: this.input.candidateSha256, expectedTopologySha256: this.input.topologySha256, targetIdentity: instance.databaseInstanceId, client }); }
      finally { client.release(); }
      await instance.startAfterRestore();
      const freshPool = bindAccountingRealmPool(instance.pool, createAccountingRealm("production-real"));
      const subjects = await this.#inventory(freshPool, this.input.scope);
      const expected = await this.#expected(freshPool, this.input.scope);
      const persisted = FreshRecord.parse({ freshInstanceId: instance.freshInstanceId, sourceInstanceId: instance.sourceInstanceId, databaseInstanceId: instance.databaseInstanceId, migrationDatabaseInstanceId: instance.migrationDatabaseInstanceId, applicationInstanceId: instance.applicationInstanceId, providerOperationId: instance.providerOperationId, backupSha256: archive.manifest.archiveSha256, expected, subjects });
      await this.input.journal.claim(this.#freshKey(operationId), sha(JSON.stringify(persisted)), persisted);
      const run = Object.freeze({ instance, backupSha256: archive.manifest.archiveSha256, scope: this.input.scope, expected, subjects });
      this.#runs.set(operationId, run);
      return this.#fresh(run);
    } catch (error) { await instance.cleanup().catch(() => undefined); throw error; }
  }

  #fresh(run: FreshRun) {
    return CoreFreshInstanceSchema.parse({ freshInstanceId: run.instance.freshInstanceId, sourceInstanceId: this.input.sourceInstanceId, databaseInstanceId: run.instance.databaseInstanceId, applicationInstanceId: run.instance.applicationInstanceId, restoredBackupSha256: run.backupSha256 });
  }
  #freshKey(operationId: string) { return `restore-fresh:${sha(operationId).slice(0, 24)}`; }
  async #attach(operationId: string): Promise<FreshRun | undefined> {
    const record = await this.input.journal.read<unknown>(this.#freshKey(operationId));
    if (!record) return undefined;
    return this.#fromPersisted(FreshRecord.parse(record.value), operationId);
  }
  async #fromPersisted(persisted: z.infer<typeof FreshRecord>, operationId: string): Promise<FreshRun> {
    const instance = await this.input.provisioner.attach(persisted);
    if (instance.freshInstanceId !== persisted.freshInstanceId || instance.sourceInstanceId !== persisted.sourceInstanceId || instance.databaseInstanceId !== persisted.databaseInstanceId || instance.migrationDatabaseInstanceId !== persisted.migrationDatabaseInstanceId || instance.applicationInstanceId !== persisted.applicationInstanceId || instance.providerOperationId !== persisted.providerOperationId) throw new Error("PRODUCTION_RESTORE_RESOURCE_BINDING_DENIED");
    const run = Object.freeze({ instance, backupSha256: persisted.backupSha256, scope: this.input.scope, expected: persisted.expected, subjects: persisted.subjects }); this.#runs.set(operationId, run); return run;
  }
  async #run(id: string): Promise<FreshRun> {
    for (const run of this.#runs.values()) if (run.instance.freshInstanceId === id) return run;
    // All follow-up control messages address a fresh instance, not the
    // original create operation. Reconstruct only from the exact immutable
    // resource tuple written by #create; ambiguity and absence fail closed.
    const record = await this.input.journal.readUniqueByValueField<unknown>("freshInstanceId", Identity.parse(id));
    if (!record) throw new Error("PRODUCTION_RESTORE_FRESH_INSTANCE_ORIGINAL_REQUIRED");
    return this.#fromPersisted(FreshRecord.parse(record.value), record.operationId);
  }
  async #observeCleanup(freshInstanceId: string) {
    const record = await this.input.journal.readUniqueByValueField<unknown>("freshInstanceId", Identity.parse(freshInstanceId));
    if (!record) throw new Error("PRODUCTION_RESTORE_FRESH_INSTANCE_ORIGINAL_REQUIRED");
    return this.input.provisioner.observeCleanup(FreshRecord.parse(record.value));
  }

  async #expected(pool: PostgresSqlPool, scope: ProductionRestoreScope) {
    const client = await pool.connect();
    try {
      const row = (await client.query<Record<string, unknown>>("SELECT e.manifest_json,r.lease_token,trim(f.nostr_pubkey) AS owner_id FROM production_real.checkpoint_envelopes e JOIN production_real.continuation_resume_commands r ON r.checkpoint_id=e.checkpoint_id JOIN production_real.funding_accounts f ON f.account_id=e.account_id WHERE e.checkpoint_id=$1 AND e.session_id=$2 AND trim(f.nostr_pubkey)=$3 AND e.state='retained' LIMIT 2", [scope.checkpointId, scope.sessionId, scope.ownerId])).rows[0];
      if (!row) throw new Error("PRODUCTION_RESTORE_FACTS_UNAVAILABLE");
      const manifest = CheckpointManifestSchema.parse(typeof row.manifest_json === "string" ? JSON.parse(row.manifest_json) : row.manifest_json);
      if (manifest.checkpointId !== scope.checkpointId || manifest.sessionId !== scope.sessionId || row.owner_id !== scope.ownerId) throw new Error("PRODUCTION_RESTORE_FACTS_DENIED");
      return Expected.parse({ ownerId: scope.ownerId, sessionId: scope.sessionId, pendingActionReference: manifest.action.pendingActionReference, sessionVersion: manifest.sessionVersion, artifactVersion: manifest.artifactVersion, leaseToken: row.lease_token, compatibility: { policyVersion: manifest.compatibility.policyVersion, modelIdentity: manifest.compatibility.modelIdentity, nappletSdkIdentity: manifest.compatibility.nappletSdkIdentity, toolchainIdentity: manifest.compatibility.toolchainIdentity } });
    } finally { client.release(); }
  }

  async #subject(payload: RestoreSubjectCommand) {
    const run = await this.#run(payload.freshInstanceId);
    const subject = DurabilitySubjectSchema.parse(payload.subject);
    const known = run.subjects.find(item => item.kind === subject.kind && item.sourceIdentity === subject.sourceIdentity && JSON.stringify(item.object) === JSON.stringify(subject.object));
    if (!known || JSON.stringify(known) !== JSON.stringify(subject)) throw new Error("PRODUCTION_RESTORE_SUBJECT_BINDING_DENIED");
    if (payload.action === "describe") return CoreRestoreDescriptorSchema.parse({ freshInstanceId: run.instance.freshInstanceId, subject: known, expected: run.expected });
    if (payload.action === "read-ciphertext") return this.#chunk(run.instance.freshInstanceId, known.sourceIdentity, await this.#ciphertext(run, known), payload.offset);
    if (payload.action === "read-plaintext") return this.#chunk(run.instance.freshInstanceId, known.sourceIdentity, (await run.instance.openRetainedArchive({ subject: known, expected: run.expected })).archive, payload.offset);
    if (payload.action === "decrypt") {
      const bytes = await this.#ciphertext(run, known);
      if (sha(bytes) !== payload.ciphertextSha256) throw new Error("PRODUCTION_RESTORE_CIPHERTEXT_BINDING_DENIED");
      const material = await run.instance.openRetainedArchive({ subject: known, expected: run.expected });
      if (sha(material.archive) !== known.payloadSha256 || JSON.stringify({ ...material, archive: undefined }) !== JSON.stringify(run.expected)) throw new Error("PRODUCTION_RESTORE_ARCHIVE_FACTS_DENIED");
      return Object.freeze({ freshInstanceId: run.instance.freshInstanceId, sourceIdentity: known.sourceIdentity, ciphertextSha256: payload.ciphertextSha256, archiveSha256: known.payloadSha256, expected: run.expected });
    }
    if (payload.action !== "reattach") throw new Error("PRODUCTION_RESTORE_ACTION_DENIED");
    if (payload.archiveSha256 !== known.payloadSha256 || JSON.stringify(payload.expected) !== JSON.stringify(run.expected)) throw new Error("PRODUCTION_RESTORE_REATTACH_BINDING_DENIED");
    const material = await run.instance.openRetainedArchive({ subject: known, expected: run.expected });
    if (sha(material.archive) !== known.payloadSha256) throw new Error("PRODUCTION_RESTORE_ARCHIVE_FACTS_DENIED");
    return run.instance.reattachOriginal({ sourceIdentity: known.sourceIdentity, archive: material.archive, expected: run.expected });
  }
  async #reconcileSubject(payload: RestoreSubjectCommand) {
    if (payload.action !== "reattach") return this.#subject(payload);
    const run = await this.#run(payload.freshInstanceId);
    const subject = DurabilitySubjectSchema.parse(payload.subject);
    const known = run.subjects.find(item => item.kind === subject.kind && item.sourceIdentity === subject.sourceIdentity && JSON.stringify(item.object) === JSON.stringify(subject.object));
    if (!known || JSON.stringify(known) !== JSON.stringify(subject)) throw new Error("PRODUCTION_RESTORE_SUBJECT_BINDING_DENIED");
    if (payload.archiveSha256 !== known.payloadSha256 || JSON.stringify(payload.expected) !== JSON.stringify(run.expected)) throw new Error("PRODUCTION_RESTORE_REATTACH_BINDING_DENIED");
    return run.instance.observeReattach({ sourceIdentity: known.sourceIdentity, archiveSha256: known.payloadSha256, expected: run.expected });
  }
  async #ciphertext(run: FreshRun, subject: z.infer<typeof DurabilitySubjectSchema>) {
    const bytes = await run.instance.objectStore.readExact(subject.object);
    if (!bytes || sha(bytes) !== subject.object.checksum) throw new Error("PRODUCTION_RESTORE_OBJECT_DENIED");
    return bytes;
  }
  #chunk(freshInstanceId: string, sourceIdentity: string, bytes: Uint8Array, offset: number) {
    if (bytes.byteLength > 536_870_912 || offset >= bytes.byteLength || offset % CORE_RESTORE_CHUNK_BYTES !== 0) throw new Error("PRODUCTION_RESTORE_CHUNK_DENIED");
    const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + CORE_RESTORE_CHUNK_BYTES));
    return CoreRestoreChunkSchema.parse({ freshInstanceId, sourceIdentity, offset, totalBytes: bytes.byteLength, bytesBase64: Buffer.from(chunk).toString("base64") });
  }
  async #expiry(freshInstanceId: string) { return z.object({ expired: z.literal(true), deleted: z.literal(true) }).strict().parse(await (await this.#run(freshInstanceId)).instance.exerciseExpiryDeletion(this.input.scope)); }
  async #topology(freshInstanceId?: string) { const run = freshInstanceId ? await this.#run(freshInstanceId) : [...this.#runs.values()][0]; if (!run) throw new Error("PRODUCTION_RESTORE_FRESH_INSTANCE_ORIGINAL_REQUIRED"); return run.instance.observeTopology(); }
  async #cleanup(freshInstanceId: string) { const run = await this.#run(freshInstanceId); const result = await run.instance.cleanup(); if (result.state !== "absent") throw new Error("PRODUCTION_RESTORE_CLEANUP_UNCONFIRMED"); for (const [key, value] of this.#runs) if (value === run) this.#runs.delete(key); return Object.freeze({ state: "absent" as const, freshInstanceId }); }
}
