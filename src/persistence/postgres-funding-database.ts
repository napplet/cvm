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
    Object.freeze(this);
  }
}
