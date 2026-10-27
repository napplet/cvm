import { resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/iu;
const REVISION = /^[a-f0-9]{40}$/iu;
const EXPECTED = Object.freeze({
  commit: "976ad0549c38f93d4ed418d3ea59a615a7e5fd7f",
  lock: "914eb84228c77b83b040a23854cdf7b320f9fe4ba20a40dfff3c6ef3ff6bd9b8",
  deno: "394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2",
  release: "a17fd2f61beb3b1553518b517045c4e1a474ddee5db87be80e18cf1bd24d8e28",
});

function mustDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${field} must be a SHA-256 digest`);
  return value.toLowerCase();
}

/** Validates the non-promoted source-build receipt.  It intentionally does not
 * contact a registry, mutate a candidate, or equate a local build to a release
 * asset.  The documented recipe is the only permitted route to regenerate it. */
export async function verifyNappletCliSourceBuildReceipt(path = "toolchains/recipes/napplet-cli-0.5.2-source-build.json") {
  const receipt = await Bun.file(resolve(path)).json() as Record<string, any>;
  if (receipt.schemaVersion !== 1 || receipt.status !== "local-source-build-evidence-not-promoted") throw new Error("source-build receipt status is invalid");
  const upstream = receipt.upstream as Record<string, unknown>;
  const runtime = receipt.runtime as Record<string, unknown>;
  const build = receipt.build as Record<string, unknown>;
  const comparison = receipt.comparison as Record<string, unknown>;
  const promotion = receipt.promotion as Record<string, unknown>;
  if (typeof upstream?.repository !== "string" || upstream.repository !== "https://github.com/napplet/web.git" || typeof upstream.commit !== "string" || !REVISION.test(upstream.commit) || upstream.commit !== EXPECTED.commit) throw new Error("source repository binding is invalid");
  if (mustDigest(upstream.sourceLockSha256, "source lock") !== EXPECTED.lock) throw new Error("source lock binding is invalid");
  if (runtime.version !== "2.9.6" || typeof runtime.hostAsset !== "string" || !runtime.hostAsset.startsWith("https://github.com/denoland/deno/releases/download/v2.9.6/") || mustDigest(runtime.hostAssetSha256, "Deno runtime") !== EXPECTED.deno) throw new Error("Deno runtime binding is invalid");
  const output = mustDigest(build.observedOutputSha256, "source build output");
  if (typeof build.command !== "string" || !build.command.includes("--frozen") || !build.command.includes("x86_64-unknown-linux-gnu")) throw new Error("source build command is not frozen and target-pinned");
  if (mustDigest(comparison.republishedReleaseAssetSha256, "release asset") !== EXPECTED.release || comparison.matchesRepublishedReleaseAsset !== false || output === EXPECTED.release) throw new Error("source build must not be misrepresented as the republished release asset");
  if (promotion.candidate !== null || promotion.selected !== false || promotion.protectedEvidence !== null || !Array.isArray(promotion.blockers) || promotion.blockers.length < 1) throw new Error("source build receipt must remain unpromoted");
  return Object.freeze({ sourceCommit: upstream.commit, sourceLockSha256: EXPECTED.lock, runtimeVersion: runtime.version, outputSha256: output, status: receipt.status });
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await verifyNappletCliSourceBuildReceipt())); }
  catch (error) { console.error(error instanceof Error ? error.message : "source-build receipt invalid"); process.exitCode = 1; }
}
