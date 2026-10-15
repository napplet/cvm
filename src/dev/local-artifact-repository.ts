import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { readVerifiedArtifactFile, type VerifiedArtifactFacts } from "./local-artifact-verifier";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const RecordSchema = z.object({
  artifactId: z.string().regex(/^artifact:sha256:[a-f0-9]{64}$/u), ownerId: Digest, accountId: z.string().min(1), sessionId: z.string().min(1), actionId: z.string().min(1), version: z.number().int().positive(),
  proposalSha256: Digest, toolchainSha256: Digest, aggregateSha256: Digest, sealedObjectSha256: Digest, verificationEvidenceSha256: Digest,
  objectKey: z.string().regex(/^sealed\/[a-f0-9]{64}$/u), files: z.array(z.object({ path: z.string().min(1).max(256), sha256: Digest, bytes: z.number().int().min(0).max(2_000_000) }).strict()).min(1).max(256),
}).strict();
export type SealedArtifact = Readonly<z.infer<typeof RecordSchema>>;
function sha256(value: string): string { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
function identity(record: Omit<SealedArtifact, "artifactId" | "objectKey">): string { return `artifact:sha256:${sha256(canonicalJson(record))}`; }
function recordIdentity(record: SealedArtifact): string { const { artifactId: _, objectKey: __, ...facts } = record; return identity(facts); }
function freeze(record: SealedArtifact): SealedArtifact { record.files.forEach(Object.freeze); Object.freeze(record.files); return Object.freeze(record); }
const columns = "artifact_id,account_id,session_id,action_id,version,proposal_sha256,toolchain_sha256,aggregate_sha256,sealed_object_sha256,verification_evidence_sha256,object_key,files_json";
function values(record: SealedArtifact): unknown[] { return [record.artifactId, record.accountId, record.sessionId, record.actionId, record.version, record.proposalSha256, record.toolchainSha256, record.aggregateSha256, record.sealedObjectSha256, record.verificationEvidenceSha256, record.objectKey, record.files]; }

/** SQL metadata authority and atomically sealed local bytes. No mutable cache is authoritative. */
export class LocalArtifactRepository {
  readonly #objectRoot: string;
  readonly #pool?: PostgresSqlPool;
  constructor(input: Readonly<{ objectRoot: string; pool?: PostgresSqlPool }>) { this.#objectRoot = resolve(input.objectRoot); this.#pool = input.pool; }
  async commit(facts: VerifiedArtifactFacts): Promise<SealedArtifact> {
    if (await accountIdForPrincipal({ pubkey: facts.ownerId }) !== facts.accountId) throw new Error("ARTIFACT_OWNER_BINDING_INVALID");
    const body = { ownerId: facts.ownerId, accountId: facts.accountId, sessionId: facts.sessionId, actionId: facts.actionId, version: facts.expectedVersion + 1, proposalSha256: facts.proposalSha256, toolchainSha256: facts.toolchainSha256, aggregateSha256: facts.aggregateSha256, sealedObjectSha256: facts.sealedObjectSha256, verificationEvidenceSha256: facts.verificationEvidenceSha256, files: facts.files.map((file) => ({ ...file })) };
    const artifactId = identity(body); const objectKey = `sealed/${artifactId.slice("artifact:sha256:".length)}`;
    const sealed = freeze(RecordSchema.parse({ ...body, artifactId, objectKey }));
    const existing = await this.get(artifactId);
    if (existing) { for (const file of existing.files) await readVerifiedArtifactFile(join(this.safeObjectPath(existing.objectKey), "dist"), file); return existing; }
    await mkdir(this.safeObjectPath("sealed"), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(this.#objectRoot, ".artifact-stage-"));
    try {
      for (const file of sealed.files) {
        const bytes = await readVerifiedArtifactFile(facts.distRoot, file);
        const target = resolve(stage, "dist", file.path);
        if (!target.startsWith(`${stage}${sep}dist${sep}`)) throw new Error("ARTIFACT_OBJECT_PATH_REJECTED");
        await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: "wx", mode: 0o400 });
      }
      await writeFile(join(stage, "record.json"), canonicalJson(sealed), { flag: "wx", mode: 0o400 });
      try { await rename(stage, this.safeObjectPath(objectKey)); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const prior = await this.readRecord(objectKey);
        if (canonicalJson(prior) !== canonicalJson(sealed)) throw new Error("ARTIFACT_IMMUTABLE_CONFLICT");
        for (const file of sealed.files) await readVerifiedArtifactFile(join(this.safeObjectPath(objectKey), "dist"), file);
      }
    } finally { await rm(stage, { recursive: true, force: true }); }
    if (this.#pool) {
      const client = await this.#pool.connect();
      try {
        const parameters = values(sealed); parameters[11] = JSON.stringify(sealed.files);
        await client.query(`INSERT INTO development_artifacts(${columns}) VALUES(${parameters.map((_, index) => `$${index + 1}`).join(",")}) ON CONFLICT(artifact_id) DO NOTHING`, parameters);
      }
      finally { client.release(); }
    }
    const committed = await this.get(artifactId);
    if (!committed || canonicalJson(committed) !== canonicalJson(sealed)) throw new Error("ARTIFACT_COMMIT_RECONCILIATION_REQUIRED");
    return committed;
  }
  async get(artifactId: string): Promise<SealedArtifact | undefined> {
    if (!/^artifact:sha256:[a-f0-9]{64}$/u.test(artifactId)) return undefined;
    let row: Record<string, unknown> | undefined;
    if (this.#pool) {
      const client = await this.#pool.connect();
      try { row = (await client.query<Record<string, unknown>>(`SELECT ${columns} FROM development_artifacts WHERE artifact_id=$1`, [artifactId])).rows[0]; }
      finally { client.release(); }
      if (!row) return undefined;
    }
    let record: SealedArtifact;
    try { record = await this.readRecord(`sealed/${artifactId.slice("artifact:sha256:".length)}`); }
    catch (error) { if (!row && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (record.artifactId !== artifactId || recordIdentity(record) !== artifactId || await accountIdForPrincipal({ pubkey: record.ownerId }) !== record.accountId || record.objectKey !== `sealed/${artifactId.slice("artifact:sha256:".length)}`) throw new Error("ARTIFACT_METADATA_BINDING_INVALID");
    if (row && canonicalJson(columns.split(",").map((key) => row![key])) !== canonicalJson(values(record))) throw new Error("ARTIFACT_SQL_METADATA_MISMATCH");
    return record;
  }
  async read(input: Readonly<{ artifactId: string; path: string }>): Promise<Readonly<{ bytes: Uint8Array; file: SealedArtifact["files"][number] }> | undefined> {
    const artifact = await this.get(input.artifactId); const file = artifact?.files.find((candidate) => candidate.path === input.path);
    if (!artifact || !file) return undefined;
    return Object.freeze({ bytes: await readVerifiedArtifactFile(join(this.safeObjectPath(artifact.objectKey), "dist"), file), file });
  }
  private async readRecord(key: string): Promise<SealedArtifact> {
    const handle = await open(join(this.safeObjectPath(key), "record.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > 128_000) throw new Error("ARTIFACT_METADATA_INVALID");
      return freeze(RecordSchema.parse(JSON.parse(await handle.readFile("utf8"))));
    } finally { await handle.close(); }
  }
  private safeObjectPath(value: string): string { const target = resolve(this.#objectRoot, value); if (!target.startsWith(`${this.#objectRoot}${sep}`)) throw new Error("ARTIFACT_OBJECT_PATH_REJECTED"); return target; }
}
