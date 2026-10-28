import { createHash } from "node:crypto";
import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Authority = z.object({ formatVersion: z.literal(1), servicePubkey: Digest, scopeSha256: Digest }).strict();
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const authorityScope = hash("napplet-cvm:production-service-journals:v1");
const authorityNamespace = "production-service-continuity";
const authorityOperation = "service-journal-authority";
const namespaces = Object.freeze({
  capacity: "production-runtime",
  worker: "production-worker",
  job: "production-worker-job",
  request: "production-worker-request",
  vertex: "production-vertex",
  checkpoint: "production-checkpoint",
  contextvm: "production-contextvm",
  nwc: "production-nwc",
});

/** Pin ordinary operation history to the service, not each release topology.
 * The singleton is an immutable, digest-bound revision-one journal record and
 * is included in the existing SQL journal/audit backup. It grants no provider
 * authority. Certification/control journals must still use current topology.
 *
 * Install under the existing topology before changing it. A database with
 * unanchored history in another scope refuses adoption rather than scanning,
 * guessing an original, copying records or authorizing replacement effects.
 */
export async function openProductionServiceJournals(input: Readonly<{
  pool: PostgresSqlPool;
  /** Derived from the mounted service signer, never an inbound principal. */
  servicePubkey: string;
  initialTopologySha256: string;
  /** Fresh recovery must prove the backed-up anchor, never invent one. */
  requireExisting?: true;
}>) {
  const servicePubkey = Digest.parse(input.servicePubkey);
  const initialTopologySha256 = Digest.parse(input.initialTopologySha256);
  const pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
  let authority: z.infer<typeof Authority> | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [authorityNamespace]);
      const original = (await client.query<Record<string, unknown>>("SELECT identity_sha256,revision,value_json FROM production_real.release_operation_journal WHERE namespace=$1 AND scope_sha256=$2 AND operation_id=$3", [authorityNamespace, authorityScope, authorityOperation])).rows[0];
      if (original) {
        const parsed = Authority.parse(original.value_json);
        if (Number(original.revision) !== 1 || original.identity_sha256 !== hash(parsed)) throw new Error("PRODUCTION_SERVICE_JOURNAL_AUTHORITY_CHANGED");
        if (parsed.servicePubkey !== servicePubkey) throw new Error("PRODUCTION_SERVICE_JOURNAL_IDENTITY_CHANGED");
        authority = parsed;
      } else {
        if (input.requireExisting) throw new Error("PRODUCTION_SERVICE_JOURNAL_AUTHORITY_REQUIRED");
        authority = Authority.parse({ formatVersion: 1, servicePubkey, scopeSha256: initialTopologySha256 });
        await client.query("INSERT INTO production_real.release_operation_journal(namespace,scope_sha256,operation_id,identity_sha256,value_json) VALUES($1,$2,$3,$4,$5::jsonb)", [authorityNamespace, authorityScope, authorityOperation, hash(authority), canonicalJson(authority)]);
      }
      // A pre-continuity binary must not create a second ordinary authority
      // after anchoring. Current-topology certification records may coexist
      // in production-runtime; only its capacity records belong to this fence.
      const foreign = await client.query("SELECT 1 FROM production_real.release_operation_journal WHERE (namespace=ANY($1::text[]) OR (namespace=$2 AND operation_id LIKE 'capacity-intent:%')) AND scope_sha256<>$3 LIMIT 1", [Object.values(namespaces).filter(namespace => namespace !== namespaces.capacity), namespaces.capacity, authority.scopeSha256]);
      if (foreign.rows.length) throw new Error(original ? "PRODUCTION_SERVICE_JOURNAL_SCOPE_CONFLICT" : "PRODUCTION_SERVICE_JOURNAL_LEGACY_SCOPE_REQUIRED");
      await client.query("COMMIT");
      break;
    } catch (error) {
      authority = undefined;
      await client.query("ROLLBACK").catch(() => undefined);
      if (attempt === 3 || !["40001", "40P01", "23505"].includes(String((error as { code?: unknown }).code))) throw error;
    } finally { client.release(); }
  }
  if (!authority) throw new Error("PRODUCTION_SERVICE_JOURNAL_AUTHORITY_UNAVAILABLE");
  const scopeSha256 = authority.scopeSha256;
  const journal = (namespace: string) => new PostgresOperationJournal(input.pool, { namespace, scopeSha256 });
  return Object.freeze({
    scopeSha256,
    capacity: journal(namespaces.capacity), worker: journal(namespaces.worker),
    job: journal(namespaces.job), request: journal(namespaces.request),
    vertex: journal(namespaces.vertex), checkpoint: journal(namespaces.checkpoint),
    contextvm: journal(namespaces.contextvm), nwc: journal(namespaces.nwc),
  });
}
