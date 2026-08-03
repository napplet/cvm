import { basename, resolve } from "node:path";
import { verifyCandidateReviewReadiness } from "../src/promotion/candidate";
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
  const cli = reviewed.record.cli as { readonly distribution?: unknown; readonly releaseAssetSha256?: unknown };
  if (typeof cli.distribution !== "string" || typeof cli.releaseAssetSha256 !== "string") throw new Error("reviewed candidate CLI release data is incomplete");
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
    "COPY --from=intake --chown=65532:65532 /toolchain/node_modules /toolchain/node_modules",
    "/toolchain/bin/napplet-conformance",
    "infra/toolchain/denial-probe.ts /toolchain/bin/denial-probe",
    cli.distribution,
    cli.releaseAssetSha256,
  ]) if (!dockerfile.includes(required)) throw new Error(`Dockerfile is missing required sealed input: ${required}`);
  if (/\bnpx\b/.test(dockerfile)) throw new Error("Dockerfile must not expose an npx resolver fallback");
  return { candidateId: reviewed.candidateId, lockfileSha256: await sha256File(inputs.lockfilePath), packages, dockerfile };
}

function parseArguments(args: readonly string[]): { readonly candidatePath: string; readonly verifyOnly: boolean } {
  const candidateIndex = args.indexOf("--candidate");
  const candidatePath = candidateIndex === -1 ? "toolchains/candidates/initial.json" : args[candidateIndex + 1];
  if (!candidatePath || candidatePath.startsWith("-")) throw new Error("--candidate requires a path");
  if (args.some((arg, index) => arg.startsWith("--") && arg !== "--candidate" && arg !== "--verify-only" && index !== candidateIndex + 1)) throw new Error("unknown image-build argument");
  return { candidatePath, verifyOnly: args.includes("--verify-only") };
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const verified = await verifyToolchainImageInputs({
      candidatePath: resolve(args.candidatePath),
      policyPath: resolve("infra/toolchain/egress-policy.json"),
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
