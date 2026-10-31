import { createHash } from "node:crypto";
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

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Prepared = Readonly<{ version: 2; sourceInstanceId: string; binding: NonGoogleCoreBinding; scope: Readonly<{ checkpointId: string; sessionId: string; ownerId: string; sourceAuthorityReference: string }>; state: "prepared" }>;
type Fresh = Readonly<{ version: 2; databaseUuid: string; applicationUuid: string; backupSha256: string; sourceSystemIdentifier: string; freshSystemIdentifier: string; state: "created" }>;

/** Native fresh-resource implementation. It has no caller-provided archive,
 * subject, reattach, cleanup, or resource callback. Seven-subject recovery is
 * permitted only when the restricted original-record query below is complete. */
export class NonGoogleFreshRestoreProvisioner {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal: NonGoogleCoreJournal; postgresJournal: PostgresOperationJournal; driver: NonGoogleFreshRestoreDriver; postgres: NonGooglePostgresDriver; scope: Readonly<{ checkpointId: string; sessionId: string; ownerId: string; sourceAuthorityReference: string }>; custodyRoots: readonly string[] }>) { Object.freeze(this); }
  #base() { return `restore:${this.input.binding.candidateSha256}:${this.input.binding.topologySha256}`; }
  #prepare() { return `${this.#base()}:prepare`; }
  #fresh() { return `${this.#base()}:fresh`; }
  async prepare(): Promise<Readonly<{ status: "prepared" }>> {
    const pool = await this.input.postgres.open();
    try {
      const client = await pool.connect();
      try {
        const objectStore = new PostgresByteaObjectStoreAdapter({ pool, producerBudget: { version: 1, producer: "retained_subject", plaintextBytes: 16 * 1024 * 1024, aesGcmTagBytes: 16, base64Expansion: "4/3-rounded", chunkBytes: 384 * 1024 } });
        const crypto = new PerObjectFileCheckpointCrypto({ pool, custody: new FileObjectKeyCustody({ roots: this.input.custodyRoots }) });
        const preparer = new ProductionRetainedSubjectPreparer({ pool, objectStore, journal: this.input.postgresJournal, kekPath: "/non-google-unused-legacy-kek", crypto });
        await preparer.prepare(this.input.scope);
        const original = await client.query<Record<string, unknown>>("SELECT system_identifier::text AS source_instance_id FROM pg_control_system()", []);
        if (original.rows.length !== 1) throw new Error("NON_GOOGLE_RESTORE_SOURCE_ORIGINAL_REQUIRED");
        const sourceInstanceId = z.string().min(1).max(256).parse(original.rows[0]!.source_instance_id);
        const scope = Object.freeze({ checkpointId: this.input.scope.checkpointId, sessionId: this.input.scope.sessionId, ownerId: this.input.scope.ownerId, sourceAuthorityReference: z.string().min(1).max(256).parse(this.input.scope.sourceAuthorityReference) });
        const value: Prepared = Object.freeze({ version: 2, sourceInstanceId, binding: this.input.binding, scope, state: "prepared" });
        await this.input.journal.claim(this.#prepare(), hash(value), value);
        return Object.freeze({ status: "prepared" as const });
      } finally { client.release(); }
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
  async restore(input: Readonly<{ action: string; payload: unknown }>): Promise<unknown> {
    switch (input.action) {
      case "restore.prepare": CoreControlPayloadSchemas["restore.prepare"].parse(input.payload); return this.prepare();
      case "restore.create": CoreControlPayloadSchemas["restore.create"].parse(input.payload); return this.create();
      default: throw new Error("NON_GOOGLE_RESTORE_NATIVE_OPERATION_UNAVAILABLE");
    }
  }
}
