import { z } from "zod";
import { CoreControlPayloadSchemas, CoreFreshInstanceSchema } from "../release/deployment/production-core-suite-protocol";
import type { NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleCoreJournal } from "./non-google-native-runtime";
import { NonGoogleFreshRestoreDriver } from "./non-google-fresh-restore-driver";
import { NonGooglePostgresDriver } from "./non-google-postgres";
import { PostgresByteaObjectStoreAdapter } from "../continuity/postgres-bytea-object-store";
import { FileObjectKeyCustody, PerObjectFileCheckpointCrypto } from "./object-retention-policy";
import { ProductionRetainedSubjectPreparer } from "./retained-subject-preparer";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { createProductionDurabilitySubjectRegistry } from "./durability-registry";
import { PostgresRestorerPullStore } from "./non-google-restorer-pull-protocol";
import { createHash } from "node:crypto";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Prepared = Readonly<{ version: 2; sourceInstanceId: string; binding: NonGoogleCoreBinding; scope: Readonly<{ checkpointId: string; sessionId: string; ownerId: string; sourceAuthorityReference: string }>; state: "prepared" }>;
type Fresh = Readonly<{ version: 2; databaseUuid: string; applicationUuid: string; backupSha256: string; sourceSystemIdentifier: string; freshSystemIdentifier: string; state: "created" }>;

/** Native fresh-resource implementation. It has no caller-provided archive,
 * subject, reattach, cleanup, or resource callback. Seven-subject recovery is
 * permitted only when the restricted original-record query below is complete. */
export class NonGoogleFreshRestoreProvisioner {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal: NonGoogleCoreJournal; postgresJournal: PostgresOperationJournal; driver: NonGoogleFreshRestoreDriver; postgres: NonGooglePostgresDriver; objectStore: PostgresByteaObjectStoreAdapter; scope: Readonly<{ checkpointId: string; sessionId: string; ownerId: string; sourceAuthorityReference: string }>; custodyRoots: readonly string[]; restorerCapabilitySha256: string; roleCostBoundSha256: string }>) { Object.freeze(this); }
  #base() { return `restore:${this.input.binding.candidateSha256}:${this.input.binding.topologySha256}`; }
  #prepare() { return `${this.#base()}:prepare`; }
  #fresh() { return `${this.#base()}:fresh`; }
  async prepare(): Promise<Readonly<{ status: "prepared" }>> {
    /* The final preparation record fences the dump, custody seal, immutable
     * archive, and pull job. A lost response after that durable claim must be
     * reconciled before opening PostgreSQL or invoking pg_dump again. */
    const prior = await this.input.journal.read<Prepared>(this.#prepare());
    if (prior?.value.state === "prepared") {
      const prepared = prior.value;
      if (prepared.version !== 2 || prepared.binding.candidateSha256 !== this.input.binding.candidateSha256 || prepared.binding.topologySha256 !== this.input.binding.topologySha256
        || prepared.scope.checkpointId !== this.input.scope.checkpointId || prepared.scope.sessionId !== this.input.scope.sessionId
        || prepared.scope.ownerId !== this.input.scope.ownerId || prepared.scope.sourceAuthorityReference !== this.input.scope.sourceAuthorityReference) {
        throw new Error("NON_GOOGLE_RESTORE_PREPARATION_CONFLICT");
      }
      return Object.freeze({ status: "prepared" as const });
    }
    const pool = await this.input.postgres.open();
    try {
        const crypto = new PerObjectFileCheckpointCrypto({ pool, custody: new FileObjectKeyCustody({ roots: this.input.custodyRoots }) });
        const preparer = new ProductionRetainedSubjectPreparer({ pool, objectStore: this.input.objectStore, journal: this.input.postgresJournal, kekPath: "/non-google-unused-legacy-kek", crypto });
        await preparer.prepare(this.input.scope);
        const subjects = await createProductionDurabilitySubjectRegistry(pool).inventory(this.input.scope);
        if (subjects.length !== 7) throw new Error("NON_GOOGLE_RESTORE_SUBJECT_INVENTORY_REQUIRED");
        const backup = await this.input.driver.captureCustomBackup();
        try {
          const checkpointId = `restore-backup:${this.input.binding.candidateSha256.slice(0, 24)}`;
          const sealed = await crypto.seal({ checkpointId, plaintext: backup, additionalData: new TextEncoder().encode(JSON.stringify({ scope: this.input.scope, binding: this.input.binding })), binding: { accountId: "restore", sessionId: this.input.scope.sessionId, actionId: this.input.scope.checkpointId, operationId: this.#prepare(), retentionUntil: subjects[0]!.retentionUntil } });
          const stored = await crypto.readSealed(checkpointId);
          if (!stored || stored.keyReference !== sealed.keyReference) throw new Error("NON_GOOGLE_RESTORE_BACKUP_CUSTODY_REQUIRED");
          const reference = await this.input.objectStore.createImmutable({ key: `restore-backups/${checkpointId}/${stored.ciphertextSha256}`, bytes: stored.ciphertext, originalOperationIdentity: createHash("sha256").update(this.#prepare()).digest("hex") });
          await new PostgresRestorerPullStore(this.input.journal, this.input.objectStore).claimJob({ originalId: this.#prepare(), candidateSha256: this.input.binding.candidateSha256, topologySha256: this.input.binding.topologySha256, roleCostBoundSha256: z.string().regex(/^[a-f0-9]{64}$/u).parse(this.input.roleCostBoundSha256), capabilitySha256: z.string().regex(/^[a-f0-9]{64}$/u).parse(this.input.restorerCapabilitySha256), archive: { ...reference, byteCount: stored.ciphertext.byteLength }, expiresAtMs: Date.parse(subjects[0]!.retentionUntil) });
        } finally { backup.fill(0); }
        const sourceInstanceId = await this.input.driver.sourceSystemIdentifier();
        const scope = Object.freeze({ checkpointId: this.input.scope.checkpointId, sessionId: this.input.scope.sessionId, ownerId: this.input.scope.ownerId, sourceAuthorityReference: z.string().min(1).max(256).parse(this.input.scope.sourceAuthorityReference) });
        const value: Prepared = Object.freeze({ version: 2, sourceInstanceId, binding: this.input.binding, scope, state: "prepared" });
        await this.input.journal.claim(this.#prepare(), hash(value), value);
        return Object.freeze({ status: "prepared" as const });
    } finally { await pool.end(); }
  }
  async create(): Promise<z.infer<typeof CoreFreshInstanceSchema>> {
    const prepared = await this.input.journal.read<Prepared>(this.#prepare());
    if (!prepared || prepared.value.state !== "prepared") throw new Error("NON_GOOGLE_RESTORE_PREPARATION_REQUIRED");
    const current = await this.input.journal.read<Fresh>(this.#fresh());
    if (current?.value.state === "created") return CoreFreshInstanceSchema.parse({ freshInstanceId: current.value.databaseUuid, sourceInstanceId: prepared.value.sourceInstanceId, databaseInstanceId: current.value.databaseUuid, applicationInstanceId: current.value.applicationUuid, restoredBackupSha256: current.value.backupSha256 });
    const resources = await this.input.driver.createFreshResources(`restore-${this.input.binding.candidateSha256.slice(0, 16)}`);
    const imported = await this.input.driver.backupAndImport();
    const value: Fresh = Object.freeze({ version: 2, databaseUuid: resources.databaseUuid, applicationUuid: resources.applicationUuid, backupSha256: imported.backupSha256, sourceSystemIdentifier: imported.sourceSystemIdentifier, freshSystemIdentifier: imported.freshSystemIdentifier, state: "created" });
    await this.input.journal.claim(this.#fresh(), hash(value), value);
    return CoreFreshInstanceSchema.parse({ freshInstanceId: value.databaseUuid, sourceInstanceId: prepared.value.sourceInstanceId, databaseInstanceId: value.databaseUuid, applicationInstanceId: value.applicationUuid, restoredBackupSha256: value.backupSha256 });
  }
  async inventory() {
    const pool = await this.input.postgres.open();
    try {
      const prior = await this.input.journal.read<Prepared>(this.#prepare());
      if (!prior || prior.value.state !== "prepared") throw new Error("NON_GOOGLE_RESTORE_PREPARATION_REQUIRED");
      const scope = prior.value.scope;
      if (scope.checkpointId !== this.input.scope.checkpointId || scope.sessionId !== this.input.scope.sessionId || scope.ownerId !== this.input.scope.ownerId || scope.sourceAuthorityReference !== this.input.scope.sourceAuthorityReference) throw new Error("NON_GOOGLE_RESTORE_PREPARATION_CONFLICT");
      return createProductionDurabilitySubjectRegistry(pool).inventory(scope);
    } finally { await pool.end(); }
  }
  async restore(input: Readonly<{ action: string; payload: unknown }>): Promise<unknown> {
    switch (input.action) {
      case "restore.prepare": CoreControlPayloadSchemas["restore.prepare"].parse(input.payload); return this.prepare();
      case "restore.inventory": CoreControlPayloadSchemas["restore.inventory"].parse(input.payload); return this.inventory();
      case "restore.create": CoreControlPayloadSchemas["restore.create"].parse(input.payload); return this.create();
      default: throw new Error("NON_GOOGLE_RESTORE_NATIVE_OPERATION_UNAVAILABLE");
    }
  }
}
