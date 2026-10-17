import { z } from "zod";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";
import { accountIdForPrincipal } from "../domain/account-command";

const Stage = z.enum(["pending", "active", "verified", "published", "failed", "unconfirmed", "expired"]);
const Id = z.string().min(1).max(240);
export const ProjectsArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), limit: z.number().int().min(1).max(50).default(20), after: Id.optional(), stage: Stage.optional() }).strict(),
  z.object({ action: z.literal("get"), id: Id }).strict(),
  z.object({ action: z.literal("rename"), id: Id, title: z.string().trim().min(1).max(120) }).strict(),
]);
const Pubkey = z.string().regex(/^[a-f0-9]{64}$/);
type Row = { id: string; title: string; created_at: Date; session_id: string | null; checkpoint_id: string | null; version: number; verified_version: number; stage: z.infer<typeof Stage> };
const project = (row: Row) => ({ id: row.id, title: row.title, createdAt: row.created_at.toISOString(), sessionId: row.session_id, checkpointId: row.checkpoint_id, version: row.version, verifiedVersion: row.verified_version, stage: row.stage });
const columns = "id,title,created_at,session_id,checkpoint_id,version,verified_version,stage";
const denied = () => ({ status: "not_found_or_denied" as const });

/** Called only after the ContextVM SDK verifies the signed inner request.
 * There is intentionally no owner argument or delegated identity lookup. */
export class DevelopmentProjects {
  constructor(private readonly pool: Pick<PostgresSqlClient, "query">) {}
  async name(verifiedPubkey: string, sessionId: string, idea: string) {
    const title = idea.trim().replace(/\s+/gu," ").slice(0,120);
    if (title) await this.pool.query("UPDATE development_projects SET title=$3 WHERE id=$1 AND owner_pubkey=$2 AND title='Untitled applet'", [sessionId,Pubkey.parse(verifiedPubkey),title]);
  }
  async bind(verifiedPubkey: string) {
    const pubkey = Pubkey.parse(verifiedPubkey);
    const account = await accountIdForPrincipal({ pubkey });
    await this.pool.query(`INSERT INTO funding_accounts(account_id,nostr_pubkey,unit) VALUES($1,$2,'sat')
      ON CONFLICT(account_id) DO UPDATE SET nostr_pubkey=excluded.nostr_pubkey
      WHERE funding_accounts.nostr_pubkey IS NULL`, [account,pubkey]);
    // Older accounts stored only the irreversible account hash. A new verified
    // request proves its binding and recovers those sessions without guessing.
    await this.pool.query(`INSERT INTO development_projects(id,owner_pubkey,created_at)
      SELECT s.id,$2,coalesce((SELECT min(m.created_at) FROM metered_actions m WHERE m.session_id=s.id),a.created_at)
      FROM metered_sessions s JOIN funding_accounts a ON a.account_id=s.account_id
      WHERE s.account_id=$1 AND trim(a.nostr_pubkey)=$2 ON CONFLICT(id) DO NOTHING`, [account,pubkey]);
  }
  async handle(input: unknown, verifiedPubkey: string) {
    const pubkey = Pubkey.parse(verifiedPubkey);
    const command = ProjectsArgumentsSchema.parse(input);
    await this.bind(pubkey);
    if (command.action === "rename") {
      const result = await this.pool.query("UPDATE development_projects SET title=$3 WHERE id=$1 AND owner_pubkey=$2 RETURNING id", [command.id, pubkey, command.title]);
      if (!result.rows.length) return denied();
    }
    if (command.action !== "list") {
      const row = (await this.pool.query<Row>(`SELECT ${columns} FROM development_project_listing WHERE id=$1 AND owner_pubkey=$2`, [command.id, pubkey])).rows[0];
      return row ? { status: "ok", project: project(row) } : denied();
    }
    let after: { created_at: Date; id: string } | undefined;
    if (command.after) {
      after = (await this.pool.query<{ created_at: Date; id: string }>("SELECT id,created_at FROM development_project_listing WHERE id=$1 AND owner_pubkey=$2", [command.after, pubkey])).rows[0];
      if (!after) return denied();
    }
    const rows = (await this.pool.query<Row>(`SELECT ${columns} FROM development_project_listing
      WHERE owner_pubkey=$1 AND ($2::text IS NULL OR stage=$2)
      AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text))
      ORDER BY created_at DESC,id DESC LIMIT $5`, [pubkey, command.stage ?? null, after?.created_at ?? null, after?.id ?? null, command.limit + 1])).rows;
    return { status: "ok", projects: rows.slice(0, command.limit).map(project), nextCursor: rows.length > command.limit ? rows[command.limit - 1]!.id : null };
  }
}
