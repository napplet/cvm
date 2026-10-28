import { createHash } from "node:crypto";

export const MIGRATION_FORMAT_VERSION = 1 as const;
/** The monetary isolation migrations must be observed in this order. */
export const REQUIRED_MIGRATIONS = Object.freeze([
  "phase-03/001_funding.sql",
  "phase-03/002_production_accounting.sql",
  "phase-03/003_cashu_custody_and_identities.sql",
  "phase-03/004_production_rail_material_scope.sql",
  "phase-07/001_production_operation_journal.sql",
] as const);

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
export const MIGRATION_HISTORY_TABLES = Object.freeze([
  "development_projects", "development_artifacts", "development_preview_grants", "development_publications", "development_revision_restores", "development_pending_actions", "development_remix_imports", "development_remix_parts", "source_proposals", "provider_observations", "development_worker_results", "development_chatgpt_operations", "development_usage_evidence", "metered_sessions", "metered_actions", "session_artifacts", "ledger_entries",
]);
const historyTables = new Set(MIGRATION_HISTORY_TABLES);
const monetaryTables = new Set(["ledger_entries", "ledger_transactions", "funding_accounts", "funding_commands", "top_ups", "settlement_attempts", "session_cap_holds", "admissions", "action_budget_reservations"]);

/** Numeric versions are source-owned mutable fences. `immutable:<identity>`
 * is an explicit primary-key fence for append-only records that have no
 * revision column; it is not a fabricated zero version. */
export type MigrationRecord = Readonly<{ table: string; identity: string; ownerId: string; version: number | `immutable:${string}`; payload: unknown; sha256: string }>;
export type MigrationObject = Readonly<{ key: string; generation: number; checksum: string; ownerId: string; version: number }>;
export type MigrationExternalOperation = Readonly<{ operationId: string; state: "observed" | "none" | "unknown" | "dispatching"; sha256: string }>;
export type MigrationSource = Readonly<{
  sourceIdentity: string;
  serviceIdentity: string;
  sourceRevision: string;
  schemaVersions: readonly string[];
  migrationDigests: Readonly<Record<string, string>>;
  writers: readonly string[];
  records: readonly MigrationRecord[];
  objects: readonly MigrationObject[];
  externalOperations: readonly MigrationExternalOperation[];
}>;
export type MigrationManifest = Readonly<{
  formatVersion: typeof MIGRATION_FORMAT_VERSION;
  sourceIdentity: string;
  serviceIdentity: string;
  sourceRevision: string;
  candidateSha256: string;
  topologySha256: string;
  createdAtMs: number;
  schemaVersions: readonly string[];
  migrationDigests: Readonly<Record<string, string>>;
  counts: Readonly<{ records: number; objects: number; externalOperations: number }>;
  accounting: Readonly<{ developmentHistoryRows: number; productionRealRows: 0; productionAvailableBalance: 0 }>;
  archiveSha256: string;
}>;
export type MigrationArchive = Readonly<{ manifest: MigrationManifest; records: readonly MigrationRecord[]; objects: readonly MigrationObject[]; externalOperations: readonly MigrationExternalOperation[] }>;
export type ProductionBalance = { accountId: string; settledAvailable: number };
export type MigrationTarget = { identity: string; history: MigrationRecord[]; readOnlyHistory: string[]; productionBalances: ProductionBalance[]; appliedMigrations: string[] };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
/** The source exporter derives this from the complete immutable row identity;
 * import never trusts a source-supplied digest for a modified payload. */
export function migrationRecordSha256(value: Omit<MigrationRecord, "sha256">): string {
  return digest(canonical(value));
}
function requiredOrder(versions: readonly string[]): boolean {
  let previous = -1;
  for (const required of REQUIRED_MIGRATIONS) {
    const index = versions.indexOf(required);
    if (index < 0 || index <= previous) return false;
    previous = index;
  }
  return true;
}
function assertDigest(value: string, code: string): void { if (!SHA256.test(value) || /^0{64}$/u.test(value)) throw new Error(code); }
function assertSource(source: MigrationSource): void {
  if (!IDENTITY.test(source.sourceIdentity) || !SHA256.test(source.serviceIdentity) || !SHA256.test(source.sourceRevision)) throw new Error("MIGRATION_SOURCE_IDENTITY_INVALID");
  if (source.writers.length) throw new Error("MIGRATION_ACTIVE_WRITER");
  if (!requiredOrder(source.schemaVersions) || source.schemaVersions.some(version => !source.migrationDigests[version] || !SHA256.test(source.migrationDigests[version]!))) throw new Error("MIGRATION_SCHEMA_UNKNOWN");
  const recordIds = new Set<string>();
  for (const row of source.records) {
    if (!historyTables.has(row.table) || !IDENTITY.test(row.identity) || !IDENTITY.test(row.ownerId) || !((Number.isSafeInteger(row.version) && Number(row.version) >= 0) || (typeof row.version === "string" && row.version === `immutable:${row.identity}`)) || !SHA256.test(row.sha256) || /^0{64}$/u.test(row.sha256)) throw new Error("MIGRATION_RECORD_INVALID");
    const key = `${row.table}:${row.identity}`;
    if (recordIds.has(key)) throw new Error("MIGRATION_SOURCE_COLLISION");
    recordIds.add(key);
    if (row.sha256 !== migrationRecordSha256({ table: row.table, identity: row.identity, ownerId: row.ownerId, version: row.version, payload: row.payload })) throw new Error("MIGRATION_RECORD_DIGEST_MISMATCH");
    if (monetaryTables.has(row.table) && (row.payload as { accounting_realm?: unknown })?.accounting_realm !== "development-test") throw new Error("MIGRATION_MONETARY_REALM_INVALID");
  }
  const objects = new Set<string>();
  for (const object of source.objects) {
    if (!object.key || !IDENTITY.test(object.ownerId) || !Number.isSafeInteger(object.generation) || object.generation < 1 || !Number.isSafeInteger(object.version) || object.version < 0) throw new Error("MIGRATION_OBJECT_INVALID");
    assertDigest(object.checksum, "MIGRATION_OBJECT_DIGEST_MISMATCH");
    const key = `${object.key}:${object.generation}`;
    if (objects.has(key)) throw new Error("MIGRATION_OBJECT_COLLISION");
    objects.add(key);
  }
  for (const operation of source.externalOperations) {
    if (!IDENTITY.test(operation.operationId) || operation.state === "unknown" || operation.state === "dispatching") throw new Error("MIGRATION_UNRESOLVED_EXTERNAL_EFFECT");
    assertDigest(operation.sha256, "MIGRATION_OPERATION_DIGEST_INVALID");
  }
}
function archivePayload(input: Omit<MigrationArchive, "manifest"> & Pick<MigrationManifest, "sourceIdentity" | "serviceIdentity" | "sourceRevision" | "candidateSha256" | "topologySha256" | "createdAtMs" | "schemaVersions" | "migrationDigests">): string {
  return canonical({ formatVersion: MIGRATION_FORMAT_VERSION, sourceIdentity: input.sourceIdentity, serviceIdentity: input.serviceIdentity, sourceRevision: input.sourceRevision, candidateSha256: input.candidateSha256, topologySha256: input.topologySha256, createdAtMs: input.createdAtMs, schemaVersions: input.schemaVersions, migrationDigests: input.migrationDigests, records: input.records, objects: input.objects, externalOperations: input.externalOperations });
}

/** Captures a quiesced source as an immutable, content-addressed migration archive. */
export async function createMigrationArchive(input: Readonly<{ source: MigrationSource; candidateSha256: string; topologySha256: string; now?: () => number }>): Promise<MigrationArchive> {
  assertSource(input.source); assertDigest(input.candidateSha256, "MIGRATION_CANDIDATE_INVALID"); assertDigest(input.topologySha256, "MIGRATION_TOPOLOGY_INVALID");
  const createdAtMs = (input.now ?? Date.now)();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new Error("MIGRATION_CLOCK_INVALID");
  const body = { ...input.source, candidateSha256: input.candidateSha256, topologySha256: input.topologySha256, createdAtMs };
  const accounting = { developmentHistoryRows: input.source.records.filter(row => monetaryTables.has(row.table)).length, productionRealRows: 0 as const, productionAvailableBalance: 0 as const };
  const manifest: MigrationManifest = Object.freeze({ formatVersion: MIGRATION_FORMAT_VERSION, sourceIdentity: input.source.sourceIdentity, serviceIdentity: input.source.serviceIdentity, sourceRevision: input.source.sourceRevision, candidateSha256: input.candidateSha256, topologySha256: input.topologySha256, createdAtMs, schemaVersions: [...input.source.schemaVersions], migrationDigests: { ...input.source.migrationDigests }, counts: { records: input.source.records.length, objects: input.source.objects.length, externalOperations: input.source.externalOperations.length }, accounting, archiveSha256: digest(archivePayload(body)) });
  return Object.freeze({ manifest, records: input.source.records.map(row => Object.freeze({ ...row })), objects: input.source.objects.map(item => Object.freeze({ ...item })), externalOperations: input.source.externalOperations.map(item => Object.freeze({ ...item })) });
}

export function createMigrationTarget(identity: string, history: MigrationRecord[] = []): MigrationTarget {
  if (!IDENTITY.test(identity)) throw new Error("MIGRATION_TARGET_IDENTITY_INVALID");
  return { identity, history: [...history], readOnlyHistory: [], productionBalances: [], appliedMigrations: [] };
}
function assertArchive(archive: MigrationArchive, expectedCandidateSha256: string, expectedTopologySha256: string): void {
  const { manifest } = archive;
  if (manifest.formatVersion !== MIGRATION_FORMAT_VERSION || manifest.candidateSha256 !== expectedCandidateSha256 || manifest.topologySha256 !== expectedTopologySha256) throw new Error("MIGRATION_ARCHIVE_BINDING_MISMATCH");
  const actual = digest(archivePayload({ sourceIdentity: manifest.sourceIdentity, serviceIdentity: manifest.serviceIdentity, sourceRevision: manifest.sourceRevision, candidateSha256: manifest.candidateSha256, topologySha256: manifest.topologySha256, createdAtMs: manifest.createdAtMs, schemaVersions: manifest.schemaVersions, migrationDigests: manifest.migrationDigests, records: archive.records, objects: archive.objects, externalOperations: archive.externalOperations }));
  if (actual !== manifest.archiveSha256) throw new Error("MIGRATION_ARCHIVE_DIGEST_MISMATCH");
  if (manifest.counts.records !== archive.records.length || manifest.counts.objects !== archive.objects.length || manifest.counts.externalOperations !== archive.externalOperations.length || manifest.accounting.productionRealRows !== 0 || manifest.accounting.productionAvailableBalance !== 0) throw new Error("MIGRATION_ARCHIVE_COUNTS_INVALID");
  assertSource({ sourceIdentity: manifest.sourceIdentity, serviceIdentity: manifest.serviceIdentity, sourceRevision: manifest.sourceRevision, schemaVersions: manifest.schemaVersions, migrationDigests: manifest.migrationDigests, writers: [], records: archive.records, objects: archive.objects, externalOperations: archive.externalOperations });
}

/** Applies a validated archive as an all-or-nothing fresh-instance import. */
export async function restoreMigrationArchive(input: Readonly<{ archive: MigrationArchive; target: MigrationTarget; expectedCandidateSha256: string; expectedTopologySha256: string }>): Promise<Readonly<{ status: "restored"; targetIdentity: string; counts: MigrationManifest["counts"]; rollback: Readonly<{ sourceIdentity: string; externalOperationReplay: "forbidden"; productionLedgerRestore: "forbidden" }> }>> {
  assertDigest(input.expectedCandidateSha256, "MIGRATION_CANDIDATE_INVALID"); assertDigest(input.expectedTopologySha256, "MIGRATION_TOPOLOGY_INVALID");
  assertArchive(input.archive, input.expectedCandidateSha256, input.expectedTopologySha256);
  if (input.target.productionBalances.some(balance => balance.settledAvailable !== 0)) throw new Error("MIGRATION_TARGET_NOT_ZERO_FUNDED");
  const existing = new Set(input.target.history.map(row => `${row.table}:${row.identity}`));
  if (input.archive.records.some(row => existing.has(`${row.table}:${row.identity}`))) throw new Error("MIGRATION_TARGET_COLLISION");
  // Stage independently, then replace target collections together. No caller
  // receives a partially imported target after a validation exception.
  const stagedHistory = [...input.target.history, ...input.archive.records.map(row => ({ ...row, payload: structuredClone(row.payload) }))];
  const stagedReadOnly = [...input.target.readOnlyHistory, ...input.archive.records.filter(row => monetaryTables.has(row.table)).map(row => row.identity)];
  const stagedMigrations = [...input.archive.manifest.schemaVersions];
  input.target.history.splice(0, input.target.history.length, ...stagedHistory);
  input.target.readOnlyHistory.splice(0, input.target.readOnlyHistory.length, ...stagedReadOnly);
  input.target.appliedMigrations.splice(0, input.target.appliedMigrations.length, ...stagedMigrations);
  return Object.freeze({ status: "restored", targetIdentity: input.target.identity, counts: input.archive.manifest.counts, rollback: Object.freeze({ sourceIdentity: input.archive.manifest.sourceIdentity, externalOperationReplay: "forbidden", productionLedgerRestore: "forbidden" }) });
}

export type SqlMigrationClient = Readonly<{ query(sql: string, values?: readonly unknown[]): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>> }>;
/**
 * Production SQL promotion mirrors the in-memory drill: a dedicated preserved
 * history table records exact source identities, while production_real stays
 * empty. It deliberately never maps old monetary rows into a live ledger.
 */
export async function restoreMigrationArchiveToPostgres(input: Readonly<{ archive: MigrationArchive; expectedCandidateSha256: string; expectedTopologySha256: string; targetIdentity: string; client: SqlMigrationClient }>): Promise<void> {
  assertArchive(input.archive, input.expectedCandidateSha256, input.expectedTopologySha256);
  if (!IDENTITY.test(input.targetIdentity)) throw new Error("MIGRATION_TARGET_IDENTITY_INVALID");
  await input.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await input.client.query("CREATE SCHEMA IF NOT EXISTS production_real");
    await input.client.query("CREATE TABLE IF NOT EXISTS production_real.compatible_history (source_identity text NOT NULL, table_name text NOT NULL, record_identity text NOT NULL, owner_id text NOT NULL, record_version text NOT NULL, record_sha256 char(64) NOT NULL, payload_json jsonb NOT NULL, accounting_realm text NOT NULL CHECK(accounting_realm IN ('development-test','compatible-history')), PRIMARY KEY(source_identity, table_name, record_identity))");
    await input.client.query("CREATE TABLE IF NOT EXISTS production_real.migration_archives (archive_sha256 char(64) PRIMARY KEY, source_identity text NOT NULL, target_identity text NOT NULL, manifest_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())");
    await input.client.query("CREATE TABLE IF NOT EXISTS production_real.compatible_object_references (archive_sha256 char(64) NOT NULL REFERENCES production_real.migration_archives(archive_sha256), object_key text NOT NULL, object_generation bigint NOT NULL, object_checksum char(64) NOT NULL, owner_id text NOT NULL, object_version bigint NOT NULL, PRIMARY KEY(archive_sha256, object_key, object_generation))");
    const balanceTable = await input.client.query("SELECT to_regclass('production_real.account_balance_projection') AS relation");
    if (balanceTable.rows[0]?.relation) {
      const funded = await input.client.query("SELECT 1 FROM production_real.account_balance_projection WHERE settled_available <> 0 OR held <> 0 LIMIT 1");
      if (funded.rows.length) throw new Error("MIGRATION_TARGET_NOT_ZERO_FUNDED");
    }
    const archive = await input.client.query("INSERT INTO production_real.migration_archives(archive_sha256,source_identity,target_identity,manifest_json) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING archive_sha256", [input.archive.manifest.archiveSha256, input.archive.manifest.sourceIdentity, input.targetIdentity, JSON.stringify(input.archive.manifest)]);
    if (archive.rows.length !== 1) throw new Error("MIGRATION_TARGET_COLLISION");
    for (const object of input.archive.objects) {
      await input.client.query("INSERT INTO production_real.compatible_object_references(archive_sha256,object_key,object_generation,object_checksum,owner_id,object_version) VALUES($1,$2,$3,$4,$5,$6)", [input.archive.manifest.archiveSha256, object.key, object.generation, object.checksum, object.ownerId, object.version]);
    }
    for (const row of input.archive.records) {
      const realm = monetaryTables.has(row.table) ? "development-test" : "compatible-history";
      const inserted = await input.client.query("INSERT INTO production_real.compatible_history(source_identity,table_name,record_identity,owner_id,record_version,record_sha256,payload_json,accounting_realm) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING RETURNING record_identity", [input.archive.manifest.sourceIdentity, row.table, row.identity, row.ownerId, String(row.version), row.sha256, JSON.stringify(row.payload), realm]);
      if (inserted.rows.length !== 1) throw new Error("MIGRATION_TARGET_COLLISION");
    }
    await input.client.query("COMMIT");
  } catch (error) { await input.client.query("ROLLBACK").catch(() => undefined); throw error; }
}
