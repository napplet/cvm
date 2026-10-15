import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { WorkerRunRequestSchema, type WorkerRunRequest } from "../phase-02/contracts";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { collectArtifactFiles, readVerifiedArtifactFile } from "./local-artifact-verifier";
import type { WorkerOutput } from "./local-napplet-worker";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Manifest = z.object({
  version: z.literal(1), requestSha256: Digest, operationId: z.string().min(1), accountId: z.string().min(1),
  sessionId: z.string().min(1), actionId: z.string().min(1), expectedVersion: z.number().int().nonnegative(),
  proposalSha256: Digest, toolchainSha256: Digest,
  commandEvidence: z.array(z.object({ name: z.enum(["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"]), exitCode: z.number().int(), stdout: z.string().max(40_000).optional(), stderr: z.string().max(20_000).optional() }).strict()).min(1).max(8),
  files: z.array(z.object({ path: z.string().min(1).max(256), sha256: Digest, bytes: z.number().int().min(0).max(2_000_000) }).strict()).min(1).max(256),
}).strict();
type Row = { request_sha256: string; operation_id: string; account_id: string; session_id: string; action_id: string; expected_version: number; proposal_sha256: string; toolchain_sha256: string; claim_token: string; state: "claimed" | "completed" | "failed"; manifest_sha256: string | null };
const digest = (value: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Private staging of unverified output. The artifact verifier still runs on every restore. */
export class DurableWorkerResultStore {
  readonly #root: string;
  readonly #waitMs: number;
  constructor(private readonly options: Readonly<{ pool: Pick<PostgresSqlClient, "query">; toolchainSha256: string; root?: string; waitMs?: number }>) {
    Digest.parse(options.toolchainSha256);
    this.#root = resolve(options.root ?? join(import.meta.dir, "../../.local/development-worker-results"));
    this.#waitMs = options.waitMs ?? 190_000;
    if (!Number.isSafeInteger(this.#waitMs) || this.#waitMs < 1 || this.#waitMs > 190_000) throw new Error("DEV_WORKER_WAIT_INVALID");
  }

  async materialize(input: WorkerRunRequest, run: () => Promise<WorkerOutput>, signal?: AbortSignal): Promise<WorkerOutput> {
    const request = WorkerRunRequestSchema.parse(input);
    const proposalSha256 = Digest.parse(request.sourceProposalSha256);
    const source = (await this.options.pool.query<{ operation_id: string; account_id: string; proposal_json: unknown }>(
      "SELECT operation_id,account_id,proposal_json FROM source_proposals WHERE session_id=$1 AND action_id=$2 AND expected_version=$3 AND proposal_sha256=$4",
      [request.sessionId, request.actionId, request.expectedVersion, proposalSha256],
    )).rows;
    if (source.length !== 1 || canonicalJson(source[0]!.proposal_json) !== canonicalJson({ reference: request.sourceProposalReference, sha256: proposalSha256, files: request.sourceProposalFiles })) throw new Error("DEV_WORKER_SOURCE_BINDING_INVALID");
    const operationId = source[0]!.operation_id;
    const accountId = source[0]!.account_id;
    const requestSha256 = digest(canonicalJson({ request, accountId, operationId, toolchainSha256: this.options.toolchainSha256 }));
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new Error("DEV_WORKER_RESULTS_DIRECTORY_INVALID");
    const claim = crypto.randomUUID();
    const inserted = await this.options.pool.query<Row>(
      "INSERT INTO development_worker_results(request_sha256,operation_id,account_id,session_id,action_id,expected_version,proposal_sha256,toolchain_sha256,claim_token,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'claimed') ON CONFLICT(operation_id) DO NOTHING RETURNING *",
      [requestSha256, operationId, accountId, request.sessionId, request.actionId, request.expectedVersion, proposalSha256, this.options.toolchainSha256, claim],
    );
    if (!inserted.rows.length) {
      const deadline = Date.now() + this.#waitMs;
      do {
        signal?.throwIfAborted();
        const row = (await this.options.pool.query<Row>("SELECT * FROM development_worker_results WHERE operation_id=$1", [operationId])).rows[0];
        if (!row || row.request_sha256 !== requestSha256 || row.account_id !== accountId || row.toolchain_sha256 !== this.options.toolchainSha256) throw new Error("DEV_WORKER_RESULT_BINDING_INVALID");
        if (row.state === "failed") throw new Error("DEV_WORKER_ORIGINAL_BUILD_FAILED");
        if (row.manifest_sha256) {
          try {
            const result = await this.restore(row);
            if (row.state !== "completed") await this.options.pool.query("UPDATE development_worker_results SET state='completed',completed_at=now() WHERE request_sha256=$1 AND manifest_sha256=$2 AND state='claimed'", [requestSha256, row.manifest_sha256]);
            return result;
          } catch (error) {
            if (row.state === "completed" || (error as { code?: string }).code !== "ENOENT") throw error;
          }
        }
        await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      } while (Date.now() < deadline);
      throw new Error("DEV_WORKER_ORIGINAL_BUILD_UNCERTAIN");
    }

    let output: WorkerOutput | undefined;
    const temporary = join(this.#root, `.${requestSha256}.${claim}`);
    const target = join(this.#root, requestSha256);
    let installed = false;
    try {
      signal?.throwIfAborted();
      output = await run();
      if (output.toolchainSha256 !== this.options.toolchainSha256) throw new Error("DEV_WORKER_RESULT_TOOLCHAIN_CHANGED");
      const files = await collectArtifactFiles(output.distRoot);
      const manifest = Manifest.parse({ version: 1, requestSha256, operationId, accountId, sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, proposalSha256, toolchainSha256: output.toolchainSha256, commandEvidence: output.commandEvidence, files });
      const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
      if (manifestBytes.byteLength > 512_000) throw new Error("DEV_WORKER_RESULT_MANIFEST_TOO_LARGE");
      const manifestSha256 = digest(manifestBytes);
      await mkdir(join(temporary, "dist"), { recursive: true, mode: 0o700 });
      for (const file of files) {
        const bytes = await readVerifiedArtifactFile(output.distRoot, file);
        const path = join(temporary, "dist", file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
      }
      const handle = await open(join(temporary, "result.json"), "wx", 0o400);
      try { await handle.writeFile(manifestBytes); await handle.sync(); } finally { await handle.close(); }
      // Persist the expected manifest hash before exposing the complete directory.
      // Recovery may finish this exact commit, but cannot adopt arbitrary bytes.
      const staged = await this.options.pool.query("UPDATE development_worker_results SET manifest_sha256=$1 WHERE request_sha256=$2 AND claim_token=$3 AND state='claimed' RETURNING request_sha256", [manifestSha256, requestSha256, claim]);
      if (staged.rows.length !== 1) throw new Error("DEV_WORKER_RESULT_CLAIM_LOST");
      await rename(temporary, target); installed = true;
      await this.options.pool.query("UPDATE development_worker_results SET state='completed',completed_at=now() WHERE request_sha256=$1 AND claim_token=$2 AND state='claimed'", [requestSha256, claim]);
      return await this.restore({ ...inserted.rows[0]!, state: "completed", manifest_sha256: manifestSha256 });
    } catch (error) {
      if (!installed) await this.options.pool.query("UPDATE development_worker_results SET state='failed' WHERE request_sha256=$1 AND claim_token=$2 AND state='claimed'", [requestSha256, claim]).catch(() => undefined);
      throw error;
    } finally {
      await output?.cleanup();
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async restore(row: Row): Promise<WorkerOutput> {
    const objectRoot = join(this.#root, Digest.parse(row.request_sha256));
    const directory = await lstat(objectRoot);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("DEV_WORKER_RESULT_DIRECTORY_INVALID");
    const handle = await open(join(objectRoot, "result.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Uint8Array;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 512_000 || stat.nlink !== 1) throw new Error("DEV_WORKER_RESULT_MANIFEST_INVALID");
      const buffer = Buffer.alloc(stat.size + 1); const read = await handle.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead !== stat.size) throw new Error("DEV_WORKER_RESULT_MANIFEST_CHANGED");
      bytes = buffer.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
    if (digest(bytes) !== row.manifest_sha256) throw new Error("DEV_WORKER_RESULT_MANIFEST_CHANGED");
    const manifest = Manifest.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (manifest.requestSha256 !== row.request_sha256 || manifest.operationId !== row.operation_id || manifest.accountId !== row.account_id || manifest.sessionId !== row.session_id || manifest.actionId !== row.action_id || manifest.expectedVersion !== row.expected_version || manifest.proposalSha256 !== row.proposal_sha256 || manifest.toolchainSha256 !== row.toolchain_sha256) throw new Error("DEV_WORKER_RESULT_BINDING_INVALID");
    const distRoot = join(objectRoot, "dist");
    if (canonicalJson(await collectArtifactFiles(distRoot)) !== canonicalJson(manifest.files)) throw new Error("DEV_WORKER_RESULT_FILES_CHANGED");
    return Object.freeze({ distRoot, toolchainSha256: manifest.toolchainSha256, commandEvidence: manifest.commandEvidence, cleanup: async () => { /* Retain exact original output until an explicit development reset. */ } });
  }
}
