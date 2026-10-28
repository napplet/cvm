#!/usr/bin/env bun
/** Immutable privileged supervisor. Generated commands always run in a fresh
 * PID/network namespace as UID 65532. Only this supervisor can write results. */
import { spawn } from "node:child_process";
import { chmod, chown, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "/run/napplet-cvm-jobs";
const BOOTSTRAP = "/usr/local/bin/napplet-cvm-bootstrap";
const SCRIPT = "/usr/local/bin/napplet-cvm-job";
const POLICY = "production-worker-policy-2026-10-27";
const MAX_REQUEST = 131_072, CHUNK = 24_576, MAX_ARTIFACT = 16_777_216;
const MAX_RESTORE = 25_165_824;
const env = { PATH: "/usr/local/bin:/usr/bin:/bin", NAPPLET_CVM_POLICY_VERSION: POLICY };
const sha = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const fail = (code: string): never => { throw new Error(code); };
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
type Request = { version: 1; actionId: string; sessionId: string; expectedVersion: number; proposalSha256: string; toolchainSha256: string; deadlineEpochMs: number; files: Array<{ path: string; content: string }> };
function parseRequest(value: unknown): Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("JOB_REQUEST_INVALID");
  const v = value as Request;
  if (Object.keys(v).sort().join(",") !== "actionId,deadlineEpochMs,expectedVersion,files,proposalSha256,sessionId,toolchainSha256,version" || v.version !== 1 || ![v.actionId, v.sessionId].every(id => typeof id === "string" && id.length > 0 && id.length <= 256) || !Number.isSafeInteger(v.expectedVersion) || v.expectedVersion < 0 || ![v.proposalSha256, v.toolchainSha256].every(x => /^[a-f0-9]{64}$/u.test(x)) || !Number.isSafeInteger(v.deadlineEpochMs) || !Array.isArray(v.files) || v.files.length < 1 || v.files.length > 3) fail("JOB_REQUEST_INVALID");
  const allowed = new Set(["src/main.ts", "src/styles.css", "src/capabilities.json"]);
  for (const file of v.files) if (!file || Object.keys(file).sort().join(",") !== "content,path" || !allowed.has(file.path) || typeof file.content !== "string" || Buffer.byteLength(file.content) > 30_000) fail("JOB_SOURCE_INVALID");
  if (new Set(v.files.map(file => file.path)).size !== v.files.length || !v.files.some(file => file.path === "src/main.ts")) fail("JOB_SOURCE_INVALID");
  return v;
}
async function exists(path: string) { return lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }); }
async function immutable(path: string, bytes: Uint8Array | string) {
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha(await readFile(path)) !== sha(bytes)) throw error; }
}
// A crash holding this lock makes this lease unavailable. It never permits a
// second dispatcher or an acknowledged fence while a start is racing it.
async function controlled<T>(operation: () => Promise<T>): Promise<T> {
  const lock = join(ROOT, "control-lock"); await mkdir(lock);
  try { return await operation(); } finally { await rm(lock, { recursive: true }); }
}
async function idle(): Promise<boolean> {
  if (await exists(join(ROOT, "active"))) return false;
  for (const entry of await readdir(ROOT)) if (/^[a-f0-9]{64}$/u.test(entry) && await exists(join(ROOT, entry, "claimed")) && !await exists(join(ROOT, entry, "result.json"))) return false;
  return true;
}
function parseRestore(bytes: Uint8Array) {
  if (bytes.length > MAX_RESTORE) fail("RESTORE_LIMIT");
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!value || Object.keys(value).sort().join(",") !== "artifact,source,toolchainSha256,version" || value.version !== 1 || !/^[a-f0-9]{64}$/u.test(value.toolchainSha256)) fail("RESTORE_INVALID");
  const source = parseRequest(value.source);
  const artifact = value.artifact;
  if (source.toolchainSha256 !== value.toolchainSha256 || !artifact || Object.keys(artifact).sort().join(",") !== "commandEvidence,files,jobId,proposalSha256,toolchainSha256,version" || artifact.version !== 1 || artifact.jobId !== sha(canonical(source)) || artifact.toolchainSha256 !== value.toolchainSha256 || artifact.proposalSha256 !== source.proposalSha256 || !Array.isArray(artifact.files) || artifact.files.length < 1 || artifact.files.length > 256 || !Array.isArray(artifact.commandEvidence) || artifact.commandEvidence.length !== 8) fail("RESTORE_BINDING_INVALID");
  let total = 0; const paths = new Set<string>();
  for (const file of artifact.files) {
    if (!file || Object.keys(file).sort().join(",") !== "bytesBase64,path,sha256,size" || typeof file.path !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(file.path) || file.path.split("/").some((part: string) => part === "." || part === "..") || paths.has(file.path) || typeof file.bytesBase64 !== "string" || file.bytesBase64.length > 22_369_624) fail("RESTORE_FILE_INVALID");
    paths.add(file.path); const content = Buffer.from(file.bytesBase64, "base64"); total += content.length;
    if (content.length !== file.size || sha(content) !== file.sha256 || content.toString("base64") !== file.bytesBase64 || total > MAX_ARTIFACT) fail("RESTORE_FILE_INVALID");
  }
  if (!paths.has("index.html")) fail("RESTORE_ENTRY_MISSING");
  return { source, artifact, toolchainSha256: value.toolchainSha256 as string };
}
async function protect(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return; // pnpm links target the immutable image store.
  // Files were created by the build UID, possibly with private mode bits.
  // Ownership conversion must preserve its ability to read the immutable
  // substrate. Merely stripping write bits can turn 0600 into root-only 0400.
  await chown(path, 0, 0); await chmod(path, info.isDirectory() ? 0o555 : 0o444 | (info.mode & 0o111 ? 0o111 : 0));
  if (info.isDirectory()) for (const child of await readdir(path)) await protect(join(path, child));
}
async function command(argv: string[], cwd: string, deadline: number) {
  if (deadline <= Date.now()) fail("JOB_DEADLINE_EXPIRED");
  const startedAt = Date.now();
  const child = Bun.spawn(["/usr/bin/unshare", "--pid", "--fork", "--kill-child", "--mount", "--mount-proc", "--", BOOTSTRAP, ...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(); let bytes = 0; const parts: Uint8Array[] = [];
    try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 65_536) { child.kill(); fail("JOB_LOG_LIMIT"); } parts.push(item.value); } return Buffer.concat(parts).toString("utf8"); }
    finally { reader.releaseLock(); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("JOB_COMMAND_TIMEOUT")); }, Math.min(120_000, deadline - Date.now())); });
    const [exitCode, stdout, stderr] = await Promise.race([Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]), timeout]);
    return { argv, exitCode, stdout, stderr, elapsedMs: Date.now() - startedAt };
  } finally { clearTimeout(timer); child.kill(); }
}
async function collect(root: string) {
  const files: { path: string; bytesBase64: string; sha256: string; size: number }[] = []; let total = 0;
  async function visit(path: string, relative = "") {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) fail("JOB_ARTIFACT_UNTRUSTED");
    if (info.isDirectory()) { for (const child of (await readdir(path)).sort()) { if (!/^[A-Za-z0-9._-]+$/u.test(child) || child === "." || child === "..") fail("JOB_ARTIFACT_PATH_INVALID"); await visit(join(path, child), relative ? `${relative}/${child}` : child); } return; }
    total += info.size; if (total > MAX_ARTIFACT || files.length >= 256) fail("JOB_ARTIFACT_LIMIT");
    const bytes = await readFile(path); if (bytes.length !== info.size) fail("JOB_ARTIFACT_CHANGED");
    files.push({ path: relative, bytesBase64: bytes.toString("base64"), sha256: sha(bytes), size: bytes.length });
  }
  await visit(root); if (!files.some(file => file.path === "index.html")) fail("JOB_ARTIFACT_ENTRY_MISSING");
  return files;
}
async function run(id: string, dir: string) {
  const requestBytes = await readFile(join(dir, "request.json")); if (sha(requestBytes) !== id) fail("JOB_REQUEST_DIGEST_INVALID");
  const request = parseRequest(JSON.parse(requestBytes.toString("utf8")));
  const commands: Awaited<ReturnType<typeof command>>[] = [];
  const project = `/workspace/jobs/${id}/project`;
  const execute = async (argv: string[], cwd: string) => { const result = await command(argv, cwd, request.deadlineEpochMs); commands.push(result); if (result.exitCode !== 0) fail("JOB_COMMAND_FAILED"); };
  let locked = false;
  try {
    await mkdir(join(ROOT, "active")); locked = true;
    if (request.deadlineEpochMs <= Date.now() || request.deadlineEpochMs > Date.now() + 600_000) fail("JOB_DEADLINE_INVALID");
    await mkdir(`/workspace/jobs/${id}`, { recursive: true }); await chown(`/workspace/jobs/${id}`, 65532, 65532);
    await execute(["/toolchain/bin/napplet", "create", project, "--template", "/toolchain/boilerplate-template"], "/workspace");
    await execute(["/toolchain/bin/napplet", "init", "--force", "--root", "--source-dir", "dist", "--title", "Generated napplet"], project);
    await execute(["/toolchain/bin/bun", "/toolchain/node_modules/@napplet/skills/dist/cli.js", "install", "--to", "codex", "--dir", "/home/napplet"], project);
    const pnpm = "/toolchain/pnpm-10.8/bin/pnpm.cjs";
    await execute([pnpm, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", "/toolchain/pnpm-store"], project);
    const originalRoot = new Set(await readdir(project));
    await chown(`/workspace/jobs/${id}`, 0, 0); await chmod(`/workspace/jobs/${id}`, 0o755);
    for (const file of request.files) { const path = join(project, file.path); const info = await lstat(path).catch(() => undefined); if (info?.isSymbolicLink() || (info && !info.isFile())) fail("JOB_SOURCE_PATH_UNTRUSTED"); await writeFile(path, file.content, { mode: 0o444 }); }
    await protect(project);
    // Sticky root allows new tool reports but prevents generated UID from
    // replacing any of the root-owned package/config/source files.
    await chmod(project, 0o1777);
    for (const name of ["dist", "test-results", "playwright-report", ".cache", ".vite"]) { const path = join(project, name); await mkdir(path, { recursive: true }); await chown(path, 65532, 65532); await chmod(path, 0o700); }
    for (const argv of [[pnpm, "build"], [pnpm, "verify"], [pnpm, "test:conformance"], ["/toolchain/bin/napplet", "deploy", "--dry-run", "--json", "--name", `cvm-${id.slice(0, 24)}`]]) {
      for (const name of await readdir(project)) if (!originalRoot.has(name) && /(^\.env|^\.npmrc$|^pnpm-workspace\.|\.config\.|^tsconfig\.|^napplet\.)/u.test(name)) fail("JOB_MANAGED_CONFIGURATION_CHANGED");
      await execute(argv, project);
    }
    const files = await collect(join(project, "dist"));
    const artifact = canonical({ version: 1, jobId: id, proposalSha256: request.proposalSha256, toolchainSha256: request.toolchainSha256, files, commandEvidence: commands });
    await immutable(join(dir, "artifact.json"), artifact);
    await immutable(join(dir, "result.json"), canonical({ version: 1, jobId: id, state: "completed", requestSha256: id, artifactSha256: sha(artifact), artifactBytes: Buffer.byteLength(artifact), commands: commands.map(({ stdout, stderr, ...facts }) => ({ ...facts, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) })) }));
  } catch (error) {
    // Failure status is private coordinator output. Preserve bounded tails
    // from the last command so a failed build can be diagnosed after the
    // ephemeral workspace is removed. These are untrusted diagnostic bytes,
    // never conformance or artifact evidence; full output hashes stay intact.
    const last = commands.at(-1);
    const diagnostics = last ? { commandIndex: commands.length - 1, stdoutTail: last.stdout.slice(-4096), stderrTail: last.stderr.slice(-4096) } : undefined;
    await immutable(join(dir, "result.json"), canonical({ version: 1, jobId: id, state: "failed", requestSha256: id, code: error instanceof Error ? error.message : "JOB_FAILED", commands: commands.map(({ stdout, stderr, ...facts }) => ({ ...facts, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) })), ...(diagnostics ? { diagnostics } : {}) })).catch(() => undefined);
  } finally {
    // The immutable input and artifact are retained under the root-only job
    // record. Free ephemeral installs so revisions cannot fill the workspace.
    if (locked) { await rm(`/workspace/jobs/${id}`, { recursive: true, force: true }).catch(() => undefined); await rm(join(ROOT, "active"), { recursive: true, force: true }); }
  }
}

try {
  if (process.getuid?.() !== 0 || process.env.NAPPLET_CVM_POLICY_VERSION !== POLICY) fail("JOB_TRUSTED_SUPERVISOR_REQUIRED");
  const [action, id, argument, data] = process.argv.slice(2);
  if (!id || !/^[a-f0-9]{64}$/u.test(id)) fail("JOB_ID_INVALID");
  const rootInfo = await lstat(ROOT); if (!rootInfo.isDirectory() || rootInfo.uid !== 0 || (rootInfo.mode & 0o077) !== 0) fail("JOB_ROOT_UNTRUSTED");
  const dir = join(ROOT, id);
  if (action === "put") {
    if (!argument || !/^[0-5]$/u.test(argument) || !data || data.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) fail("JOB_CHUNK_INVALID");
    const bytes = Buffer.from(data, "base64"); if (!bytes.length || bytes.length > CHUNK || bytes.toString("base64") !== data) fail("JOB_CHUNK_INVALID");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await exists(join(dir, "claimed"))) fail("JOB_ALREADY_CLAIMED");
    await immutable(join(dir, `part-${argument}`), bytes); console.log(JSON.stringify({ state: "stored", jobId: id, chunk: Number(argument), sha256: sha(bytes) }));
  } else if (action === "start") {
    if (!argument || !/^[1-6]$/u.test(argument) || data) fail("JOB_START_INVALID");
    await controlled(async () => {
    if (!await exists(join(dir, "claimed"))) {
      if (await exists(join(ROOT, "fence.json"))) fail("JOB_LEASE_FENCED");
      if (await exists(join(ROOT, "restoring"))) {
        const restoreId = await readFile(join(ROOT, "restoring"), "utf8");
        if (!/^[a-f0-9]{64}$/u.test(restoreId) || !await exists(join(ROOT, `restore-${restoreId}`, "result.json"))) fail("JOB_RESTORE_PENDING");
      }
      const bytes = Buffer.concat(await Promise.all(Array.from({ length: Number(argument) }, (_, index) => readFile(join(dir, `part-${index}`)))));
      if (bytes.length > MAX_REQUEST || sha(bytes) !== id) fail("JOB_REQUEST_DIGEST_INVALID");
      const request = parseRequest(JSON.parse(bytes.toString("utf8"))); if (request.deadlineEpochMs <= Date.now() || request.deadlineEpochMs > Date.now() + 600_000) fail("JOB_DEADLINE_INVALID");
      await immutable(join(dir, "request.json"), bytes);
      // Exclusive claim precedes process creation. An ambiguous start is never
      // dispatched again, even if the supervisor dies before spawning.
      try {
        await writeFile(join(dir, "claimed"), id, { flag: "wx", mode: 0o600 });
        const child = spawn("/usr/local/bin/bun", [SCRIPT, "run", id], { detached: true, stdio: "ignore", env }); child.unref();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    });
    console.log(JSON.stringify({ state: "pending", jobId: id }));
  } else if (action === "status") {
    if (argument || data) fail("JOB_STATUS_INVALID");
    console.log(await exists(join(dir, "result.json")) ? await readFile(join(dir, "result.json"), "utf8") : JSON.stringify({ state: await exists(join(dir, "claimed")) ? "pending" : "missing", jobId: id }));
  } else if (action === "artifact") {
    if (!argument || !/^(0|[1-9][0-9]{0,7})$/u.test(argument) || data || Number(argument) % CHUNK !== 0) fail("JOB_ARTIFACT_OFFSET_INVALID");
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8")); if (result.state !== "completed") fail("JOB_ARTIFACT_NOT_VERIFIED");
    const bytes = await readFile(join(dir, "artifact.json")); if (sha(bytes) !== result.artifactSha256 || Number(argument) >= bytes.length) fail("JOB_ARTIFACT_BINDING_INVALID");
    console.log(JSON.stringify({ jobId: id, offset: Number(argument), totalBytes: bytes.length, artifactSha256: result.artifactSha256, bytesBase64: bytes.subarray(Number(argument), Number(argument) + CHUNK).toString("base64") }));
  } else if (action === "fence" || action === "fence-status") {
    if (!argument || !/^[a-f0-9]{64}$/u.test(argument) || data) fail("JOB_FENCE_INVALID");
    const marker = canonical({ jobId: id, fenceSha256: argument });
    const result = await controlled(async () => {
      if (action === "fence") {
        if (!await exists(join(dir, "request.json"))) fail("JOB_FENCE_ORIGINAL_REQUIRED");
        await immutable(join(ROOT, "fence.json"), marker);
      }
      if (!await exists(join(ROOT, "fence.json"))) return "missing";
      if (await readFile(join(ROOT, "fence.json"), "utf8") !== marker) fail("JOB_FENCE_CONFLICT");
      return await idle() ? "fenced" : "pending";
    });
    console.log(JSON.stringify({ state: result, jobId: id, fenceSha256: argument }));
  } else if (action === "restore-put") {
    if (!argument || !/^(0|[1-9][0-9]{0,3})$/u.test(argument) || Number(argument) >= MAX_RESTORE / CHUNK || !data || data.length > 32_768) fail("RESTORE_CHUNK_INVALID");
    const bytes = Buffer.from(data, "base64"); if (!bytes.length || bytes.length > CHUNK || bytes.toString("base64") !== data) fail("RESTORE_CHUNK_INVALID");
    await controlled(async () => {
      if (!await idle() || await exists(join(ROOT, "fence.json"))) fail("RESTORE_FRESH_LEASE_REQUIRED");
      for (const entry of await readdir(ROOT)) if (/^[a-f0-9]{64}$/u.test(entry) && await exists(join(ROOT, entry, "claimed"))) fail("RESTORE_FRESH_LEASE_REQUIRED");
      await immutable(join(ROOT, "restoring"), id);
      const restoreDir = join(ROOT, `restore-${id}`); await mkdir(restoreDir, { recursive: true, mode: 0o700 });
      if (await exists(join(restoreDir, "result.json"))) fail("RESTORE_ALREADY_COMPLETED");
      await immutable(join(restoreDir, `part-${argument}`), bytes);
    });
    console.log(JSON.stringify({ state: "stored", archiveSha256: id, chunk: Number(argument), sha256: sha(bytes) }));
  } else if (action === "restore") {
    if (!argument || !/^[1-9][0-9]{0,3}$/u.test(argument) || Number(argument) > MAX_RESTORE / CHUNK || data) fail("RESTORE_INVALID");
    const result = await controlled(async () => {
      if (await readFile(join(ROOT, "restoring"), "utf8") !== id || !await idle()) fail("RESTORE_FRESH_LEASE_REQUIRED");
      const restoreDir = join(ROOT, `restore-${id}`), resultPath = join(restoreDir, "result.json");
      if (await exists(resultPath)) return JSON.parse(await readFile(resultPath, "utf8"));
      // Exclusive dispatch fence also covers a crash while materializing files.
      // Retry observes only; it never resumes or rebuilds a partial workspace.
      await writeFile(join(restoreDir, "claimed"), id, { flag: "wx", mode: 0o600 });
      const bytes = Buffer.concat(await Promise.all(Array.from({ length: Number(argument) }, (_, index) => readFile(join(restoreDir, `part-${index}`)))));
      if (sha(bytes) !== id) fail("RESTORE_DIGEST_INVALID");
      const restored = parseRestore(bytes);
      const staging = `/workspace/restore-${id}`; await mkdir(staging, { mode: 0o755 });
      await mkdir(join(staging, "src")); await mkdir(join(staging, "dist"));
      for (const file of restored.source.files) await writeFile(join(staging, file.path), file.content, { flag: "wx", mode: 0o444 });
      for (const file of restored.artifact.files) {
        const path = join(staging, "dist", file.path); await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, Buffer.from(file.bytesBase64, "base64"), { flag: "wx", mode: 0o444 });
      }
      const actual = await collect(join(staging, "dist"));
      if (canonical(actual) !== canonical(restored.artifact.files)) fail("RESTORE_READBACK_MISMATCH");
      await protect(staging); await rename(staging, "/workspace/restored");
      const value = { state: "restored", archiveSha256: id, toolchainSha256: restored.toolchainSha256, sourceSha256: sha(canonical(restored.source.files)), artifactFilesSha256: sha(canonical(actual)), workspacePath: "/workspace/restored" };
      await immutable(resultPath, canonical(value));
      // Root receipt and restored files remain. No job was dispatched.
      for (let index = 0; index < Number(argument); index++) await rm(join(restoreDir, `part-${index}`));
      return value;
    });
    console.log(JSON.stringify(result));
  } else if (action === "restore-status") {
    if (argument || data) fail("RESTORE_STATUS_INVALID");
    const restoreDir = join(ROOT, `restore-${id}`), resultPath = join(restoreDir, "result.json");
    console.log(await exists(resultPath) ? await readFile(resultPath, "utf8") : JSON.stringify({ state: await exists(join(restoreDir, "claimed")) ? "pending" : "missing", archiveSha256: id }));
  } else if (action === "run") { if (argument || data) fail("JOB_RUN_INVALID"); await run(id, dir); }
  else fail("JOB_COMMAND_INVALID");
} catch (error) { console.error(error instanceof Error ? error.message : "JOB_FAILED"); process.exitCode = 1; }
