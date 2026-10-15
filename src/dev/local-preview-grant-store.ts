import { accountIdForPrincipal } from "../domain/account-command";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { SealedArtifact } from "./local-artifact-repository";
function digest(value: string): string { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
export type PreviewGrant = Readonly<{ token: string; previewGrantId: string; expiresAtMs: number }>;
type Row = Readonly<{ tokenHash: string; previewGrantId: string; accountId: string; sessionId: string; artifactId: string; expiresAtMs: number; revoked: boolean }>;
/** Real composition uses SQL. The explicit no-pool component fixture keeps only hashed tokens in memory. */
export class LocalPreviewGrantStore {
  readonly #rows = new Map<string, Row>();
  readonly #pool?: PostgresSqlPool;
  readonly #now: () => number;
  constructor(input: Readonly<{ pool?: PostgresSqlPool; now?: () => number }> = {}) { this.#pool = input.pool; this.#now = input.now ?? Date.now; }
  async create(input: Readonly<{ ownerId: string; accountId: string; sessionId: string; artifact: SealedArtifact; ttlMs?: number }>): Promise<PreviewGrant> {
    if (input.ownerId !== input.artifact.ownerId || input.accountId !== input.artifact.accountId || input.sessionId !== input.artifact.sessionId || await accountIdForPrincipal({ pubkey: input.ownerId }) !== input.accountId) throw new Error("PREVIEW_GRANT_OWNER_BINDING_INVALID");
    const ttl = input.ttlMs ?? 600_000; if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 600_000) throw new Error("PREVIEW_GRANT_TTL_INVALID");
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"); const previewGrantId = `preview:${crypto.randomUUID()}`; const expiresAtMs = this.#now() + ttl;
    const row = Object.freeze({ tokenHash: digest(token), previewGrantId, accountId: input.accountId, sessionId: input.sessionId, artifactId: input.artifact.artifactId, expiresAtMs, revoked: false });
    if (this.#pool) {
      const client = await this.#pool.connect();
      try {
        const inserted = await client.query("INSERT INTO development_preview_grants(preview_grant_id,token_sha256,account_id,session_id,artifact_id,expires_at) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM development_artifacts WHERE artifact_id=$5 AND account_id=$3 AND session_id=$4) RETURNING preview_grant_id", [previewGrantId, row.tokenHash, row.accountId, row.sessionId, row.artifactId, new Date(expiresAtMs)]);
        if (inserted.rows.length !== 1) throw new Error("PREVIEW_GRANT_ARTIFACT_NOT_FOUND_OR_DENIED");
      } finally { client.release(); }
    } else this.#rows.set(row.tokenHash, row);
    return Object.freeze({ token, previewGrantId, expiresAtMs });
  }
  async authorize(input: Readonly<{ token: string; ownerId?: string; artifactId?: string; path: string }>): Promise<Row | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(input.token) || input.path.length > 256 || !/^[A-Za-z0-9._/-]+$/u.test(input.path) || input.path.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
    const tokenHash = digest(input.token); let row: Row | undefined;
    if (this.#pool) {
      const client = await this.#pool.connect();
      try {
        const found = (await client.query<{ preview_grant_id: string; account_id: string; session_id: string; artifact_id: string; expires_at: Date | string; revoked_at: Date | string | null }>("SELECT preview_grant_id,account_id,session_id,artifact_id,expires_at,revoked_at FROM development_preview_grants WHERE token_sha256=$1", [tokenHash])).rows[0];
        if (found) row = Object.freeze({ tokenHash, previewGrantId: found.preview_grant_id, accountId: found.account_id, sessionId: found.session_id, artifactId: found.artifact_id, expiresAtMs: new Date(found.expires_at).getTime(), revoked: found.revoked_at !== null });
      } finally { client.release(); }
    } else row = this.#rows.get(tokenHash);
    if (!row || row.revoked || row.expiresAtMs <= this.#now() || (input.artifactId && row.artifactId !== input.artifactId)) return undefined;
    if (input.ownerId && (!/^[a-f0-9]{64}$/u.test(input.ownerId) || await accountIdForPrincipal({ pubkey: input.ownerId }) !== row.accountId)) return undefined;
    return row;
  }
  async revoke(token: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(token)) return;
    const tokenHash = digest(token);
    if (this.#pool) {
      const client = await this.#pool.connect();
      try { await client.query("UPDATE development_preview_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE token_sha256=$1", [tokenHash, new Date(this.#now())]); }
      finally { client.release(); }
    } else { const row = this.#rows.get(tokenHash); if (row) this.#rows.set(tokenHash, Object.freeze({ ...row, revoked: true })); }
  }
}
