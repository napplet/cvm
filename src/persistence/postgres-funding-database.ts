import type { AccountTopUpStatusPort } from "../funding/account-status";
import { bindAccountingRealmPool, createAccountingRealm, type AccountingRealm, type AccountingRealmName } from "../funding/accounting-realm";
import type { CashuTopUpRecord, CashuTopUpRepository, CashuTopUpResult } from "../funding/cashu-top-up";
import type { LightningPrivateTopUp, LightningTopUpRepository, LightningTopUpState } from "../funding/lightning-top-up";
import type { ProtectedRailMaterialRecord, ProtectedRailMaterialRepository } from "../funding/protected-rail-material";
import type { AccountTopUpStatus } from "../phase-03/contracts";
import { PostgresSqlFundingStore, type PostgresSqlClient, type PostgresSqlPool, type PostgresSqlStoreOptions } from "./postgres-sql-funding-store";
import type { ContinuationFundingStore, MeteredFundingStore } from "./funding-store";

type LightningJson = Readonly<{
  topUps?: readonly [string, LightningPrivateTopUp][];
  commands?: readonly [string, Readonly<{ fingerprint: string; topUpId: string }>][];
}>;

const frozen = <T>(value: T): T => Object.freeze(structuredClone(value));
const bytes = (value: unknown): Uint8Array => value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value as ArrayBuffer);

export type ProductionCustodyMaterial = Readonly<{
  custodyId: string; operationId: string; accountId: string; rail: "cashu" | "lightning";
  materialKind: "cashu_input" | "cashu_blinded_message" | "cashu_output" | "lightning_intent";
  keyReference: string; payloadDigest: string; nonce: Uint8Array; ciphertext: Uint8Array;
  canonicalProofIdentity?: string; mintUrl?: string; keysetId?: string; unit?: "sat";
}>;
export interface ProductionCustodyRepository { put(record: ProductionCustodyMaterial): Promise<void>; get(custodyId: string): Promise<ProductionCustodyMaterial | undefined>; }
export type UncertainRailOperation = Readonly<{ operationId: string; accountId: string; rail: "cashu" | "lightning"; providerLocator: string; stableLabel?: string; state: "created" | "dispatching" | "unknown" | "observed_pending" | "observed_succeeded" | "observed_failed"; }>;
export interface UncertainRailOperationRepository { createOrReplay(operation: UncertainRailOperation): Promise<Readonly<{ operation: UncertainRailOperation; created: boolean }>>; transition(operationId: string, state: UncertainRailOperation["state"]): Promise<UncertainRailOperation>; get(operationId: string): Promise<UncertainRailOperation | undefined>; }

function custodyFromRow(row: Record<string, unknown>): ProductionCustodyMaterial { return frozen({ custodyId: String(row.custody_id), operationId: String(row.operation_id), accountId: String(row.account_id), rail: row.rail as "cashu" | "lightning", materialKind: row.material_kind as ProductionCustodyMaterial["materialKind"], keyReference: String(row.key_reference), payloadDigest: String(row.payload_digest), nonce: bytes(row.nonce), ciphertext: bytes(row.ciphertext), ...(row.canonical_proof_identity ? { canonicalProofIdentity: String(row.canonical_proof_identity) } : {}), ...(row.mint_url ? { mintUrl: String(row.mint_url) } : {}), ...(row.keyset_id ? { keysetId: String(row.keyset_id) } : {}), ...(row.unit ? { unit: row.unit as "sat" } : {}) }); }
function operationFromRow(row: Record<string, unknown>): UncertainRailOperation { return frozen({ operationId: String(row.operation_id), accountId: String(row.account_id), rail: row.rail as "cashu" | "lightning", providerLocator: String(row.provider_locator), ...(row.stable_label ? { stableLabel: String(row.stable_label) } : {}), state: row.state as UncertainRailOperation["state"] }); }

class PostgresProductionCustodyRepository implements ProductionCustodyRepository {
  constructor(private readonly pool: PostgresSqlPool, private readonly realm: AccountingRealm) {}
  async put(record: ProductionCustodyMaterial): Promise<void> {
    if (this.realm.name !== "production-real" || !/^[a-f0-9]{64}$/iu.test(record.payloadDigest) || (record.canonicalProofIdentity && !/^[a-f0-9]{64}$/iu.test(record.canonicalProofIdentity))) throw new Error("PRODUCTION_CUSTODY_INVALID");
    const client = await this.pool.connect();
    try { const existing = (await client.query("SELECT custody_id,operation_id,account_id,rail,material_kind,key_reference,payload_digest,canonical_proof_identity,mint_url,keyset_id,unit,nonce,ciphertext FROM rail_custody_material WHERE custody_id=$1", [record.custodyId])).rows[0]; if (existing) { const prior = custodyFromRow(existing); if (prior.operationId !== record.operationId || prior.accountId !== record.accountId || prior.rail !== record.rail || prior.materialKind !== record.materialKind || prior.keyReference !== record.keyReference || prior.payloadDigest !== record.payloadDigest || prior.canonicalProofIdentity !== record.canonicalProofIdentity || prior.mintUrl !== record.mintUrl || prior.keysetId !== record.keysetId || prior.unit !== record.unit || !Buffer.from(prior.nonce).equals(Buffer.from(record.nonce)) || !Buffer.from(prior.ciphertext).equals(Buffer.from(record.ciphertext))) throw new Error("PRODUCTION_CUSTODY_IDENTITY_CONFLICT"); return; } await client.query("INSERT INTO rail_custody_material(custody_id,operation_id,account_id,rail,material_kind,key_reference,payload_digest,canonical_proof_identity,mint_url,keyset_id,unit,nonce,ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [record.custodyId, record.operationId, record.accountId, record.rail, record.materialKind, record.keyReference, record.payloadDigest, record.canonicalProofIdentity ?? null, record.mintUrl ?? null, record.keysetId ?? null, record.unit ?? null, record.nonce, record.ciphertext]); } finally { client.release(); }
  }
  async get(custodyId: string): Promise<ProductionCustodyMaterial | undefined> { const client = await this.pool.connect(); try { const row = (await client.query("SELECT custody_id,operation_id,account_id,rail,material_kind,key_reference,payload_digest,canonical_proof_identity,mint_url,keyset_id,unit,nonce,ciphertext FROM rail_custody_material WHERE custody_id=$1", [custodyId])).rows[0]; return row && custodyFromRow(row); } finally { client.release(); } }
}

class PostgresUncertainRailOperationRepository implements UncertainRailOperationRepository {
  constructor(private readonly pool: PostgresSqlPool, private readonly realm: AccountingRealm) {}
  async createOrReplay(operation: UncertainRailOperation): Promise<Readonly<{ operation: UncertainRailOperation; created: boolean }>> {
    if (this.realm.name !== "production-real") throw new Error("PRODUCTION_ACCOUNTING_REALM_REQUIRED");
    const client = await this.pool.connect();
    try { await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); const row = (await client.query("SELECT operation_id,account_id,rail,provider_locator,stable_label,state FROM uncertain_rail_operations WHERE operation_id=$1 FOR UPDATE", [operation.operationId])).rows[0]; if (row) { const prior = operationFromRow(row); if (prior.accountId !== operation.accountId || prior.rail !== operation.rail || prior.providerLocator !== operation.providerLocator || prior.stableLabel !== operation.stableLabel) throw new Error("PRODUCTION_OPERATION_IDENTITY_CONFLICT"); await client.query("COMMIT"); return frozen({ operation: prior, created: false }); } if (operation.state !== "created") throw new Error("PRODUCTION_OPERATION_INITIAL_STATE_INVALID"); await client.query("INSERT INTO uncertain_rail_operations(operation_id,account_id,rail,provider_locator,stable_label,state) VALUES($1,$2,$3,$4,$5,$6)", [operation.operationId, operation.accountId, operation.rail, operation.providerLocator, operation.stableLabel ?? null, operation.state]); await client.query("COMMIT"); return frozen({ operation: frozen(operation), created: true }); } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
  async transition(operationId: string, state: UncertainRailOperation["state"]): Promise<UncertainRailOperation> { const client = await this.pool.connect(); try { await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); const row = (await client.query("UPDATE uncertain_rail_operations SET state=$2,updated_at=now() WHERE operation_id=$1 RETURNING operation_id,account_id,rail,provider_locator,stable_label,state", [operationId, state])).rows[0]; if (!row) throw new Error("PRODUCTION_OPERATION_NOT_FOUND"); await client.query("COMMIT"); return operationFromRow(row); } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); } }
  async get(operationId: string): Promise<UncertainRailOperation | undefined> { const client = await this.pool.connect(); try { const row = (await client.query("SELECT operation_id,account_id,rail,provider_locator,stable_label,state FROM uncertain_rail_operations WHERE operation_id=$1", [operationId])).rows[0]; return row && operationFromRow(row); } finally { client.release(); } }
}

class PostgresLightningLifecycleRepository implements LightningTopUpRepository {
  constructor(private readonly pool: PostgresSqlPool) {}

  async transact<T>(operation: (state: LightningTopUpState) => Promise<T> | T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const found = await client.query<{ state_json: LightningJson }>("SELECT state_json FROM lightning_top_up_state WHERE state_key='global' FOR UPDATE");
      const raw = found.rows[0]?.state_json ?? {};
      const state: LightningTopUpState = { topUps: new Map(raw.topUps ?? []), commands: new Map(raw.commands ?? []) };
      const result = await operation(state);
      await client.query("INSERT INTO lightning_top_up_state(state_key,state_json) VALUES ('global',$1) ON CONFLICT (state_key) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()", [JSON.stringify({ topUps: [...state.topUps], commands: [...state.commands] })]);
      await client.query("COMMIT");
      return frozen(result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresCashuLifecycleRepository implements CashuTopUpRepository {
  constructor(private readonly pool: PostgresSqlPool) {}

  async claim(input: CashuTopUpRecord): Promise<Readonly<{ claimed: boolean; record: CashuTopUpRecord }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const existing = await client.query<{ state_json: CashuTopUpRecord }>("SELECT state_json FROM cashu_top_up_state WHERE top_up_id=$1 OR proof_commitment=$2 FOR UPDATE", [input.result.topUpId, input.result.commitment]);
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return frozen({ claimed: false, record: existing.rows[0].state_json });
      }
      await client.query("INSERT INTO cashu_top_up_state(top_up_id,account_id,proof_commitment,state_json) VALUES ($1,$2,$3,$4)", [input.result.topUpId, input.accountId, input.result.commitment, JSON.stringify(input)]);
      await client.query("COMMIT");
      return frozen({ claimed: true, record: input });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async find(topUpId: string): Promise<CashuTopUpRecord | undefined> {
    return this.readRecord(topUpId, "state_json");
  }

  async update(record: CashuTopUpRecord): Promise<void> {
    await this.withClient(async (client) => { await client.query("UPDATE cashu_top_up_state SET state_json=$2,updated_at=now() WHERE top_up_id=$1", [record.result.topUpId, JSON.stringify(record)]); });
  }

  async findTreasury(topUpId: string): Promise<CashuTopUpResult | undefined> {
    return this.readRecord(topUpId, "treasury_json");
  }

  async recordTreasury(topUpId: string, result: CashuTopUpResult): Promise<void> {
    await this.withClient(async (client) => { await client.query("UPDATE cashu_top_up_state SET treasury_json=$2,updated_at=now() WHERE top_up_id=$1", [topUpId, JSON.stringify(result)]); });
  }

  private async readRecord<T>(topUpId: string, column: "state_json" | "treasury_json"): Promise<T | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<Record<typeof column, T>>(`SELECT ${column} FROM cashu_top_up_state WHERE top_up_id=$1`, [topUpId]);
      const value = result.rows[0]?.[column];
      return value && frozen(value);
    });
  }

  private async withClient<T>(operation: (client: PostgresSqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await operation(client); } finally { client.release(); }
  }
}

class PostgresProtectedRailMaterialRepository implements ProtectedRailMaterialRepository {
  constructor(private readonly pool: PostgresSqlPool) {}

  async put(record: ProtectedRailMaterialRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("INSERT INTO protected_rail_material(material_id,account_id,top_up_id,rail,payload_digest,nonce,ciphertext,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [record.id, record.accountId, record.topUpId, record.rail, record.payloadDigest, record.nonce, record.ciphertext, record.expiresAt ?? null, record.createdAt]);
    } finally { client.release(); }
  }

  async get(id: string): Promise<ProtectedRailMaterialRecord | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ material_id: string; account_id: string; top_up_id: string; rail: "lightning" | "cashu"; payload_digest: string; nonce: Uint8Array; ciphertext: Uint8Array; created_at: string; expires_at?: string }>("SELECT material_id,account_id,top_up_id,rail,payload_digest,nonce,ciphertext,created_at,expires_at FROM protected_rail_material WHERE material_id=$1 AND expired_at IS NULL", [id]);
      const row = result.rows[0];
      return row && frozen({ id: row.material_id, accountId: row.account_id, topUpId: row.top_up_id, rail: row.rail, payloadDigest: row.payload_digest, nonce: bytes(row.nonce), ciphertext: bytes(row.ciphertext), createdAt: new Date(row.created_at).toISOString(), ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}) });
    } finally { client.release(); }
  }

  async expire(id: string): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("UPDATE protected_rail_material SET expired_at=now() WHERE material_id=$1", [id]); } finally { client.release(); }
  }
}

class PostgresRailStatusProjection implements AccountTopUpStatusPort {
  constructor(private readonly pool: PostgresSqlPool) {}

  async list(input: Readonly<{ accountId: string }>): Promise<readonly AccountTopUpStatus[]> {
    const client = await this.pool.connect();
    try {
      const [lightning, cashu] = await Promise.all([
        client.query<{ state_json: LightningJson }>("SELECT state_json FROM lightning_top_up_state WHERE state_key='global'"),
        client.query<{ state_json: CashuTopUpRecord }>("SELECT state_json FROM cashu_top_up_state WHERE account_id=$1 ORDER BY updated_at", [input.accountId]),
      ]);
      const lightningRows = (lightning.rows[0]?.state_json.topUps ?? []).map(([, record]) => record).filter((record) => record.accountId === input.accountId).map((record): AccountTopUpStatus => ({
        topUpId: record.topUpId, rail: "lightning", state: record.state, amount: record.amount, unit: "sat", createdAt: record.createdAt,
        ...(record.safeDisplayReference ? { safeDisplayReference: record.safeDisplayReference } : {}), ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
        ...(record.settlementReference ? { settlementReference: record.settlementReference } : {}),
      }));
      const cashuRows = cashu.rows.map(({ state_json: record }): AccountTopUpStatus => ({
        topUpId: record.result.topUpId, rail: "cashu", state: record.result.state, amount: record.amount, unit: "sat", createdAt: record.createdAt,
        ...(record.result.settlementReference ? { settlementReference: record.result.settlementReference } : {}),
      }));
      return frozen([...lightningRows, ...cashuRows]);
    } finally { client.release(); }
  }
}

/**
 * Sole SQL owner for Phase 3. Callers receive capability-specific ports and can
 * neither issue arbitrary queries nor pass database credentials into rail code.
 */
export class PostgresFundingDatabase {
  readonly realm: AccountingRealm;
  readonly funding: PostgresSqlFundingStore;
  /** Alias of `funding`, not a second billing/session capability or connection. */
  readonly meteredFunding: MeteredFundingStore;
  /** Alias of `funding`; continuation state never receives a second authority. */
  readonly continuationFunding: ContinuationFundingStore;
  readonly lightning: LightningTopUpRepository;
  readonly cashu: CashuTopUpRepository;
  readonly protectedMaterials: ProtectedRailMaterialRepository;
  readonly railStatuses: AccountTopUpStatusPort;
  readonly custody: ProductionCustodyRepository;
  readonly uncertainRailOperations: UncertainRailOperationRepository;

  constructor(pool: PostgresSqlPool, options: PostgresSqlStoreOptions & Readonly<{ realm?: AccountingRealmName }> = {}) {
    this.realm = createAccountingRealm(options.realm ?? "development-test");
    const realmPool = bindAccountingRealmPool(pool, this.realm);
    this.funding = new PostgresSqlFundingStore(realmPool, options);
    this.meteredFunding = this.funding;
    this.continuationFunding = this.funding;
    this.lightning = new PostgresLightningLifecycleRepository(realmPool);
    this.cashu = new PostgresCashuLifecycleRepository(realmPool);
    this.protectedMaterials = new PostgresProtectedRailMaterialRepository(realmPool);
    this.railStatuses = new PostgresRailStatusProjection(realmPool);
    this.custody = new PostgresProductionCustodyRepository(realmPool, this.realm);
    this.uncertainRailOperations = new PostgresUncertainRailOperationRepository(realmPool, this.realm);
    Object.freeze(this);
  }
}
