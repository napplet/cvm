import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../src/promotion/schema";

const RECIPE = "toolchains/recipes/napplet-cli-0.13.0-capabilities-source-build.json";
const RECIPE_DIGEST = "67ef000cdf7c52a952d5b29f92e47c519ca76aa35ae7c4c4009006d950dc8bbc";
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Recipe = z.object({
  schemaVersion: z.literal(3), status: z.literal("reproducible-source-build-recipe-not-promoted"), profileName: z.literal("capabilities-0.13.0"),
  upstream: z.object({ repository: z.string(), commit: z.string(), version: z.string(), sourceLockSha256: Digest }).passthrough(),
  lockOverlay: z.object({ path: z.string(), sha256: Digest }).passthrough(),
  runtime: z.object({ version: z.string(), url: z.string(), sha256: Digest }).strict(),
  build: z.object({ script: z.string(), scriptSha256: Digest, image: z.string(), probeImage: z.string(), sourceDateEpoch: z.number().int(), targets: z.record(z.string(), Digest) }).strict(),
  promotion: z.object({ candidate: z.null(), selected: z.literal(false), protectedEvidence: z.null(), blockers: z.array(z.string()) }).strict(),
}).strict();
const Probe = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() }).strict();
const Receipt = z.object({
  schemaVersion: z.literal(1), profileName: z.literal("capabilities-0.13.0"), status: z.literal("reproducible-source-build-not-promoted"),
  harnessSha256: Digest,
  source: z.object({ repository: z.string(), commit: z.string(), lockFile: z.literal("deno.lock"), lockSha256: Digest, buildLockSha256: Digest, lockOverlay: z.string() }).strict(),
  runtime: z.object({ version: z.string(), url: z.string(), sha256: Digest, archive: z.string() }).strict(),
  normalization: z.object({ sourceDateEpoch: z.number().int(), procedure: z.string() }).strict(),
  images: z.object({ build: z.string(), probe: z.string() }).strict(),
  targets: z.array(z.object({ target: z.string(), sha256: Digest, artifact: z.string(), secondArtifact: z.string(), sourceCheckouts: z.array(z.string()).length(2), seedLogs: z.array(z.string()).length(2), buildLogs: z.array(z.string()).length(2), probes: z.object({ help: Probe, version: Probe, guide: Probe }).strict() }).strict()).length(2),
  promotion: z.object({ candidate: z.null(), selected: z.literal(false), protectedEvidence: z.null(), note: z.string() }).strict(),
}).strict();
const sha = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
async function fileDigest(path: string) {
  const file = Bun.file(path);
  if (!await file.exists() || file.size > 300 * 1024 * 1024) throw new Error("CAPABILITY_BUILD_FILE_INVALID");
  return sha(new Uint8Array(await file.arrayBuffer()));
}
async function git(source: string, ...args: string[]) {
  const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", source, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
  if (status) throw new Error(`CAPABILITY_BUILD_SOURCE_INVALID:${stderr.slice(0, 300)}`);
  return new Uint8Array(stdout);
}
/** An intake verifier only: neither a candidate selector nor release evidence. */
export async function verifyCapabilityCliSourceRecipe(path = RECIPE) {
  const file = Bun.file(path); if (file.size > 65_536) throw new Error("CAPABILITY_BUILD_RECIPE_INVALID");
  const raw = await file.json();
  if (sha(canonicalJson(raw)) !== RECIPE_DIGEST) throw new Error("CAPABILITY_BUILD_RECIPE_CHANGED");
  const recipe = Recipe.parse(raw);
  for (const [path, digest] of [[recipe.build.script, recipe.build.scriptSha256], [recipe.lockOverlay.path, recipe.lockOverlay.sha256]]) if (await fileDigest(path!) !== digest) throw new Error("CAPABILITY_BUILD_INPUT_CHANGED");
  return recipe;
}
export async function verifyCapabilityCliSourceReceipt(path: string) {
  const recipe = await verifyCapabilityCliSourceRecipe();
  const file = Bun.file(path); if (file.size > 1_048_576) throw new Error("CAPABILITY_BUILD_RECEIPT_INVALID");
  const receipt = Receipt.parse(await file.json());
  const expectedSource = { repository: recipe.upstream.repository, commit: recipe.upstream.commit, lockFile: "deno.lock", lockSha256: recipe.upstream.sourceLockSha256, buildLockSha256: recipe.lockOverlay.sha256, lockOverlay: recipe.lockOverlay.path };
  if (receipt.harnessSha256 !== recipe.build.scriptSha256 || canonicalJson(receipt.source) !== canonicalJson(expectedSource) || receipt.normalization.sourceDateEpoch !== recipe.build.sourceDateEpoch || receipt.images.build !== recipe.build.image || receipt.images.probe !== recipe.build.probeImage || receipt.runtime.version !== recipe.runtime.version || receipt.runtime.url !== recipe.runtime.url || receipt.runtime.sha256 !== recipe.runtime.sha256 || await fileDigest(receipt.runtime.archive) !== recipe.runtime.sha256) throw new Error("CAPABILITY_BUILD_RECEIPT_BINDING_INVALID");
  if (new Set(receipt.targets.map(target => target.target)).size !== 2 || receipt.targets.some(target => recipe.build.targets[target.target] !== target.sha256)) throw new Error("CAPABILITY_BUILD_TARGET_SET_INVALID");
  for (const target of receipt.targets) {
    for (const [index, artifact] of [target.artifact, target.secondArtifact].entries()) {
      if (await fileDigest(artifact) !== target.sha256) throw new Error("CAPABILITY_BUILD_EXECUTABLE_CHANGED");
      const source = join(dirname(dirname(artifact)), "source");
      if (resolve(source) !== resolve(target.sourceCheckouts[index]!)) throw new Error("CAPABILITY_BUILD_SOURCE_INVALID");
      if (Buffer.from(await git(source, "rev-parse", "HEAD")).toString().trim() !== recipe.upstream.commit || sha(await git(source, "show", "HEAD:deno.lock")) !== recipe.upstream.sourceLockSha256 || await fileDigest(join(source, "deno.lock")) !== recipe.lockOverlay.sha256) throw new Error("CAPABILITY_BUILD_SOURCE_CHANGED");
      if (Buffer.from(await git(source, "status", "--porcelain", "--untracked-files=all")).toString().trim() !== "M deno.lock") throw new Error("CAPABILITY_BUILD_UNREVIEWED_SOURCE_CHANGE");
    }
    for (const path of [...target.seedLogs, ...target.buildLogs]) if (!await Bun.file(path).exists()) throw new Error("CAPABILITY_BUILD_LOG_MISSING");
    const { help, version, guide } = target.probes;
    if (help.exitCode !== 0 || !help.stdout.includes("Usage:") || guide.exitCode !== 0 || !guide.stdout.includes("Napplet Guide") || version.exitCode !== 0 || version.stdout.trim() !== `napplet ${recipe.upstream.version}`) throw new Error("CAPABILITY_BUILD_PROBE_FAILED");
  }
  return Object.freeze({ status: receipt.status, selected: false, targets: receipt.targets.map(({ target, sha256 }) => ({ target, sha256 })) });
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) console.log(JSON.stringify({ status: (await verifyCapabilityCliSourceRecipe()).status, selected: false }));
    else if (args.length === 2 && args[0] === "--receipt") console.log(JSON.stringify(await verifyCapabilityCliSourceReceipt(args[1]!)));
    else throw new Error("Usage: bun scripts/verify-capability-cli-source-build.ts [--receipt /absolute/receipt.json]");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
