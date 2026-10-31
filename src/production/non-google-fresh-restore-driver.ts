import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { NonGoogleCoolifyDriver } from "./non-google-coolify-driver";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identifier = z.string().min(1).max(128).regex(/^[a-z0-9-]+$/u);
const Path = z.string().min(1).refine(value => value.startsWith("/"));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const NonGoogleFreshRestoreReferenceSchema = z.object({
  sourceDatabaseUrlPath: Path,
  freshDatabaseUrlPath: Path,
  archiveRoot: Path,
  trustedRestorerName: Identifier,
  expectedPostgresMajor: z.literal(17),
}).strict();
export type NonGoogleFreshRestoreReference = z.infer<typeof NonGoogleFreshRestoreReferenceSchema>;
export type NativeCommand = Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;
export type NativeCommandRunner = Readonly<{ run(command: readonly string[], env: Readonly<Record<string, string>>): Promise<NativeCommand> }>;

/** Production command runner: it runs only a fixed trusted-restorer tool set;
 * callers cannot select a shell, image, executable, or command text. */
export function createBunTrustedRestorerRunner(): NativeCommandRunner {
  return Object.freeze({
    async run(command, env) {
      const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", ...env } });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).bytes(), child.exited]);
      return Object.freeze({ exitCode, stdout, stderr });
    },
  });
}

/** Immutable configuration plus real pg_dump/pg_restore command operations.
 * A host must provide these binaries inside the controller-pinned restorer
 * image; this class never falls back to a developer Docker engine. */
export class NonGoogleFreshRestoreDriver {
  readonly reference: NonGoogleFreshRestoreReference;
  constructor(
    readonly coolify: NonGoogleCoolifyDriver,
    reference: NonGoogleFreshRestoreReference,
    private readonly runner: NativeCommandRunner = createBunTrustedRestorerRunner(),
    private readonly readSecret: (path: string) => Promise<string> = path => readFile(path, "utf8"),
  ) { this.reference = Object.freeze(NonGoogleFreshRestoreReferenceSchema.parse(reference)); Object.freeze(this); }

  /** Creates a distinct PG17 resource and a distinct trusted restorer app.
   * Resource UUIDs originate solely in authenticated Coolify responses. */
  async createFreshResources(operationName: string): Promise<Readonly<{ databaseUuid: string; applicationUuid: string }>> {
    const database = await this.coolify.createPostgres(operationName);
    if (database.image !== undefined && !database.image.includes("postgres")) throw new Error("NON_GOOGLE_FRESH_POSTGRES_IMAGE_INVALID");
    const dockerfile = `FROM ${this.coolify.reference.restorerImage}\nUSER 65532\nENTRYPOINT [\"/usr/local/bin/napplet-trusted-restorer\"]\n`;
    const application = await this.coolify.createRestorer(operationName, dockerfile);
    if (database.uuid === application.uuid) throw new Error("NON_GOOGLE_FRESH_RESOURCE_IDENTITY_INVALID");
    return Object.freeze({ databaseUuid: database.uuid, applicationUuid: application.uuid });
  }

  /** Perform the fixed, native archive/import sequence. The URLs are read
   * after authority at controller-mounted paths and are not returned, logged,
   * or persisted. A caller must persist the result before acknowledging it. */
  async backupAndImport(): Promise<Readonly<{ backupSha256: string; sourceSystemIdentifier: string; freshSystemIdentifier: string }>> {
    if (process.env.NAPPLET_TRUSTED_RESTORER_IMAGE !== this.coolify.reference.restorerImage) throw new Error("NON_GOOGLE_TRUSTED_RESTORER_IMAGE_REQUIRED");
    const [sourceUrl, freshUrl] = await Promise.all([this.#secret(this.reference.sourceDatabaseUrlPath), this.#secret(this.reference.freshDatabaseUrlPath)]);
    const workspace = await mkdtemp(join(tmpdir(), "napplet-fresh-restore-"));
    const archive = join(workspace, "source.dump");
    try {
      await this.#mustRun(["pg_dump", "--format=custom", "--no-owner", "--no-privileges", "--file", archive, "--dbname", sourceUrl], {});
      const bytes = await readFile(archive);
      const backupSha256 = sha256(bytes);
      await this.#mustRun(["pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "--dbname", freshUrl, archive], {});
      const sourceSystemIdentifier = await this.#systemIdentifier(sourceUrl);
      const freshSystemIdentifier = await this.#systemIdentifier(freshUrl);
      if (sourceSystemIdentifier === freshSystemIdentifier) throw new Error("NON_GOOGLE_FRESH_POSTGRES_IDENTITY_REQUIRED");
      return Object.freeze({ backupSha256: Digest.parse(backupSha256), sourceSystemIdentifier, freshSystemIdentifier });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }

  /** Cleanup is exact-resource only. Absence is confirmed by subsequent GETs;
   * a 404 is the sole terminal observation accepted by the native driver. */
  async cleanupExact(input: Readonly<{ databaseUuid: string; applicationUuid: string }>): Promise<void> {
    await this.coolify.deleteApplication(input.applicationUuid);
    await this.coolify.deleteDatabase(input.databaseUuid);
    await Promise.all([this.#absent(() => this.coolify.getApplication(input.applicationUuid)), this.#absent(() => this.coolify.getDatabase(input.databaseUuid))]);
  }

  async #systemIdentifier(databaseUrl: string): Promise<string> {
    const result = await this.#mustRun(["psql", "--tuples-only", "--no-align", "--dbname", databaseUrl, "--command", "SELECT system_identifier FROM pg_control_system()"], {});
    return z.string().regex(/^[0-9]+$/u).parse(new TextDecoder().decode(result.stdout).trim());
  }
  async #mustRun(command: readonly string[], env: Readonly<Record<string, string>>): Promise<NativeCommand> {
    const result = await this.runner.run(command, env);
    if (result.exitCode !== 0) throw new Error("NON_GOOGLE_TRUSTED_RESTORER_COMMAND_FAILED");
    return result;
  }
  async #secret(path: string): Promise<string> { const value = (await this.readSecret(path)).trim(); if (value.length === 0) throw new Error("NON_GOOGLE_FRESH_RESTORE_SECRET_EMPTY"); return value; }
  async #absent(query: () => Promise<unknown>): Promise<void> {
    try { await query(); }
    catch (error) { if (error instanceof Error && error.message === "NON_GOOGLE_COOLIFY_HTTP_404") return; throw error; }
    throw new Error("NON_GOOGLE_FRESH_CLEANUP_UNCONFIRMED");
  }
}
