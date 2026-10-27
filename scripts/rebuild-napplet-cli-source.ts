import { basename, isAbsolute, join, resolve } from "node:path";

const SOURCE_REPOSITORY = "https://github.com/napplet/web.git";
const SOURCE_COMMIT = "976ad0549c38f93d4ed418d3ea59a615a7e5fd7f";
const SOURCE_LOCK_SHA256 = "914eb84228c77b83b040a23854cdf7b320f9fe4ba20a40dfff3c6ef3ff6bd9b8";
const DENO_VERSION = "2.9.6";
const DENO_ASSET_URL = "https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-unknown-linux-gnu.zip";
const DENO_ASSET_SHA256 = "394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2";
const SOURCE_DATE_EPOCH = "1789254081";
const BUILD_IMAGE = "debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587";
const PROBE_IMAGE = "oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const TARGETS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"] as const;
const COMMAND_TIMEOUT_MS = 15 * 60_000;

type Target = (typeof TARGETS)[number];
type CommandResult = Readonly<{ argv: readonly string[]; exitCode: number; stdout: string; stderr: string }>;

function usage(): never {
  throw new Error("Usage: bun scripts/rebuild-napplet-cli-source.ts --output /absolute/empty/directory");
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function run(argv: readonly string[], options: Readonly<{ cwd?: string; env?: Record<string, string | undefined> }> = {}): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env === undefined ? undefined : { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error(`command timed out after ${COMMAND_TIMEOUT_MS}ms: ${argv[0]}`)); }, COMMAND_TIMEOUT_MS); }),
    ]);
    return Object.freeze({ argv, exitCode: result[0], stdout: result[1], stderr: result[2] });
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

async function requireSuccess(argv: readonly string[], options: Readonly<{ cwd?: string; env?: Record<string, string | undefined> }> = {}): Promise<CommandResult> {
  const result = await run(argv, options);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${result.exitCode})\n${result.stderr}`);
  return result;
}

async function writeLog(path: string, result: CommandResult): Promise<void> {
  await Bun.write(path, `$ ${result.argv.join(" ")}\n\n[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}`);
}

async function digestFile(path: string): Promise<string> {
  return sha256(await Bun.file(path).arrayBuffer());
}

async function ensureEmptyDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("--output must be an absolute path");
  const directory = Bun.file(path);
  if (await directory.exists()) {
    const entries = [...new Bun.Glob("*").scanSync({ cwd: path, onlyFiles: false })];
    if (entries.length > 0) throw new Error(`Refusing to reuse non-empty output directory: ${path}`);
  } else {
    await Bun.$`mkdir -p ${path}`.quiet();
  }
}

function buildCommand(target: Target, output: string, cachedOnly: boolean): readonly string[] {
  return [
    "/runtime/deno", "compile", "--frozen", ...(cachedOnly ? ["--cached-only"] : []), "--no-check", "--node-modules-dir=none",
    "--allow-read", "--allow-write", "--allow-run", "--allow-env", "--allow-net", "--target", target, "--output", output, "src/standalone.ts",
  ];
}

function dockerCommand(source: string, cache: string, runtime: string, output: string, command: readonly string[], normalize = false): readonly string[] {
  const script = normalize
    ? `set -eu; find /src /cache -exec touch -h -d @${SOURCE_DATE_EPOCH} {} +; exec "$@"`
    : "set -eu; exec \"$@\"";
  return [
    "docker", "run", "--platform", "linux/amd64", "--rm",
    "-e", "DENO_DIR=/cache", "-e", `SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}`, "-e", "TZ=UTC", "-e", "LC_ALL=C", "-e", "LANG=C", "-e", "HOME=/home/deno",
    "-v", `${source}:/src`, "-v", `${cache}:/cache`, "-v", `${runtime}:/runtime:ro`, "-v", `${output}:/out`, "-w", "/src/packages/cli",
    BUILD_IMAGE, "sh", "-ec", script, "rebuild-napplet-cli", ...command,
  ];
}

async function sourceCheckout(root: string, name: string): Promise<string> {
  const checkout = join(root, name, "source");
  await requireSuccess(["git", "clone", "--quiet", "--no-checkout", SOURCE_REPOSITORY, checkout]);
  await requireSuccess(["git", "-C", checkout, "checkout", "--quiet", "--detach", SOURCE_COMMIT]);
  const revision = (await requireSuccess(["git", "-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
  if (revision !== SOURCE_COMMIT) throw new Error(`source checkout resolved ${revision}, expected ${SOURCE_COMMIT}`);
  if (await digestFile(join(checkout, "deno.lock")) !== SOURCE_LOCK_SHA256) throw new Error("source deno.lock digest mismatch");
  return checkout;
}

async function seedAndBuild(root: string, name: string, target: Target, runtime: string): Promise<Readonly<{ source: string; artifact: string; seedLog: string; buildLog: string }>> {
  const buildRoot = join(root, name);
  const source = await sourceCheckout(root, name);
  const cache = join(buildRoot, "cache");
  const seedOutput = join(buildRoot, "seed");
  const finalOutput = join(buildRoot, "artifact");
  await requireSuccess(["mkdir", "-p", cache, seedOutput, finalOutput]);

  const cacheResult = await requireSuccess(dockerCommand(source, cache, runtime, seedOutput, ["/runtime/deno", "cache", "--frozen", "--node-modules-dir=none", "src/standalone.ts"]));
  const seedResult = await requireSuccess(dockerCommand(source, cache, runtime, seedOutput, buildCommand(target, "/out/seed", false)));
  const finalResult = await requireSuccess(dockerCommand(source, cache, runtime, finalOutput, buildCommand(target, "/out/napplet", true), true));
  const seedLog = join(buildRoot, "seed.log");
  const buildLog = join(buildRoot, "build.log");
  await writeLog(seedLog, Object.freeze({ argv: [...cacheResult.argv, "&&", ...seedResult.argv], exitCode: 0, stdout: `${cacheResult.stdout}${seedResult.stdout}`, stderr: `${cacheResult.stderr}${seedResult.stderr}` }));
  await writeLog(buildLog, finalResult);
  return Object.freeze({ source, artifact: join(finalOutput, "napplet"), seedLog, buildLog });
}

async function probeArtifact(artifact: string, target: Target): Promise<Record<string, unknown>> {
  const platform = target.startsWith("aarch64") ? "linux/arm64" : "linux/amd64";
  const probe = async (name: string) => {
    const result = await run(["docker", "run", "--platform", platform, "--rm", "--entrypoint", "/out/napplet", "-v", `${artifact}:/out/napplet:ro`, PROBE_IMAGE, name]);
    return Object.freeze({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  };
  const [help, version, guide] = await Promise.all([probe("--help"), probe("--version"), probe("guide")]);
  if (help.exitCode !== 0 || !help.stdout.includes("Usage:")) throw new Error(`${target} --help probe failed`);
  if (guide.exitCode !== 0 || !guide.stdout.includes("Napplet Guide")) throw new Error(`${target} guide probe failed`);
  // CLI 0.5.2 has no --version command; retaining this probe makes that contract explicit.
  if (version.exitCode !== 2 || !version.stderr.includes("Unknown command: --version")) throw new Error(`${target} --version contract changed unexpectedly`);
  return Object.freeze({ help, version, guide });
}

function parseOutputPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--output") usage();
  return resolve(argv[1]);
}

async function main(): Promise<void> {
  const output = parseOutputPath(process.argv.slice(2));
  await ensureEmptyDirectory(output);
  const runtime = join(output, "runtime");
  await requireSuccess(["mkdir", "-p", runtime]);
  const archive = join(output, basename(new URL(DENO_ASSET_URL).pathname));
  const response = await fetch(DENO_ASSET_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Deno runtime download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== DENO_ASSET_SHA256) throw new Error("Deno runtime digest mismatch");
  await Bun.write(archive, bytes);
  await requireSuccess(["unzip", "-q", archive, "-d", runtime]);
  const denoVersion = (await requireSuccess(["docker", "run", "--platform", "linux/amd64", "--rm", "-v", `${runtime}:/runtime:ro`, BUILD_IMAGE, "/runtime/deno", "--version"])).stdout;
  if (!denoVersion.startsWith(`deno ${DENO_VERSION} `)) throw new Error(`unexpected Deno version: ${denoVersion}`);

  const targets = [] as Array<Record<string, unknown>>;
  for (const target of TARGETS) {
    // Four simultaneous Deno compiles can exhaust a constrained Docker Desktop
    // VM. Sequential clean builds keep this reproducibility proof usable on the
    // supported local worker development hosts.
    const first = await seedAndBuild(output, `${target}-one`, target, runtime);
    const second = await seedAndBuild(output, `${target}-two`, target, runtime);
    const [firstDigest, secondDigest] = await Promise.all([digestFile(first.artifact), digestFile(second.artifact)]);
    if (firstDigest !== secondDigest) throw new Error(`${target} clean builds are not byte-identical: ${firstDigest} != ${secondDigest}`);
    targets.push(Object.freeze({ target, sha256: firstDigest, artifact: first.artifact, secondArtifact: second.artifact, sourceCheckouts: [first.source, second.source], seedLogs: [first.seedLog, second.seedLog], buildLogs: [first.buildLog, second.buildLog], probes: await probeArtifact(first.artifact, target) }));
  }
  const receipt = Object.freeze({
    schemaVersion: 1,
    status: "reproducible-source-build-not-promoted",
    source: Object.freeze({ repository: SOURCE_REPOSITORY, commit: SOURCE_COMMIT, lockFile: "deno.lock", lockSha256: SOURCE_LOCK_SHA256 }),
    runtime: Object.freeze({ version: DENO_VERSION, url: DENO_ASSET_URL, sha256: DENO_ASSET_SHA256, archive }),
    normalization: Object.freeze({ sourceDateEpoch: Number(SOURCE_DATE_EPOCH), procedure: "seed frozen cache and target runtime, normalize every source/cache mtime, then compile frozen cached-only at fixed /src, /cache, and /out paths" }),
    images: Object.freeze({ build: BUILD_IMAGE, probe: PROBE_IMAGE }),
    targets,
    promotion: Object.freeze({ candidate: null, selected: false, protectedEvidence: null, note: "This is local reproducibility evidence only. It neither promotes a candidate nor identifies the recreated upstream release asset." }),
  });
  await Bun.write(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
