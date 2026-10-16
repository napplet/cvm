import { mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runBoundedDevelopmentCommand } from "./local-napplet-worker";

export const ImportedSourceSchema = z.object({ files: z.array(z.object({ path: z.string().min(1).max(240).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_.\-/]+$/u), content: z.string().min(1).max(64000) }).strict()).min(1).max(8) }).strict();
export type ImportedSource = z.infer<typeof ImportedSourceSchema> & { commit: string; archiveSha256: string };

/** Initial safe source policy supports public GitHub snapshots. Other source
 * locations fall back to the signed HTML; no credentials or arbitrary egress. */
export function githubSource(value: string): string | undefined {
  const scp = /^(?:git@)?github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(value);
  let path = scp?.[1];
  if (!path) { try { const url = new URL(value); if (url.hostname !== "github.com" || !["https:", "ssh:", "git:"].includes(url.protocol) || url.password || (url.username && !(url.protocol === "ssh:" && url.username === "git")) || url.port || url.search || url.hash) return; path = url.pathname.replace(/^\//u, "").replace(/\/$/u, "").replace(/\.git$/u, ""); } catch { return; } }
  return /^[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(path) && !path.split("/").some(part => part === "." || part === "..") ? path : undefined;
}
async function bounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error("SOURCE_UNAVAILABLE");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) throw new Error("SOURCE_DOWNLOAD_LIMIT"); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  return new Uint8Array(Buffer.concat(chunks));
}
export class LocalRemixSourceImporter {
  constructor(private readonly image: string) {}
  async import(location: string, signal: AbortSignal): Promise<ImportedSource | undefined> {
    const repository = githubSource(location); if (!repository) return;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    // Fixed public endpoints; source metadata cannot choose a host, port,
    // credentials, filesystem path, command argument, redirect or branch.
    const options = { signal: timeout, redirect: "error" as const, headers: { "user-agent": "napplet-cvm-remix", accept: "application/vnd.github+json" } };
    const commitResponse = JSON.parse(new TextDecoder().decode(await bounded(await fetch(`https://api.github.com/repos/${repository}/commits/HEAD`, options), 512000)));
    const commit = z.string().regex(/^[a-f0-9]{40}$/u).parse(commitResponse.sha);
    const archive = await bounded(await fetch(`https://codeload.github.com/${repository}/tar.gz/${commit}`, options), 10_000_000);
    return { ...await this.readArchive(archive, signal), commit, archiveSha256: new Bun.CryptoHasher("sha256").update(archive).digest("hex") };
  }
  /** Repository parsing/checkout occurs in the Docker VM's disposable process,
   * with no network, host secrets, writable host mount, hooks or install step. */
  async readArchive(archive: Uint8Array, signal = new AbortController().signal): Promise<z.infer<typeof ImportedSourceSchema>> {
    if (archive.length > 10_000_000 || !/^sha256:[a-f0-9]{64}$/u.test(this.image)) throw new Error("SOURCE_IMPORT_PRECONDITION_FAILED");
    const root = await mkdtemp(join(tmpdir(), "napplet-remix-")); const input = join(root, "input"); const name = `napplet-remix-${crypto.randomUUID()}`;
    try {
      await mkdir(input);
      await writeFile(join(input, "source.tgz"), archive, { flag: "wx", mode: 0o444 });
      await copyFile(resolve(import.meta.dir, "../../infra/dev-ui/read-remix-source.py"), join(input, "read-source.py"));
      const result = await runBoundedDevelopmentCommand(["docker", "run", "--rm", "--name", name, "--network", "none", "--read-only", "--user", "65532:65532", "--cpus", "1", "--memory", "256m", "--pids-limit", "32", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", "--mount", `type=bind,source=${input},target=/input,readonly`, "--entrypoint", "python3", this.image, "/input/read-source.py"], { deadlineMs: 20000, maxBytes: 128000, signal });
      if (result.exitCode !== 0) throw new Error("SOURCE_IMPORT_FAILED");
      const source = ImportedSourceSchema.parse(JSON.parse(result.stdout));
      if (Buffer.byteLength(JSON.stringify(source.files)) > 96000 || new Set(source.files.map(file => file.path)).size !== source.files.length) throw new Error("SOURCE_IMPORT_INVALID");
      return source;
    } finally {
      await runBoundedDevelopmentCommand(["docker", "rm", "--force", name], { deadlineMs: 5000, maxBytes: 8000 }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
}
