import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { NonGoogleInvocationAuthority } from "./non-google-invocation-authority";
import type { NativeCommandRunner, NonGoogleFreshRestoreReference } from "./non-google-fresh-restore-driver";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** This module is the trusted Coolify application entrypoint, not a control
 * plane HTTP API. A controller starts it with its sealed request and mounted
 * credentials; it has no shell command, arbitrary URL, or network listener. */
export class NonGoogleTrustedRestorerService {
  constructor(
    private readonly reference: NonGoogleFreshRestoreReference,
    private readonly runner: NativeCommandRunner,
    private readonly readSecret: (path: string) => Promise<string> = path => readFile(path, "utf8"),
  ) { Object.freeze(this); }
  async importOriginal(input: Readonly<{ authority: NonGoogleInvocationAuthority; candidateSha256: string; topologySha256: string; requestSha256: string; roleCostBoundSha256: string }>): Promise<Readonly<{ backupSha256: string; sourceSystemIdentifier: string; freshSystemIdentifier: string }>> {
    input.authority.assertDispatch({ scope: "production.core", effect: "restore.create", candidateSha256: input.candidateSha256, topologySha256: input.topologySha256, requestSha256: Digest.parse(input.requestSha256), roleCostBoundSha256: Digest.parse(input.roleCostBoundSha256) });
    if (process.env.NAPPLET_TRUSTED_RESTORER_IMAGE === undefined) throw new Error("NON_GOOGLE_TRUSTED_RESTORER_IMAGE_REQUIRED");
    const [sourceUrl, freshUrl] = await Promise.all([this.#secret(this.reference.sourceDatabaseUrlPath), this.#secret(this.reference.freshDatabaseUrlPath)]);
    const workspace = await mkdtemp(join(tmpdir(), "napplet-trusted-restore-"));
    const archive = join(workspace, "source.dump");
    try {
      await this.#run(["pg_dump", "--format=custom", "--no-owner", "--no-privileges", "--file", archive, "--dbname", sourceUrl]);
      const backupSha256 = Digest.parse(sha256(await readFile(archive)));
      await this.#run(["pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "--dbname", freshUrl, archive]);
      const sourceSystemIdentifier = await this.#systemIdentifier(sourceUrl);
      const freshSystemIdentifier = await this.#systemIdentifier(freshUrl);
      if (sourceSystemIdentifier === freshSystemIdentifier) throw new Error("NON_GOOGLE_FRESH_POSTGRES_IDENTITY_REQUIRED");
      return Object.freeze({ backupSha256, sourceSystemIdentifier, freshSystemIdentifier });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }
  async #systemIdentifier(url: string): Promise<string> {
    const result = await this.#run(["psql", "--tuples-only", "--no-align", "--dbname", url, "--command", "SELECT system_identifier FROM pg_control_system()"]);
    return z.string().regex(/^[0-9]+$/u).parse(new TextDecoder().decode(result.stdout).trim());
  }
  async #run(command: readonly string[]) {
    const result = await this.runner.run(command, {});
    if (result.exitCode !== 0) throw new Error("NON_GOOGLE_TRUSTED_RESTORER_COMMAND_FAILED");
    return result;
  }
  async #secret(path: string): Promise<string> { const value = (await this.readSecret(path)).trim(); if (value.length === 0) throw new Error("NON_GOOGLE_FRESH_RESTORE_SECRET_EMPTY"); return value; }
}
