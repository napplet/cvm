import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreControlPayloadSchemas, CoreFreshInstanceSchema } from "../release/deployment/production-core-suite-protocol";
import type { NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleCoreJournal } from "./non-google-native-runtime";
import { NonGoogleFreshRestoreDriver } from "./non-google-fresh-restore-driver";
import { NonGooglePostgresDriver } from "./non-google-postgres";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Prepared = Readonly<{ version: 2; sourceInstanceId: string; binding: NonGoogleCoreBinding; state: "prepared" }>;
type Fresh = Readonly<{ version: 2; databaseUuid: string; applicationUuid: string; backupSha256: string; sourceSystemIdentifier: string; freshSystemIdentifier: string; state: "created" }>;

/** Native fresh-resource implementation. It has no caller-provided archive,
 * subject, reattach, cleanup, or resource callback. Seven-subject recovery is
 * permitted only when the restricted original-record query below is complete. */
export class NonGoogleFreshRestoreProvisioner {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal: NonGoogleCoreJournal; driver: NonGoogleFreshRestoreDriver; postgres: NonGooglePostgresDriver }>) { Object.freeze(this); }
  #base() { return `restore:${this.input.binding.candidateSha256}:${this.input.binding.topologySha256}`; }
  #prepare() { return `${this.#base()}:prepare`; }
  #fresh() { return `${this.#base()}:fresh`; }
  async prepare(): Promise<Readonly<{ status: "prepared" }>> {
    const pool = await this.input.postgres.open();
    try {
      const client = await pool.connect();
      try {
        const original = await client.query<Record<string, unknown>>("SELECT source_instance_id FROM production_real.restore_originals WHERE candidate_sha256=$1 AND topology_sha256=$2 LIMIT 2", [this.input.binding.candidateSha256, this.input.binding.topologySha256]);
        if (original.rows.length !== 1) throw new Error("NON_GOOGLE_RESTORE_SOURCE_ORIGINAL_REQUIRED");
        const sourceInstanceId = z.string().min(1).max(256).parse(original.rows[0]!.source_instance_id);
        const value: Prepared = Object.freeze({ version: 2, sourceInstanceId, binding: this.input.binding, state: "prepared" });
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
