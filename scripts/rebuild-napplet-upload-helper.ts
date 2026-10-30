import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// A source helper is distinct from both historical and source-built standalone
// CLI binaries. Never rewrite their provenance when rebuilding this module.
const profiles = {
  legacy: { source: "976ad0549c38f93d4ed418d3ea59a615a7e5fd7f", lock: "914eb84228c77b83b040a23854cdf7b320f9fe4ba20a40dfff3c6ef3ff6bd9b8", expected: "cb7ce3b6ce6a4dccd09d7234c7c4dcd073533752e2093b01405aefe981326c2e", overlay: null },
  capabilities: { source: "3c6e3ae33fea425b2f151740c0bd8c02f509ef7b", lock: "7b08677e37bbfedfde17343a3612d223a547b8bf058df7e6c9c73881f9e7c0eb", expected: "2e50a73810bf8017b9569dd771842326b8ecc254dd912e92aaf9a43ab3a1a756", overlay: "363cebbc9a8ca0cf5ef7cc7c81ccf2f598bb49ef0dfb6ae696b4a529cdc6f06d" },
};
const IMAGE = "debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587";
const DENO_BINARY = "bceb5b6a6239b0b010418406d8c77a508f67cf4337d94288f1c19fe71304aab0";
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function run(argv: string[]) {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }); const timer = setTimeout(() => process.kill(), 180_000);
  try { const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]); if (code) throw new Error(stderr.slice(-4000)); return stdout.trim(); }
  finally { clearTimeout(timer); }
}
const args = Bun.argv.slice(2);
const profileName = args[0] === "--profile" ? args.splice(0, 2)[1] : "legacy";
if (profileName !== "legacy" && profileName !== "capabilities") throw new Error("UPLOAD_BUILD_PROFILE_INVALID");
const profile = profiles[profileName];
const [checkoutRaw, runtimeRaw, outputRaw] = args;
if (!checkoutRaw || !runtimeRaw || !outputRaw || args.length !== 3) throw new Error("Usage: bun scripts/rebuild-napplet-upload-helper.ts [--profile legacy|capabilities] <verified-source-checkout> <directory-containing-deno-2.9.6> <new-output-directory>");
const checkout = resolve(checkoutRaw), runtime = resolve(runtimeRaw), output = resolve(outputRaw);
if (hash(await readFile(join(runtime, "deno"))) !== DENO_BINARY) throw new Error("UPLOAD_BUILD_RUNTIME_MISMATCH");
if (await run(["git", "-C", checkout, "rev-parse", "HEAD"]) !== profile.source || await run(["git", "-C", checkout, "status", "--porcelain", "--untracked-files=no"]) || hash(await readFile(join(checkout, "deno.lock"))) !== profile.lock) throw new Error("UPLOAD_SOURCE_CHECKOUT_MISMATCH");
await mkdir(output, { recursive: false }); await mkdir(join(output, "cache")); await mkdir(join(output, "out"));
await writeFile(join(output, "out/entry.ts"), `export { ${profileName === "capabilities" ? "createUploadAuthorization, " : ""}uploadFilesToServers, publishEventWithSimplePool } from "/src/packages/cli/src/deploy-network.ts";\n`);
if (profile.overlay) {
  const overlay = await readFile(new URL("../toolchains/locks/capabilities-cli/deno.lock", import.meta.url));
  if (hash(overlay) !== profile.overlay) throw new Error("UPLOAD_BUILD_LOCK_MISMATCH");
  await writeFile(join(output, "out/deno.lock"), overlay);
}
const docker = ["docker", "run", "--rm", "--platform", "linux/amd64", "-e", "DENO_DIR=/cache", "-v", `${checkout}:/src:ro`, "-v", `${runtime}:/runtime:ro`, "-v", `${join(output, "cache")}:/cache`, "-v", `${join(output, "out")}:/out`, "-w", "/src/packages/cli"];
const version = await run([...docker, IMAGE, "/runtime/deno", "--version"]); if (!version.startsWith("deno 2.9.6 ")) throw new Error("UPLOAD_BUILD_RUNTIME_MISMATCH");
for (const iteration of ["one", "two"]) {
  await run([...docker, ...(iteration === "two" ? ["--network", "none"] : []), IMAGE, "/runtime/deno", "bundle", "--frozen", ...(profile.overlay ? ["--lock", "/out/deno.lock"] : []), "--node-modules-dir=none", "--config", "/src/packages/cli/deno.json", "--platform", "browser", "--format", "esm", "--output", `/out/${iteration}.mjs`, "/out/entry.ts"]);
  if (hash(await readFile(join(output, "out", `${iteration}.mjs`))) !== profile.expected) throw new Error("UPLOAD_BUNDLE_REPRODUCTION_MISMATCH");
}
const actual = hash(await readFile(join(output, "out/one.mjs")));
if (actual !== hash(await readFile(join(output, "out/two.mjs")))) throw new Error("UPLOAD_BUNDLE_REPRODUCTION_MISMATCH");
await copyFile(join(output, "out/one.mjs"), join(output, "network-helpers.mjs"));
console.log(JSON.stringify({ sourceCommit: profile.source, lockSha256: profile.lock, buildLockSha256: profile.overlay ?? profile.lock, bundleSha256: actual, reviewedOutput: Boolean(profile.expected), copies: 2, secondBuildNetwork: "none", output: join(output, "network-helpers.mjs"), productionEvidence: false }));
