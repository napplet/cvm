import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreControlPayloadSchemas, CoreFreshInstanceSchema, CoreRestoreChunkSchema, CoreRestoreDescriptorSchema, CORE_RESTORE_CHUNK_BYTES } from "../release/deployment/production-core-suite-protocol";
import { DurabilitySubjectSchema, validateDurabilityInventory, RestoreDrillInputSchema } from "../resilience/fault-harness";
import type { ProductionFreshRestoreInstance } from "./restore-certification";
import type { NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleCoreJournal, NonGoogleFreshRestoreTransport } from "./non-google-native-runtime";

const hash = (value: Uint8Array | unknown) => createHash("sha256").update(value instanceof Uint8Array ? value : JSON.stringify(value)).digest("hex");
const Identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
type Expected = z.infer<typeof RestoreDrillInputSchema>["expected"];
type PrepareIntent = Readonly<{ version: 1; binding: NonGoogleCoreBinding; operationId: string; controlOperationId: string; state: "claimed" }>;
type Preparation = Readonly<{ version: 1; binding: NonGoogleCoreBinding; operationId: string; controlOperationId: string; sourceInstanceId: string; backupSha256: string; scope: Readonly<{ checkpointId: string; sessionId: string; ownerId: string }>; expected: Expected; subjects: readonly z.infer<typeof DurabilitySubjectSchema>[]; state: "prepared" }>;
type Fresh = Readonly<Omit<Preparation, "state"> & { freshInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string; state: "creating" | "created" }>;

/** Real fresh-instance control path. Original metadata is journaled before the
 * low-level provisioner is invoked; every later action resolves that exact
 * source/object/key/application tuple rather than accepting a caller report. */
export class NonGoogleFreshRestoreProvisioner {
  readonly #instances = new Map<string, ProductionFreshRestoreInstance>();
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal: NonGoogleCoreJournal; transport: NonGoogleFreshRestoreTransport }>) { Object.freeze(this); }
  #operation() { return `restore:${this.input.binding.candidateSha256}:${this.input.binding.topologySha256}`; }
  #prepareKey() { return `${this.#operation()}:prepare`; }
  #freshKey() { return `${this.#operation()}:fresh`; }
  async prepare(controlOperationId: string) {
    const operationId = this.#operation();
    const intent: PrepareIntent = Object.freeze({ version: 1, binding: this.input.binding, operationId, controlOperationId: Identity.parse(controlOperationId), state: "claimed" });
    const claim = await this.input.journal.claim<PrepareIntent | Preparation>(this.#prepareKey(), hash(intent), intent);
    if (!claim.claimed) {
      if (claim.record.value.state === "prepared") return Object.freeze({ status: "prepared" as const, operationId });
      throw new Error("NON_GOOGLE_RESTORE_PREPARATION_PENDING");
    }
    const prepared = await this.input.transport.prepareOriginal({ operationId, binding: this.input.binding });
    const scope = Object.freeze({ checkpointId: Identity.parse(prepared.scope.checkpointId), sessionId: Identity.parse(prepared.scope.sessionId), ownerId: Identity.parse(prepared.scope.ownerId) });
    if (scope.sessionId !== prepared.expected.sessionId || scope.ownerId !== prepared.expected.ownerId) throw new Error("NON_GOOGLE_RESTORE_SCOPE_BINDING_DENIED");
    const original: Preparation = Object.freeze({ ...intent, sourceInstanceId: Identity.parse(prepared.sourceInstanceId), backupSha256: z.string().regex(/^[a-f0-9]{64}$/u).parse(prepared.backupSha256), scope, expected: prepared.expected, subjects: validateDurabilityInventory(prepared.subjects), state: "prepared" });
    if (!await this.input.journal.replace(this.#prepareKey(), claim.record.identitySha256, claim.record.revision, original)) throw new Error("NON_GOOGLE_RESTORE_PREPARATION_CONFLICT");
    return Object.freeze({ status: "prepared" as const, operationId });
  }
  async create(controlOperationId: string): Promise<z.infer<typeof CoreFreshInstanceSchema>> {
    let preparation = await this.input.journal.read<Preparation | PrepareIntent>(this.#prepareKey());
    if (!preparation) { await this.prepare(controlOperationId); preparation = await this.input.journal.read<Preparation>(this.#prepareKey()); }
    if (!preparation || preparation.value.state !== "prepared") throw new Error("NON_GOOGLE_RESTORE_PREPARATION_REQUIRED");
    const existing = await this.input.journal.read<Fresh>(this.#freshKey());
    if (existing) {
      if (existing.value.state === "created") return this.#freshResponse(existing.value);
      const instance = await this.input.transport.attachOriginal({ ...existing.value, binding: this.input.binding });
      if (!await this.input.journal.replace(this.#freshKey(), existing.identitySha256, existing.revision, Object.freeze({ ...existing.value, state: "created" as const }))) throw new Error("NON_GOOGLE_RESTORE_CREATE_RECONCILIATION_CONFLICT");
      this.#instances.set(existing.value.freshInstanceId, instance); return this.#freshResponse(existing.value);
    }
    const original = preparation.value;
    const planned = this.input.transport.planOriginal({ operationId: original.operationId, sourceInstanceId: original.sourceInstanceId, backupSha256: original.backupSha256, binding: this.input.binding });
    const fresh: Fresh = Object.freeze({ ...original, freshInstanceId: Identity.parse(planned.freshInstanceId), databaseInstanceId: Identity.parse(planned.databaseInstanceId), migrationDatabaseInstanceId: Identity.parse(planned.migrationDatabaseInstanceId), applicationInstanceId: Identity.parse(planned.applicationInstanceId), providerOperationId: Identity.parse(planned.providerOperationId), state: "creating" });
    if (fresh.freshInstanceId === fresh.sourceInstanceId || fresh.databaseInstanceId === fresh.sourceInstanceId || fresh.migrationDatabaseInstanceId === fresh.sourceInstanceId || fresh.applicationInstanceId === fresh.sourceInstanceId) throw new Error("NON_GOOGLE_RESTORE_FRESH_INSTANCE_REQUIRED");
    const claimed = await this.input.journal.claim(this.#freshKey(), hash(fresh), fresh);
    if (!claimed.claimed) return this.create(controlOperationId);
    const instance = await this.input.transport.createOriginal({ operationId: original.operationId, sourceInstanceId: original.sourceInstanceId, backupSha256: original.backupSha256, binding: this.input.binding });
    if (instance.freshInstanceId !== fresh.freshInstanceId || instance.sourceInstanceId !== fresh.sourceInstanceId || instance.databaseInstanceId !== fresh.databaseInstanceId || instance.migrationDatabaseInstanceId !== fresh.migrationDatabaseInstanceId || instance.applicationInstanceId !== fresh.applicationInstanceId || instance.providerOperationId !== fresh.providerOperationId) throw new Error("NON_GOOGLE_RESTORE_FRESH_INSTANCE_REQUIRED");
    const imported = await this.input.transport.importOriginal({ operationId: original.operationId, backupSha256: original.backupSha256, instance, binding: this.input.binding });
    if (imported.status !== "imported" || imported.backupSha256 !== original.backupSha256) throw new Error("NON_GOOGLE_RESTORE_IMPORT_DENIED");
    await instance.startAfterRestore();
    if (!await this.input.journal.replace(this.#freshKey(), claimed.record.identitySha256, claimed.record.revision, Object.freeze({ ...fresh, state: "created" as const }))) throw new Error("NON_GOOGLE_RESTORE_CREATE_CONFLICT");
    this.#instances.set(fresh.freshInstanceId, instance); return this.#freshResponse(fresh);
  }
  #freshResponse(value: Fresh) { return CoreFreshInstanceSchema.parse({ freshInstanceId: value.freshInstanceId, sourceInstanceId: value.sourceInstanceId, databaseInstanceId: value.databaseInstanceId, applicationInstanceId: value.applicationInstanceId, restoredBackupSha256: value.backupSha256 }); }
  async #fresh(id: string): Promise<Readonly<{ record: Fresh; instance: ProductionFreshRestoreInstance }>> {
    const freshInstanceId = Identity.parse(id); const memory = this.#instances.get(freshInstanceId);
    const record = await this.input.journal.read<Fresh>(this.#freshKey());
    if (!record || record.value.freshInstanceId !== freshInstanceId || record.value.state !== "created") throw new Error("NON_GOOGLE_RESTORE_ORIGINAL_REQUIRED");
    if (memory) return Object.freeze({ record: record.value, instance: memory });
    const instance = await this.input.transport.attachOriginal({ ...record.value, binding: this.input.binding });
    if (instance.freshInstanceId !== record.value.freshInstanceId || instance.sourceInstanceId !== record.value.sourceInstanceId || instance.databaseInstanceId !== record.value.databaseInstanceId || instance.migrationDatabaseInstanceId !== record.value.migrationDatabaseInstanceId || instance.applicationInstanceId !== record.value.applicationInstanceId || instance.providerOperationId !== record.value.providerOperationId) throw new Error("NON_GOOGLE_RESTORE_REATTACH_BINDING_DENIED");
    this.#instances.set(freshInstanceId, instance); return Object.freeze({ record: record.value, instance });
  }
  async restore(input: Readonly<{ operationId: string; action: string; payload: unknown }>): Promise<unknown> {
    switch (input.action) {
      case "restore.prepare": CoreControlPayloadSchemas["restore.prepare"].parse(input.payload); return this.prepare(input.operationId);
      case "restore.inventory": CoreControlPayloadSchemas["restore.inventory"].parse(input.payload); { const record = await this.input.journal.read<Preparation>(this.#prepareKey()); if (!record) throw new Error("NON_GOOGLE_RESTORE_PREPARATION_REQUIRED"); return record.value.subjects; }
      case "restore.lose-local": CoreControlPayloadSchemas["restore.lose-local"].parse(input.payload); this.#instances.clear(); return Object.freeze({ status: "lost" as const });
      case "restore.create": CoreControlPayloadSchemas["restore.create"].parse(input.payload); return this.create(input.operationId);
      case "restore.subject": return this.#subject(CoreControlPayloadSchemas["restore.subject"].parse(input.payload));
      case "restore.expiry": { const value = CoreControlPayloadSchemas["restore.expiry"].parse(input.payload); const fresh = await this.#fresh(value.freshInstanceId); return fresh.instance.exerciseExpiryDeletion(fresh.record.scope); }
      case "restore.topology": { const value = CoreControlPayloadSchemas["restore.topology"].parse(input.payload); if (!value.freshInstanceId) throw new Error("NON_GOOGLE_RESTORE_FRESH_INSTANCE_REQUIRED"); return (await this.#fresh(value.freshInstanceId)).instance.observeTopology(); }
      case "restore.cleanup": { const value = CoreControlPayloadSchemas["restore.cleanup"].parse(input.payload); const fresh = await this.#fresh(value.freshInstanceId); const deleted = await fresh.instance.cleanup(); if (deleted.state !== "absent") throw new Error("NON_GOOGLE_RESTORE_CLEANUP_UNCONFIRMED"); const observed = await this.input.transport.observeCleanup({ ...fresh.record, binding: this.input.binding }); if (observed.state !== "absent") throw new Error("NON_GOOGLE_RESTORE_CLEANUP_UNCONFIRMED"); return Object.freeze({ state: "absent" as const, freshInstanceId: value.freshInstanceId }); }
      default: throw new Error("NON_GOOGLE_RESTORE_ACTION_DENIED");
    }
  }
  async #subject(value: z.infer<typeof CoreControlPayloadSchemas["restore.subject"]>): Promise<unknown> {
    const fresh = await this.#fresh(value.freshInstanceId); const subject = fresh.record.subjects.find(item => item.kind === value.subject.kind && item.sourceIdentity === value.subject.sourceIdentity && item.object.key === value.subject.object.key && item.object.generation === value.subject.object.generation && item.object.checksum === value.subject.object.checksum);
    if (!subject) throw new Error("NON_GOOGLE_RESTORE_SUBJECT_ORIGINAL_REQUIRED");
    if (value.action === "describe") return CoreRestoreDescriptorSchema.parse({ freshInstanceId: value.freshInstanceId, subject, expected: fresh.record.expected });
    switch (value.action) {
      case "read-ciphertext": {
        const bytes = await fresh.instance.objectStore.readExact(subject.object); if (!bytes) throw new Error("NON_GOOGLE_RESTORE_OBJECT_REQUIRED");
        const part = bytes.slice(value.offset, value.offset + CORE_RESTORE_CHUNK_BYTES);
        return CoreRestoreChunkSchema.parse({ freshInstanceId: value.freshInstanceId, sourceIdentity: subject.sourceIdentity, offset: value.offset, totalBytes: bytes.byteLength, bytesBase64: Buffer.from(part).toString("base64") });
      }
      case "read-plaintext": {
        const bytes = (await fresh.instance.openRetainedArchive({ subject, expected: fresh.record.expected })).archive;
        const part = bytes.slice(value.offset, value.offset + CORE_RESTORE_CHUNK_BYTES);
        return CoreRestoreChunkSchema.parse({ freshInstanceId: value.freshInstanceId, sourceIdentity: subject.sourceIdentity, offset: value.offset, totalBytes: bytes.byteLength, bytesBase64: Buffer.from(part).toString("base64") });
      }
      case "decrypt": {
        if (value.ciphertextSha256 !== subject.object.checksum) throw new Error("NON_GOOGLE_RESTORE_CIPHERTEXT_DENIED");
        const archive = await fresh.instance.openRetainedArchive({ subject, expected: fresh.record.expected });
        if (hash(archive.archive) !== subject.payloadSha256) throw new Error("NON_GOOGLE_RESTORE_ARCHIVE_DENIED");
        return Object.freeze({ freshInstanceId: value.freshInstanceId, sourceIdentity: subject.sourceIdentity, ciphertextSha256: value.ciphertextSha256, archiveSha256: hash(archive.archive), expected: fresh.record.expected });
      }
      case "reattach": {
        const archive = await fresh.instance.openRetainedArchive({ subject, expected: fresh.record.expected });
        if (value.archiveSha256 !== hash(archive.archive) || JSON.stringify(value.expected) !== JSON.stringify(fresh.record.expected)) throw new Error("NON_GOOGLE_RESTORE_REATTACH_DENIED");
        return fresh.instance.reattachOriginal({ subject, sourceIdentity: subject.sourceIdentity, archive: archive.archive, expected: fresh.record.expected });
      }
      default: throw new Error("NON_GOOGLE_RESTORE_ACTION_DENIED");
    }
  }
}
