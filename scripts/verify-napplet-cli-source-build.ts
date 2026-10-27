import { dirname, join, resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/iu;
const REVISION = /^[a-f0-9]{40}$/iu;
const EXPECTED = Object.freeze({
  commit: "976ad0549c38f93d4ed418d3ea59a615a7e5fd7f",
  lock: "914eb84228c77b83b040a23854cdf7b320f9fe4ba20a40dfff3c6ef3ff6bd9b8",
  deno: "394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2",
  release: "a17fd2f61beb3b1553518b517045c4e1a474ddee5db87be80e18cf1bd24d8e28",
  targets: Object.freeze({
    "x86_64-unknown-linux-gnu": "54a3c5ac963b1eebe3a178a90f112f86bc3ed2914cde1632a60e89b4f2b5c524",
    "aarch64-unknown-linux-gnu": "3573e8cda272806df011ab856357f5165a6719bb1daed8080227ee1083a112d3",
  }),
});

function mustObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function mustDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${field} must be a SHA-256 digest`);
  return value.toLowerCase();
}

async function digestFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`missing required file: ${path}`);
  return new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex");
}

async function command(argv: readonly string[]): Promise<string> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

/** Validates the committed recipe's immutable inputs. It does not create,
 * select, or promote a candidate. Pass a generated receipt to additionally
 * re-hash the real source, runtime, artifacts, and retained command logs. */
export async function verifyNappletCliSourceBuildRecipe(path = "toolchains/recipes/napplet-cli-0.5.2-source-build.json") {
  const recipe = mustObject(await Bun.file(resolve(path)).json(), "recipe");
  if (recipe.schemaVersion !== 2 || recipe.status !== "reproducible-source-build-recipe-not-promoted") throw new Error("source-build recipe status is invalid");
  const upstream = mustObject(recipe.upstream, "upstream");
  const runtime = mustObject(recipe.runtime, "runtime");
  const build = mustObject(recipe.build, "build");
  const comparison = mustObject(recipe.comparison, "comparison");
  const promotion = mustObject(recipe.promotion, "promotion");
  if (upstream.repository !== "https://github.com/napplet/web.git" || typeof upstream.commit !== "string" || !REVISION.test(upstream.commit) || upstream.commit !== EXPECTED.commit) throw new Error("source repository binding is invalid");
  if (mustDigest(upstream.sourceLockSha256, "source lock") !== EXPECTED.lock) throw new Error("source lock binding is invalid");
  if (runtime.version !== "2.9.6" || typeof runtime.hostAsset !== "string" || !runtime.hostAsset.startsWith("https://github.com/denoland/deno/releases/download/v2.9.6/") || mustDigest(runtime.hostAssetSha256, "Deno runtime") !== EXPECTED.deno) throw new Error("Deno runtime binding is invalid");
  if (typeof build.recipe !== "string" || !build.recipe.includes("rebuild-napplet-cli-source.ts") || build.sourceDateEpoch !== 1789254081) throw new Error("source-build recipe is not normalized and executable");
  const targets = mustObject(build.targets, "build targets");
  for (const [target, digest] of Object.entries(EXPECTED.targets)) if (mustDigest(targets[target], `${target} recipe digest`) !== digest) throw new Error(`${target} recipe digest is invalid`);
  if (mustDigest(comparison.republishedReleaseAssetSha256, "release asset") !== EXPECTED.release || comparison.matchesRepublishedReleaseAsset !== false) throw new Error("source build must not be misrepresented as the republished release asset");
  if (promotion.candidate !== null || promotion.selected !== false || promotion.protectedEvidence !== null || !Array.isArray(promotion.blockers) || promotion.blockers.length < 1) throw new Error("source build recipe must remain unpromoted");
  return Object.freeze({ sourceCommit: upstream.commit, sourceLockSha256: EXPECTED.lock, runtimeVersion: runtime.version, targets: EXPECTED.targets, status: recipe.status });
}

export async function verifyGeneratedSourceBuildReceipt(path: string) {
  const receipt = mustObject(await Bun.file(resolve(path)).json(), "receipt");
  if (receipt.schemaVersion !== 1 || receipt.status !== "reproducible-source-build-not-promoted") throw new Error("generated receipt is not a non-promoted reproducible build");
  const source = mustObject(receipt.source, "receipt source");
  const runtime = mustObject(receipt.runtime, "receipt runtime");
  if (source.repository !== "https://github.com/napplet/web.git" || source.commit !== EXPECTED.commit || source.lockSha256 !== EXPECTED.lock) throw new Error("generated source binding is invalid");
  if (runtime.version !== "2.9.6" || runtime.sha256 !== EXPECTED.deno || typeof runtime.archive !== "string" || await digestFile(runtime.archive) !== EXPECTED.deno) throw new Error("generated runtime binding is invalid");
  if (!Array.isArray(receipt.targets) || receipt.targets.length !== Object.keys(EXPECTED.targets).length) throw new Error("generated receipt target set is invalid");
  for (const rawTarget of receipt.targets) {
    const target = mustObject(rawTarget, "generated target");
    if (typeof target.target !== "string" || !(target.target in EXPECTED.targets)) throw new Error("unexpected generated target");
    const expectedDigest = EXPECTED.targets[target.target as keyof typeof EXPECTED.targets];
    if (target.sha256 !== expectedDigest || typeof target.artifact !== "string" || typeof target.secondArtifact !== "string") throw new Error(`${target.target} digest or artifact path is invalid`);
    const [firstDigest, secondDigest] = await Promise.all([digestFile(target.artifact), digestFile(target.secondArtifact)]);
    if (firstDigest !== expectedDigest || secondDigest !== expectedDigest) throw new Error(`${target.target} artifacts do not match the verified source-build digest`);
    // The recipe lays each source checkout beside its artifact directory. Derive
    // rather than trust receipt-provided source paths, then verify the actual
    // Git revision and lock bytes on disk.
    for (const artifact of [target.artifact, target.secondArtifact]) {
      const checkout = join(dirname(dirname(artifact)), "source");
      if (await command(["git", "-C", checkout, "rev-parse", "HEAD"]) !== EXPECTED.commit) throw new Error(`${target.target} source commit changed`);
      if (await digestFile(`${checkout}/deno.lock`) !== EXPECTED.lock) throw new Error(`${target.target} source lock changed`);
    }
    for (const log of [...(target.seedLogs as unknown[] ?? []), ...(target.buildLogs as unknown[] ?? [])]) {
      if (typeof log !== "string" || !await Bun.file(log).exists()) throw new Error(`${target.target} retained build log is missing`);
    }
    const probes = mustObject(target.probes, `${target.target} probes`);
    const help = mustObject(probes.help, `${target.target} help probe`);
    const guide = mustObject(probes.guide, `${target.target} guide probe`);
    const version = mustObject(probes.version, `${target.target} version probe`);
    if (help.exitCode !== 0 || typeof help.stdout !== "string" || !help.stdout.includes("Usage:") || guide.exitCode !== 0 || typeof guide.stdout !== "string" || !guide.stdout.includes("Napplet Guide") || version.exitCode !== 2 || typeof version.stderr !== "string" || !version.stderr.includes("Unknown command: --version")) throw new Error(`${target.target} CLI probes are incomplete`);
  }
  return Object.freeze({ status: receipt.status, targets: receipt.targets.map((item) => mustObject(item, "target").target) });
}

if (import.meta.main) {
  try {
    const recipe = await verifyNappletCliSourceBuildRecipe();
    const receiptFlag = process.argv.slice(2);
    const receipt = receiptFlag.length === 0 ? undefined : receiptFlag.length === 2 && receiptFlag[0] === "--receipt" ? await verifyGeneratedSourceBuildReceipt(receiptFlag[1]) : (() => { throw new Error("Usage: bun scripts/verify-napplet-cli-source-build.ts [--receipt /absolute/receipt.json]"); })();
    console.log(JSON.stringify({ recipe, receipt }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "source-build verification failed");
    process.exitCode = 1;
  }
}
