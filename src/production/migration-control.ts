import { z } from "zod";
import { canonicalJson } from "../promotion/schema";
import { validateAuthorizationReceipt, validateAuthorizationRequest } from "../release/authorization";
import { assertPostgresOperationJournal, PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { ObjectStorePort, ImmutableObjectReference } from "../continuity/object-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { createMigrationArchive, migrationRecordSha256, MIGRATION_HISTORY_TABLES, restoreMigrationArchiveToPostgres, type MigrationArchive, type MigrationRecord, type MigrationSource } from "./migration";
import type { ProductionConfig } from "./config";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Id = z.string().regex(/^migration:(?:backup|restore-test|cutover|rollback):[a-f0-9]{24}$/u);
const ObjectReference = z.object({ key: z.string().min(1).max(1024), generation: z.number().int().positive(), checksum: Digest }).strict();
const Command = z.discriminatedUnion("kind", [
  z.object({ operationId: Id, kind: z.literal("migration.backup"), authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest, requestSha256: Digest }).strict(),
  z.object({ operationId: Id, kind: z.literal("migration.restore-test"), authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest, backupSha256: Digest, requestSha256: Digest }).strict(),
  z.object({ operationId: Id, kind: z.literal("migration.cutover"), authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest, backupSha256: Digest, restoreProofSha256: Digest, releaseBundleSha256: Digest, requestSha256: Digest }).strict(),
  z.object({ operationId: Id, kind: z.literal("migration.rollback"), authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest, releaseBundleSha256: Digest, requestSha256: Digest }).strict(),
]);
export type MigrationControlCommand = z.infer<typeof Command>;
const Kind = z.enum(["migration.backup", "migration.restore-test", "migration.cutover", "migration.rollback"]);
const Observation = z.object({ operationId: Id, kind: Kind, requestSha256: Digest, state: z.enum(["pending", "completed", "unknown", "failed"]), result: z.unknown().optional() }).strict();
export type MigrationControlObservation = z.infer<typeof Observation>;
type MigrationRouteControlPort = Readonly<{
  cutover(input: Readonly<{ operationId: string; requestSha256: string }>): Promise<Readonly<{ operationId: string; state: "pending" | "completed" | "unknown" }>>;
  rollback(input: Readonly<{ operationId: string; requestSha256: string; originalOperationId: string }>): Promise<Readonly<{ operationId: string; state: "pending" | "completed" | "unknown" }>>;
  observe(operationId: string): Promise<Readonly<{ operationId: string; state: "pending" | "completed" | "unknown" }>>;
}>;

async function sha256(value: unknown): Promise<string> { return new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex"); }
function backupOperationId(requestSha256: string): string { return `migration:backup:${requestSha256.slice(0, 24)}`; }
function restoreOperationId(requestSha256: string): string { return `migration:restore-test:${requestSha256.slice(0, 24)}`; }
const ArchiveEnvelope = z.object({ version: z.literal(1), nonceBase64: z.string().min(16).max(64), ciphertextBase64: z.string().min(1).max(600_000) }).strict();
const ArchiveRecord = z.object({ archiveSha256: Digest, plaintextSha256: Digest, backupObjects: z.array(ObjectReference).min(1).max(512) }).strict();
const BackupChunkIntent = z.object({
  state: z.enum(["intent", "written"]), archiveSha256: Digest, index: z.number().int().min(0).max(511), key: z.string().min(1).max(1024),
  checksum: Digest, ciphertextBase64: z.string().min(1).max(600_000), object: ObjectReference.optional(),
}).strict();
const BACKUP_CHUNK_BYTES = 384 * 1024;
type SourceProjection = Readonly<{ table: typeof MIGRATION_HISTORY_TABLES[number]; sql: string }>;
/** Every source row has an explicit key, owner join, and source-derived
 * revision fence. No JSON-field guessing is allowed at the migration trust
 * boundary. Immutable rows use their exact primary key as the fence. */
const SOURCE_PROJECTIONS: readonly SourceProjection[] = [
  { table: "development_projects", sql: "SELECT p.id AS identity,p.owner_pubkey AS owner_id,s.version::text AS version,to_jsonb(p) AS payload FROM public.development_projects p JOIN public.metered_sessions s ON s.id=p.id" },
  { table: "development_artifacts", sql: "SELECT d.artifact_id AS identity,trim(a.nostr_pubkey) AS owner_id,d.version::text AS version,to_jsonb(d) AS payload FROM public.development_artifacts d JOIN public.funding_accounts a ON a.account_id=d.account_id" },
  { table: "development_preview_grants", sql: "SELECT g.preview_grant_id AS identity,trim(a.nostr_pubkey) AS owner_id,('immutable:'||g.preview_grant_id) AS version,to_jsonb(g) AS payload FROM public.development_preview_grants g JOIN public.funding_accounts a ON a.account_id=g.account_id" },
  { table: "development_publications", sql: "SELECT p.id AS identity,trim(a.nostr_pubkey) AS owner_id,('immutable:'||p.id) AS version,to_jsonb(p) AS payload FROM public.development_publications p JOIN public.funding_accounts a ON a.account_id=p.account_id" },
  { table: "development_revision_restores", sql: "SELECT r.session_id||':'||r.result_version::text AS identity,trim(a.nostr_pubkey) AS owner_id,r.result_version::text AS version,to_jsonb(r) AS payload FROM public.development_revision_restores r JOIN public.funding_accounts a ON a.account_id=r.account_id" },
  { table: "development_pending_actions", sql: "SELECT p.checkpoint_id AS identity,p.owner_id AS owner_id,('immutable:'||p.checkpoint_id) AS version,to_jsonb(p) AS payload FROM public.development_pending_actions p" },
  { table: "development_remix_imports", sql: "SELECT r.reference AS identity,trim(a.nostr_pubkey) AS owner_id,('immutable:'||r.reference) AS version,to_jsonb(r) AS payload FROM public.development_remix_imports r JOIN public.funding_accounts a ON a.account_id=r.account_id" },
  { table: "development_remix_parts", sql: "SELECT r.account_id||':'||r.event_id||':'||r.artifact_hash||':'||r.part_index::text AS identity,trim(a.nostr_pubkey) AS owner_id,('immutable:'||r.account_id||':'||r.event_id||':'||r.artifact_hash||':'||r.part_index::text) AS version,to_jsonb(r) AS payload FROM public.development_remix_parts r JOIN public.funding_accounts a ON a.account_id=r.account_id" },
  { table: "source_proposals", sql: "SELECT s.proposal_sha256 AS identity,trim(a.nostr_pubkey) AS owner_id,s.expected_version::text AS version,to_jsonb(s) AS payload FROM public.source_proposals s JOIN public.funding_accounts a ON a.account_id=s.account_id" },
  { table: "provider_observations", sql: "SELECT o.operation_id AS identity,trim(a.nostr_pubkey) AS owner_id,('immutable:'||o.operation_id) AS version,to_jsonb(o) AS payload FROM public.provider_observations o JOIN public.source_proposals s ON s.operation_id=o.operation_id JOIN public.funding_accounts a ON a.account_id=s.account_id" },
  { table: "development_worker_results", sql: "SELECT w.request_sha256 AS identity,trim(a.nostr_pubkey) AS owner_id,w.expected_version::text AS version,to_jsonb(w) AS payload FROM public.development_worker_results w JOIN public.funding_accounts a ON a.account_id=w.account_id" },
  { table: "development_chatgpt_operations", sql: "SELECT c.operation_id AS identity,trim(a.nostr_pubkey) AS owner_id,('immutable:'||c.operation_id) AS version,to_jsonb(c) AS payload FROM public.development_chatgpt_operations c JOIN public.source_proposals s ON s.operation_id=c.operation_id JOIN public.funding_accounts a ON a.account_id=s.account_id" },
  { table: "development_usage_evidence", sql: "SELECT e.operation_id AS identity,trim(a.nostr_pubkey) AS owner_id,('immutable:'||e.operation_id) AS version,to_jsonb(e) AS payload FROM public.development_usage_evidence e JOIN public.source_proposals s ON s.operation_id=e.operation_id JOIN public.funding_accounts a ON a.account_id=s.account_id" },
  { table: "metered_sessions", sql: "SELECT s.id AS identity,trim(a.nostr_pubkey) AS owner_id,s.version::text AS version,to_jsonb(s) AS payload FROM public.metered_sessions s JOIN public.funding_accounts a ON a.account_id=s.account_id" },
  { table: "metered_actions", sql: "SELECT m.id AS identity,trim(a.nostr_pubkey) AS owner_id,m.expected_session_version::text AS version,to_jsonb(m) AS payload FROM public.metered_actions m JOIN public.funding_accounts a ON a.account_id=m.account_id" },
  { table: "session_artifacts", sql: "SELECT s.id AS identity,trim(a.nostr_pubkey) AS owner_id,s.version::text AS version,to_jsonb(s) AS payload FROM public.session_artifacts s JOIN public.funding_accounts a ON a.account_id=s.account_id" },
  { table: "ledger_entries", sql: "SELECT l.entry_id AS identity,trim(a.nostr_pubkey) AS owner_id,('immutable:'||l.entry_id) AS version,to_jsonb(l) AS payload FROM public.ledger_entries l JOIN public.funding_accounts a ON a.account_id=l.account_id" },
];

/** Encrypted archive envelope. Key bytes are mounted only into sealed server
 * material and never serialized into journals, CLI output, or config. */
export class MigrationArchiveCipher {
  readonly #key: Uint8Array<ArrayBuffer>;
  constructor(key: Uint8Array) { if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("MIGRATION_ARCHIVE_KEY_INVALID"); this.#key = new Uint8Array(key); Object.freeze(this); }
  async seal(bytes: Uint8Array): Promise<Uint8Array> {
    const nonce = crypto.getRandomValues(new Uint8Array(12)); const key = await crypto.subtle.importKey("raw", this.#key, "AES-GCM", false, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new Uint8Array(bytes)));
    return new TextEncoder().encode(JSON.stringify({ version: 1, nonceBase64: Buffer.from(nonce).toString("base64"), ciphertextBase64: Buffer.from(ciphertext).toString("base64") }));
  }
  async open(bytes: Uint8Array): Promise<Uint8Array> {
    const envelope = ArchiveEnvelope.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const nonce = new Uint8Array(Buffer.from(envelope.nonceBase64, "base64")); const ciphertext = new Uint8Array(Buffer.from(envelope.ciphertextBase64, "base64"));
    if (nonce.byteLength !== 12) throw new Error("MIGRATION_ARCHIVE_ENVELOPE_INVALID");
    try { const key = await crypto.subtle.importKey("raw", this.#key, "AES-GCM", false, ["decrypt"]); return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext)); }
    catch { throw new Error("MIGRATION_ARCHIVE_DECRYPTION_FAILED"); }
  }
}
function bytesSha256(bytes: Uint8Array): string { return new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false; return true; }
/** Internal sealed-control primitive. Its journal argument is mandatory so the
 * exact ciphertext is durable before the corresponding immutable write. */
export async function writeEncryptedMigrationArchive(store: ObjectStorePort, cipher: MigrationArchiveCipher, archive: MigrationArchive, journal: PostgresOperationJournal, operationId: string): Promise<z.infer<typeof ArchiveRecord>> {
  const plain = new TextEncoder().encode(canonicalJson(archive));
  if (Math.ceil(plain.byteLength / BACKUP_CHUNK_BYTES) > 512) throw new Error("MIGRATION_BACKUP_ARCHIVE_TOO_LARGE");
  const references: ImmutableObjectReference[] = [];
  for (let offset = 0; offset < plain.byteLength; offset += BACKUP_CHUNK_BYTES) {
    const encrypted = await cipher.seal(plain.slice(offset, Math.min(offset + BACKUP_CHUNK_BYTES, plain.byteLength)));
    const index = references.length, key = `migration/backups/${archive.manifest.archiveSha256}/${index}`, checksum = bytesSha256(encrypted), chunkOperationId = `${operationId}:chunk:${index}`;
    const intent = BackupChunkIntent.parse({ state: "intent", archiveSha256: archive.manifest.archiveSha256, index, key, checksum, ciphertextBase64: Buffer.from(encrypted).toString("base64") });
    const claim = await journal.claim(chunkOperationId, checksum, intent);
    const persisted = BackupChunkIntent.parse(claim.record.value);
    if (persisted.archiveSha256 !== intent.archiveSha256 || persisted.index !== index || persisted.key !== key || persisted.checksum !== checksum || persisted.ciphertextBase64 !== intent.ciphertextBase64) throw new Error("MIGRATION_BACKUP_CHUNK_IDENTITY_CONFLICT");
    const intendedBytes = new Uint8Array(Buffer.from(persisted.ciphertextBase64, "base64"));
    if (bytesSha256(intendedBytes) !== persisted.checksum) throw new Error("MIGRATION_BACKUP_CHUNK_INTENT_INVALID");
    let reference = persisted.object ?? await store.observeExactByKey({ key, checksum });
    if (!reference) {
      if (!claim.claimed) throw new Error("MIGRATION_BACKUP_CHUNK_RECONCILIATION_REQUIRED");
      try { reference = await store.createImmutable({ key, bytes: intendedBytes }); }
      catch { reference = await store.observeExactByKey({ key, checksum }); if (!reference) throw new Error("MIGRATION_BACKUP_CHUNK_RECONCILIATION_REQUIRED"); }
    }
    if (reference.key !== key || reference.checksum !== checksum) throw new Error("MIGRATION_BACKUP_OBJECT_MISMATCH");
    const observedBytes = await store.readExact(reference);
    if (!observedBytes || !sameBytes(observedBytes, intendedBytes)) throw new Error("MIGRATION_BACKUP_OBJECT_MISMATCH");
    const written = BackupChunkIntent.parse({ ...persisted, state: "written", object: reference });
    const saved = await journal.compareAndSet(chunkOperationId, checksum, claim.record.revision, written);
    if (!saved && !persisted.object) throw new Error("MIGRATION_BACKUP_CHUNK_JOURNAL_CONFLICT");
    references.push(reference);
  }
  return ArchiveRecord.parse({ archiveSha256: archive.manifest.archiveSha256, plaintextSha256: bytesSha256(plain), backupObjects: references });
}
async function readEncryptedArchive(store: ObjectStorePort, cipher: MigrationArchiveCipher, record: z.infer<typeof ArchiveRecord>): Promise<MigrationArchive> {
  const chunks: Uint8Array[] = [];
  for (const reference of record.backupObjects) { const encrypted = await store.readExact(reference); if (!encrypted) throw new Error("MIGRATION_BACKUP_OBJECT_MISMATCH"); chunks.push(await cipher.open(encrypted)); }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0); const plain = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { plain.set(chunk, offset); offset += chunk.byteLength; }
  if (bytesSha256(plain) !== record.plaintextSha256) throw new Error("MIGRATION_BACKUP_OBJECT_MISMATCH");
  try { const archive = JSON.parse(new TextDecoder().decode(plain)) as MigrationArchive; if (archive.manifest?.archiveSha256 !== record.archiveSha256) throw new Error(); return archive; }
  catch { throw new Error("MIGRATION_BACKUP_OBJECT_MISMATCH"); }
}

/** Controller-owned source facts. Materialization obtains this from the
 * private, quiesced Beta SQL/object inventory; HTTP callers cannot provide it. */
export class ProductionMigrationSource {
  readonly #source: MigrationSource;
  readonly #pool: PostgresSqlPool;
  constructor(input: Readonly<{ source: MigrationSource; pool: PostgresSqlPool }>) { this.#source = structuredClone(input.source); this.#pool = input.pool; Object.freeze(this); }
  async capture(): Promise<MigrationSource> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE");
      const identity = await client.query<{ schema: string; server_version_num: string }>("SELECT current_schema()::text AS schema, current_setting('server_version_num') AS server_version_num");
      if (identity.rows[0]?.schema !== "public" || !/^17\d{4,}$/u.test(String(identity.rows[0]?.server_version_num))) throw new Error("MIGRATION_SOURCE_DATABASE_UNVERIFIED");
      const writers = await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state <> 'idle' AND pid <> pg_backend_pid() LIMIT 1");
      if (writers.rows.length || this.#source.writers.length) throw new Error("MIGRATION_ACTIVE_WRITER");
      const discovered = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name = ANY($1::text[]) ORDER BY table_name", [MIGRATION_HISTORY_TABLES]);
      if (discovered.rows.length !== MIGRATION_HISTORY_TABLES.length || new Set(discovered.rows.map(row => row.table_name)).size !== MIGRATION_HISTORY_TABLES.length) throw new Error("MIGRATION_SOURCE_SCHEMA_INCOMPLETE");
      const records: MigrationRecord[] = [];
      for (const projection of SOURCE_PROJECTIONS) {
        const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public."${projection.table}"`);
        if (!/^[0-9]+$/u.test(String(count.rows[0]?.count)) || Number(count.rows[0]?.count) > 100_000) throw new Error("MIGRATION_SOURCE_ROW_LIMIT");
        const rows = await client.query<{ identity: string; owner_id: string; version: string; payload: Record<string, unknown> }>(projection.sql);
        for (const row of rows.rows) {
          if (typeof row.identity !== "string" || typeof row.owner_id !== "string" || typeof row.version !== "string" || !row.payload) throw new Error("MIGRATION_SOURCE_IDENTITY_UNMAPPED");
          const version: MigrationRecord["version"] = /^\d+$/u.test(row.version) ? Number(row.version) : row.version === `immutable:${row.identity}` ? row.version as `immutable:${string}` : (() => { throw new Error("MIGRATION_SOURCE_VERSION_UNMAPPED"); })();
          const base = { table: projection.table, identity: row.identity, ownerId: row.owner_id, version, payload: row.payload };
          records.push({ ...base, sha256: migrationRecordSha256(base) });
        }
      }
      await client.query("ROLLBACK");
      return { ...structuredClone(this.#source), records };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
}

const controls = new WeakSet<object>();
export function assertProductionMigrationControl(value: unknown): asserts value is ProductionMigrationControl {
  if (!value || typeof value !== "object" || !controls.has(value)) throw new Error("PRODUCTION_MIGRATION_CONTROL_REQUIRED");
}

const registries = new WeakSet<object>();
/** Sealed runtime materialization product. This is the only location where
 * pools and the GCS data-plane client enter the migration graph. */
export class ProductionMigrationServerRegistry {
  readonly config: ProductionConfig;
  readonly source: ProductionMigrationSource;
  readonly targetPool: PostgresSqlPool;
  readonly freshTargetIdentity: string;
  readonly backupStore: ObjectStorePort;
  readonly archiveCipher: MigrationArchiveCipher;
  readonly routeControl?: MigrationRouteControlPort;
  constructor(input: Readonly<{ config: ProductionConfig; source: ProductionMigrationSource; targetPool: PostgresSqlPool; freshTargetIdentity: string; backupStore: ObjectStorePort; archiveCipher: MigrationArchiveCipher; routeControl?: MigrationRouteControlPort }>) {
    if (input.config.realm !== "production-real" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,255}$/u.test(input.freshTargetIdentity) || !input.backupStore || (input.routeControl && (typeof input.routeControl.cutover !== "function" || typeof input.routeControl.rollback !== "function" || typeof input.routeControl.observe !== "function"))) throw new Error("PRODUCTION_MIGRATION_CONFIGURATION_INVALID");
    this.config = input.config; this.source = input.source; this.targetPool = input.targetPool; this.freshTargetIdentity = input.freshTargetIdentity; this.backupStore = input.backupStore; this.archiveCipher = input.archiveCipher; this.routeControl = input.routeControl;
    registries.add(this); Object.freeze(this);
  }
}
export function assertProductionMigrationServerRegistry(value: unknown): asserts value is ProductionMigrationServerRegistry {
  if (!value || typeof value !== "object" || !registries.has(value)) throw new Error("PRODUCTION_MIGRATION_REGISTRY_REQUIRED");
}

/**
 * A finite private migration capability. Its constructor receives only sealed
 * server material: PostgreSQL pools, exact-generation GCS store, candidate
 * configuration, receipt and original-operation journal. It intentionally has
 * no caller-provided functions, URLs, source rows, credentials, or route APIs.
 */
export class ProductionMigrationControl {
  readonly #input: Readonly<{ registry: ProductionMigrationServerRegistry; authorizationRequest: unknown; authorizationReceipt: unknown; journal: PostgresOperationJournal; now?: () => number }>;
  constructor(input: Readonly<{ registry: ProductionMigrationServerRegistry; authorizationRequest: unknown; authorizationReceipt: unknown; journal: PostgresOperationJournal; now?: () => number }>) {
    assertProductionMigrationServerRegistry(input.registry);
    assertPostgresOperationJournal(input.journal);
    this.#input = Object.freeze(input); controls.add(this); Object.freeze(this);
  }
  async execute(raw: unknown): Promise<MigrationControlObservation> {
    const command = Command.parse(raw); const request = await this.#authorize(command);
    const { requestSha256, ...unsigned } = command;
    if (requestSha256 !== await sha256(unsigned)) throw new Error("MIGRATION_CONTROL_REQUEST_DIGEST_MISMATCH");
    const pending = Observation.parse({ operationId: command.operationId, kind: command.kind, requestSha256, state: "pending" });
    const claim = await this.#input.journal.claim(command.operationId, requestSha256, pending);
    if (!claim.claimed) return this.#reconcile(command, Observation.parse(claim.record.value), claim.record.revision);
    try {
      const result = await this.#run(command, request.authorizationRequestSha256);
      const routeState = command.kind === "migration.cutover" || command.kind === "migration.rollback" ? (result as { route?: { state?: unknown } }).route?.state : undefined;
      const next = Observation.parse({ ...pending, state: routeState === "completed" ? "completed" : "pending", result });
      return Observation.parse((await this.#input.journal.compareAndSet(command.operationId, requestSha256, claim.record.revision, next))?.value ?? next);
    } catch {
      const unknown = Observation.parse({ ...pending, state: "unknown" });
      await this.#input.journal.compareAndSet(command.operationId, requestSha256, claim.record.revision, unknown);
      throw new Error("MIGRATION_CONTROL_RECONCILIATION_REQUIRED");
    }
  }
  /** Interrupted work is query-only. It returns the original journal record
   * and never calls capture, GCS, SQL import, routing or a provider again. */
  async observe(input: Readonly<{ operationId: string }>): Promise<MigrationControlObservation> {
    await this.#validatedAuthorization();
    const record = await this.#input.journal.read<unknown>(Id.parse(input.operationId));
    if (!record) throw new Error("MIGRATION_CONTROL_ORIGINAL_REQUIRED");
    return Observation.parse(record.value);
  }
  #routeOperationId(command: Readonly<{ kind: "migration.cutover" | "migration.rollback"; authorizationRequestSha256: string }>): string { return `migration-route:${command.kind.slice("migration.".length)}:${command.authorizationRequestSha256.slice(0, 24)}`; }
  async #reconcile(command: MigrationControlCommand, current: MigrationControlObservation, revision: number): Promise<MigrationControlObservation> {
    if ((command.kind !== "migration.cutover" && command.kind !== "migration.rollback") || current.state !== "pending") return current;
    if (!this.#input.registry.routeControl) return Observation.parse({ ...current, state: "unknown" });
    const route = await this.#input.registry.routeControl.observe(this.#routeOperationId(command));
    if (route.state === "pending") return current;
    const next = Observation.parse({ ...current, state: route.state === "completed" ? "completed" : "unknown", result: { ...(current.result && typeof current.result === "object" ? current.result as Record<string, unknown> : {}), route } });
    return Observation.parse((await this.#input.journal.compareAndSet(command.operationId, command.requestSha256, revision, next))?.value ?? next);
  }
  async #authorize(command: MigrationControlCommand) {
    const { request, receipt } = await this.#validatedAuthorization();
    if (request.authorizationRequestSha256 !== command.authorizationRequestSha256 || receipt.authorizationReceiptSha256 !== command.authorizationReceiptSha256) throw new Error("MIGRATION_CONTROL_AUTHORIZATION_INVALID");
    return request;
  }
  async #validatedAuthorization() {
    const request = await validateAuthorizationRequest(this.#input.authorizationRequest);
    const receipt = await validateAuthorizationReceipt({ request, receipt: this.#input.authorizationReceipt, nowMs: (this.#input.now ?? Date.now)() });
    const gcs = request.orderedEffects.find(effect => effect.provider === "gcs" && effect.operation === "configure");
    const sql = request.orderedEffects.find(effect => effect.provider === "cloud_sql_postgres" && effect.operation === "create_or_update");
    if (request.candidateSha256 !== this.#input.registry.config.candidateSha256 || request.topologySha256 !== this.#input.registry.config.topologySha256
      || !gcs || !sql || !request.providerScopes.some(scope => scope.provider === "gcs") || !request.providerScopes.some(scope => scope.provider === "cloud_sql_postgres")) throw new Error("MIGRATION_CONTROL_AUTHORIZATION_INVALID");
    return Object.freeze({ request, receipt });
  }
  async #run(command: MigrationControlCommand, authorizationRequestSha256: string): Promise<unknown> {
    if (command.kind === "migration.backup") {
      const source = await this.#input.registry.source.capture();
      const archive = await createMigrationArchive({ source, candidateSha256: this.#input.registry.config.candidateSha256, topologySha256: this.#input.registry.config.topologySha256, now: this.#input.now });
      return writeEncryptedMigrationArchive(this.#input.registry.backupStore, this.#input.registry.archiveCipher, archive, this.#input.journal, command.operationId);
    }
    const backup = await this.#input.journal.read<unknown>(backupOperationId(authorizationRequestSha256));
    const backupResult = backup ? Observation.parse(backup.value) : undefined;
    if (!backupResult || backupResult.state !== "completed") throw new Error("MIGRATION_BACKUP_ORIGINAL_REQUIRED");
    const stored = ArchiveRecord.parse(backupResult.result);
    if (stored.archiveSha256 !== (command.kind === "migration.rollback" ? stored.archiveSha256 : command.backupSha256)) throw new Error("MIGRATION_BACKUP_BINDING_MISMATCH");
    const archive = await readEncryptedArchive(this.#input.registry.backupStore, this.#input.registry.archiveCipher, stored);
    if (command.kind === "migration.restore-test") {
      const target = await this.#input.registry.targetPool.connect();
      try { await restoreMigrationArchiveToPostgres({ archive, expectedCandidateSha256: this.#input.registry.config.candidateSha256, expectedTopologySha256: this.#input.registry.config.topologySha256, targetIdentity: this.#input.registry.freshTargetIdentity, client: target }); }
      finally { target.release(); }
      return Object.freeze({ backupSha256: archive.manifest.archiveSha256, restoreProofSha256: await sha256({ backupSha256: archive.manifest.archiveSha256, target: this.#input.registry.freshTargetIdentity, counts: archive.manifest.counts }), freshTargetIdentity: this.#input.registry.freshTargetIdentity, productionAvailableBalance: 0 });
    }
    if (command.kind === "migration.cutover") {
      const restored = await this.#input.journal.read<unknown>(restoreOperationId(authorizationRequestSha256));
      const value = restored ? Observation.parse(restored.value) : undefined;
      if (!value || value.state !== "completed" || (value.result as { restoreProofSha256?: unknown }).restoreProofSha256 !== command.restoreProofSha256) throw new Error("MIGRATION_RESTORE_PROOF_REQUIRED");
      if (!this.#input.registry.routeControl) throw new Error("MIGRATION_ROUTE_EFFECT_UNAVAILABLE");
      return Object.freeze({ route: await this.#input.registry.routeControl.cutover({ operationId: this.#routeOperationId(command), requestSha256: command.requestSha256 }) });
    }
    if (!this.#input.registry.routeControl) throw new Error("MIGRATION_ROUTE_EFFECT_UNAVAILABLE");
    const originalOperationId = this.#routeOperationId({ ...command, kind: "migration.cutover" });
    return Object.freeze({ route: await this.#input.registry.routeControl.rollback({ operationId: this.#routeOperationId(command), requestSha256: command.requestSha256, originalOperationId }) });
  }
}
