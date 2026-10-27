import { basename, resolve } from "node:path";
import { SourceBuiltCliSchema, verifyCandidateReviewReadiness } from "../src/promotion/candidate";
import { verifyNappletCliSourceBuildRecipe } from "./verify-napplet-cli-source-build";
import { parseSealedToolchainPolicy, type SealedToolchainPolicy } from "../src/runner/sealed-toolchain";

export type ToolchainImagePolicy = SealedToolchainPolicy;
export const parseToolchainImagePolicy = parseSealedToolchainPolicy;

export type ToolchainImageInputs = {
  readonly candidatePath: string;
  readonly policyPath: string;
  readonly dockerfilePath: string;
  readonly lockfilePath: string;
};

export type VerifiedToolchainImageInputs = {
  readonly candidateId: string;
  readonly lockfileSha256: string;
  readonly packages: readonly { readonly name: string; readonly version: string; readonly integrity: string }[];
  readonly dockerfile: string;
};

async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Bun.file(path).arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function packageIntegrity(lockfile: string, name: string): string | null {
  const start = lockfile.indexOf(`  '${name}@`);
  if (start === -1) return null;
  const nextPackage = lockfile.indexOf("\n  '", start + 1);
  const entry = lockfile.slice(start, nextPackage === -1 ? undefined : nextPackage);
  const match = entry.match(/resolution: \{integrity: (sha512-[^}]+)\}/);
  return match?.[1] ?? null;
}

/** Verifies source inputs without running Docker, a package resolver, or lifecycle scripts. */
export async function verifyToolchainImageInputs(inputs: ToolchainImageInputs): Promise<VerifiedToolchainImageInputs> {
  const [candidate, policy, dockerfile, lockfile] = await Promise.all([
    Bun.file(inputs.candidatePath).json(),
    Bun.file(inputs.policyPath).json(),
    Bun.file(inputs.dockerfilePath).text(),
    Bun.file(inputs.lockfilePath).text(),
  ]);
  const reviewed = await verifyCandidateReviewReadiness(candidate);
  if (reviewed.status !== "review_ready") throw new Error("candidate is not approved for sealed intake");
  const parsedPolicy = parseToolchainImagePolicy(policy);
  if (parsedPolicy.candidateId !== reviewed.candidateId) throw new Error("policy candidate ID does not match the reviewed candidate");
  const cli = reviewed.record.cli as { readonly distributionType?: unknown; readonly sourceCommit?: unknown; readonly sourceBuild?: unknown };
  // Release-asset provenance must never be reused to certify a distinct
  // locally built executable. Source intake is distinct from promotion.
  if (cli.distributionType !== "source-build" || cli.sourceCommit !== "976ad0549c38f93d4ed418d3ea59a615a7e5fd7f") {
    throw new Error("SOURCEBUILD_CANDIDATE_REQUIRED");
  }
  const source = SourceBuiltCliSchema.parse(cli.sourceBuild);
  const recipe = await verifyNappletCliSourceBuildRecipe(source.recipePath);
  if (await sha256File(source.recipePath) !== source.recipeSha256 || source.sourceLockSha256 !== recipe.sourceLockSha256 || source.runtimeVersion !== recipe.runtimeVersion || source.runtimeArchiveSha256 !== "394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2" || source.sourceArchiveSha256 !== "06d883bfecba2d62099063faa0a3df5197e79f79bdb0e3c90e2562011785ccba" || Object.entries(recipe.targets).some(([target, digest]) => source.executableSha256[target as keyof typeof source.executableSha256] !== digest)) throw new Error("SOURCEBUILD_CANDIDATE_BINDING_INVALID");
  const receiptPath = `toolchains/evidence/${source.buildReceiptSha256}.json`;
  if (await sha256File(receiptPath) !== source.buildReceiptSha256) throw new Error("SOURCEBUILD_RECEIPT_INVALID");
  const receipt = await Bun.file(receiptPath).json();
  if (receipt.status !== "reproducible-source-build-not-promoted" || receipt.source?.commit !== cli.sourceCommit || receipt.source?.lockSha256 !== source.sourceLockSha256 || receipt.runtime?.sha256 !== source.runtimeArchiveSha256 || receipt.normalization?.sourceDateEpoch !== source.sourceDateEpoch || !Array.isArray(receipt.targets) || receipt.targets.length !== 2 || Object.entries(source.executableSha256).some(([target, digest]) => receipt.targets.filter((row: { target?: unknown; sha256?: unknown }) => row.target === target && row.sha256 === digest).length !== 1)) throw new Error("SOURCEBUILD_RECEIPT_INVALID");
  const packages = reviewed.record.packages.map((pkg) => ({ name: String(pkg.name), version: String(pkg.version), integrity: String(pkg.integrity) }));
  for (const pkg of packages) {
    if (!lockfile.includes(`specifier: ${pkg.version}`) || packageIntegrity(lockfile, pkg.name) !== pkg.integrity) {
      throw new Error(`frozen lockfile does not contain the reviewed integrity for ${pkg.name}`);
    }
  }
  for (const required of [
    "FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
    "https://registry.npmjs.org/pnpm/-/pnpm-10.24.0.tgz",
    "sha512-Af+K5xtEGZA7ZcYPstydNM+LtuBtA73hEu8496NNaQTEJLpmvqXNzxKJAjC/OflYBHMUDtnJRv7zKLblI4o0Wg==",
    "pnpm fetch --frozen-lockfile --ignore-scripts",
    "pnpm install --frozen-lockfile --ignore-scripts",
    "COPY --from=intake /toolchain/node_modules /toolchain/node_modules",
    "/toolchain/bin/napplet-conformance",
    "infra/toolchain/denial-probe.ts /toolchain/bin/denial-probe",
    "FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS cli-source",
    "https://codeload.github.com/napplet/web/tar.gz/976ad0549c38f93d4ed418d3ea59a615a7e5fd7f",
    "914eb84228c77b83b040a23854cdf7b320f9fe4ba20a40dfff3c6ef3ff6bd9b8",
    "deno-",
    "--cached-only",
    "touch -h -d @1789254081",
    "ulimit -t 900",
    "54a3c5ac963b1eebe3a178a90f112f86bc3ed2914cde1632a60e89b4f2b5c524",
    "3573e8cda272806df011ab856357f5165a6719bb1daed8080227ee1083a112d3",
  ]) if (!dockerfile.includes(required)) throw new Error(`Dockerfile is missing required sealed input: ${required}`);
  if (/\bnpx\b/.test(dockerfile)) throw new Error("Dockerfile must not expose an npx resolver fallback");
  if (dockerfile.includes("releases/download/%40napplet/cli%400.5.2/napplet-linux-")) throw new Error("Dockerfile must not consume the recreated standalone CLI release asset");
  return { candidateId: reviewed.candidateId, lockfileSha256: await sha256File(inputs.lockfilePath), packages, dockerfile };
}

function parseArguments(args: readonly string[]): { readonly candidatePath: string; readonly verifyOnly: boolean } {
  const candidateIndex = args.indexOf("--candidate");
  const candidatePath = candidateIndex === -1 ? "toolchains/candidates/cli-0.5.2-source-build.json" : args[candidateIndex + 1];
  if (!candidatePath || candidatePath.startsWith("-")) throw new Error("--candidate requires a path");
  if (args.some((arg, index) => arg.startsWith("--") && arg !== "--candidate" && arg !== "--verify-only" && index !== candidateIndex + 1)) throw new Error("unknown image-build argument");
  return { candidatePath, verifyOnly: args.includes("--verify-only") };
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const candidate = await Bun.file(resolve(args.candidatePath)).json();
    const verified = await verifyToolchainImageInputs({
      candidatePath: resolve(args.candidatePath),
      policyPath: resolve(candidate.cli?.distributionType === "source-build" ? "infra/toolchain/source-build-egress-policy.json" : "infra/toolchain/egress-policy.json"),
      dockerfilePath: resolve("infra/toolchain/Dockerfile"),
      lockfilePath: resolve("toolchains/locks/initial/pnpm-lock.yaml"),
    });
    if (args.verifyOnly) console.log(JSON.stringify({ ...verified, dockerfile: basename("infra/toolchain/Dockerfile") }));
    else {
      const tag = `napplet-cvm/toolchain:${verified.candidateId}`;
      const child = Bun.spawn(["docker", "build", "--pull=false", "--provenance=false", "--file", "infra/toolchain/Dockerfile", "--tag", tag, "."], { stdout: "inherit", stderr: "inherit", stdin: "ignore", env: { PATH: process.env.PATH ?? "" } });
      if (await child.exited !== 0) throw new Error("sealed toolchain image build failed");
      const inspect = Bun.spawn(["docker", "image", "inspect", tag, "--format", "{{index .RepoDigests 0}}"], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { PATH: process.env.PATH ?? "" } });
      if (await inspect.exited !== 0) throw new Error("could not record immutable image digest");
      const image = (await new Response(inspect.stdout).text()).trim();
      if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("built image did not produce an immutable registry digest");
      console.log(JSON.stringify({ candidateId: verified.candidateId, image, lockfileSha256: verified.lockfileSha256 }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "toolchain image verification failed");
    process.exitCode = 1;
  }
}
