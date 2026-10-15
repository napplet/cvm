import type { SealedArtifact } from "./local-artifact-repository";
async function digest(value: string): Promise<string> { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
export type PreviewGrant = Readonly<{ token: string; previewGrantId: string; expiresAtMs: number }>;
type Row = Readonly<{ tokenHash: string; previewGrantId: string; ownerId: string; accountId: string; sessionId: string; artifactId: string; expiresAtMs: number; revoked: boolean }>;
/** Stores hashes only: a restartable SQL adapter can persist exactly this row shape. */
export class LocalPreviewGrantStore {
  readonly #rows = new Map<string, Row>();
  async create(input: Readonly<{ ownerId: string; accountId: string; sessionId: string; artifact: SealedArtifact; ttlMs?: number }>): Promise<PreviewGrant> {
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""); const previewGrantId = `preview:${crypto.randomUUID()}`; const expiresAtMs = Date.now() + (input.ttlMs ?? 10 * 60_000);
    const row = Object.freeze({ tokenHash: await digest(token), previewGrantId, ownerId: input.ownerId, accountId: input.accountId, sessionId: input.sessionId, artifactId: input.artifact.artifactId, expiresAtMs, revoked: false });
    this.#rows.set(row.tokenHash, row); return Object.freeze({ token, previewGrantId, expiresAtMs });
  }
  async authorize(input: Readonly<{ token: string; ownerId?: string; artifactId?: string; path: string }>): Promise<Row | undefined> {
    if (!/^[A-Za-z0-9._/-]+$/u.test(input.path) || input.path.includes("..") || input.path.startsWith("/")) return undefined;
    const row = this.#rows.get(await digest(input.token));
    if (!row || row.revoked || row.expiresAtMs <= Date.now() || (input.ownerId && row.ownerId !== input.ownerId) || (input.artifactId && row.artifactId !== input.artifactId)) return undefined;
    return row;
  }
  async revoke(token: string): Promise<void> { const key = await digest(token); const row = this.#rows.get(key); if (row) this.#rows.set(key, Object.freeze({ ...row, revoked: true })); }
}
