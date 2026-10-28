import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { SourceProposalSchema, type ProviderOperationIntent, type SourceProposal, type SourceProposalLookup } from "../model/model-gateway";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const AllowedPath = z.enum(["src/main.ts", "src/styles.css", "src/capabilities.json"]);
const Stored = z.object({ proposalSha256: Digest, operationId: z.string().min(1), providerRequestId: z.string().min(1), accountId: z.string().regex(/^account:[a-f0-9]{64}$/u), sessionId: z.string().min(1), actionId: z.string().min(1), expectedVersion: z.number().int().nonnegative(), requestFingerprint: Digest, proposal: SourceProposalSchema }).strict();
export type StoredProductionSourceProposal = z.infer<typeof Stored>;
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))), byte => byte.toString(16).padStart(2, "0")).join("");

export async function assertProductionSourceProposalSchema(rawPool: PostgresSqlPool): Promise<void> {
  const client = await bindAccountingRealmPool(rawPool, createAccountingRealm("production-real")).connect();
  try {
    await client.query("SELECT proposal_sha256,operation_id,provider_request_id,account_id,session_id,action_id,expected_version,request_fingerprint_sha256,proposal_json FROM production_real.source_proposals LIMIT 0");
    const row = (await client.query<{ ready: boolean }>("SELECT has_table_privilege(current_user,'production_real.source_proposals','SELECT') AND has_table_privilege(current_user,'production_real.source_proposals','INSERT') AND NOT has_table_privilege(current_user,'production_real.source_proposals','UPDATE,DELETE,TRUNCATE,TRIGGER') AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='production_real.source_proposals'::regclass AND tgname='source_proposal_immutable' AND NOT tgisinternal AND tgenabled IN ('O','A') AND tgtype=27 AND tgfoid='production_real.guard_source_proposal_immutable()'::regprocedure) AS ready")).rows[0];
    if (!row?.ready) throw new Error("PRODUCTION_SOURCE_PROPOSAL_RESTRICTED_SCHEMA_REQUIRED");
  } catch (cause) { throw new Error("PRODUCTION_SOURCE_PROPOSAL_SCHEMA_REQUIRED", { cause }); }
  finally { client.release(); }
}

/** Production-real source authority. It binds provider output to the exact
 * paid operation before a worker can read it; prompts and credentials are not
 * retained in this table. */
export class ProductionSourceProposalStore implements SourceProposalLookup {
  readonly #pool: PostgresSqlPool;
  constructor(pool: PostgresSqlPool) { this.#pool = bindAccountingRealmPool(pool, createAccountingRealm("production-real")); }
  async persist(input: Readonly<{ intent: ProviderOperationIntent; provider: "vertex_ai_gemini"; model: "gemini-4-argon"; proposal: Omit<SourceProposal, "reference" | "sha256"> }>): Promise<StoredProductionSourceProposal> {
    const files = input.proposal.files.map(file => ({ path: AllowedPath.parse(file.path), content: z.string().min(1).max(30_000).parse(file.content) }));
    if (files.length < 1 || files.length > 3 || !files.some(file => file.path === "src/main.ts") || new Set(files.map(file => file.path)).size !== files.length || Buffer.byteLength(JSON.stringify(files)) > 90_000) throw new Error("PRODUCTION_SOURCE_PROPOSAL_INVALID");
    const proposalSha256 = await digest({ files }); const proposal = SourceProposalSchema.parse({ reference: `proposal:sha256:${proposalSha256}`, sha256: proposalSha256, files }); const intent = input.intent;
    const candidate = Stored.parse({ proposalSha256, operationId: intent.operationId, providerRequestId: intent.providerRequestId, accountId: intent.accountId, sessionId: intent.sessionId, actionId: intent.actionId, expectedVersion: intent.expectedVersion, requestFingerprint: intent.requestFingerprint, proposal });
    for (let attempt = 0; attempt < 4; attempt++) {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("INSERT INTO production_real.source_proposals(proposal_sha256,operation_id,provider_request_id,account_id,session_id,action_id,expected_version,request_fingerprint_sha256,proposal_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(operation_id) DO NOTHING", [candidate.proposalSha256, candidate.operationId, candidate.providerRequestId, candidate.accountId, candidate.sessionId, candidate.actionId, candidate.expectedVersion, candidate.requestFingerprint, JSON.stringify(candidate.proposal)]);
        // Immutable rows need no FOR UPDATE, which would require granting the
        // service mutation privileges. Conflicting identities never overwrite.
        const row = (await client.query<Record<string, unknown>>("SELECT proposal_sha256,operation_id,provider_request_id,account_id,session_id,action_id,expected_version,request_fingerprint_sha256,proposal_json FROM production_real.source_proposals WHERE operation_id=$1", [intent.operationId])).rows[0];
        if (!row || canonicalJson(this.#row(row)) !== canonicalJson(candidate)) throw new Error("PRODUCTION_SOURCE_PROPOSAL_CONFLICT");
        await client.query("COMMIT"); return candidate;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (attempt === 3 || !["40001", "40P01", "23505"].includes(code)) throw error;
      } finally { client.release(); }
    }
    throw new Error("PRODUCTION_SOURCE_PROPOSAL_RETRY_EXHAUSTED");
  }

  async lookup(input: Readonly<{ intent: ProviderOperationIntent; reference?: string; sha256?: string }>): Promise<Readonly<{ proposal: SourceProposal }> | undefined> {
    const client = await this.#pool.connect();
    try {
      const row = (await client.query<Record<string, unknown>>("SELECT proposal_sha256,operation_id,provider_request_id,account_id,session_id,action_id,expected_version,request_fingerprint_sha256,proposal_json FROM production_real.source_proposals WHERE operation_id=$1 AND provider_request_id=$2 AND account_id=$3 AND session_id=$4 AND action_id=$5 AND expected_version=$6 AND request_fingerprint_sha256=$7", [input.intent.operationId, input.intent.providerRequestId, input.intent.accountId, input.intent.sessionId, input.intent.actionId, input.intent.expectedVersion, input.intent.requestFingerprint])).rows[0];
      if (!row) return undefined; const stored = this.#row(row); if (input.reference && input.reference !== stored.proposal.reference || input.sha256 && input.sha256 !== stored.proposalSha256) return undefined; return Object.freeze({ proposal: stored.proposal });
    } finally { client.release(); }
  }
  #row(row: Record<string, unknown>): StoredProductionSourceProposal { return Stored.parse({ proposalSha256: row.proposal_sha256, operationId: row.operation_id, providerRequestId: row.provider_request_id, accountId: row.account_id, sessionId: row.session_id, actionId: row.action_id, expectedVersion: Number(row.expected_version), requestFingerprint: row.request_fingerprint_sha256, proposal: row.proposal_json }); }
}
