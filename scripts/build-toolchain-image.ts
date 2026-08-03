import { basename, resolve } from "node:path";
import { verifyCandidateReviewReadiness } from "../src/promotion/candidate";

type JsonRecord = Record<string, unknown>;

export type ToolchainImagePolicy = {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly runtime: "docker";
  readonly network: "none";
  readonly readOnlyRootFilesystem: true;
  readonly capDrop: readonly ["ALL"];
  readonly securityOpt: readonly ["no-new-privileges"];
  readonly user: "65532:65532";
  readonly tmpfs: readonly [string, string];
  readonly resources: { readonly pids: 64; readonly memory: "2g"; readonly cpus: "2"; readonly timeoutMs: 60000; readonly outputLimitBytes: 65536 };
  readonly environment: { readonly CI: "1"; readonly HOME: "/home/napplet" };
  readonly inputMount: { readonly destination: "/input"; readonly readOnly: true };
  readonly entrypoint: "/toolchain/bin/bun";
};

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

const SHA256 = /^[a-f0-9]{64}$/;
const POLICY_KEYS = new Set([
  "schemaVersion", "candidateId", "runtime", "network", "readOnlyRootFilesystem", "capDrop", "securityOpt", "user", "tmpfs", "resources", "environment", "inputMount", "entrypoint",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExact<T>(actual: unknown, expected: T, label: string): T {
  if (actual !== expected) throw new Error(`${label} must be ${String(expected)}`);
  return expected;
}

function requireExactArray<T>(actual: unknown, expected: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error(`${label} must be exactly ${expected.join(", ")}`);
  }
  return expected;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

/** Parses the static image policy before any image materialization can begin. */
export function parseToolchainImagePolicy(value: unknown): ToolchainImagePolicy {
  const policy = requireRecord(value, "policy");
  for (const key of Object.keys(policy)) if (!POLICY_KEYS.has(key)) throw new Error(`policy has unknown control ${key}`);
  requireExact(policy.schemaVersion, 1, "policy.schemaVersion");
  if (typeof policy.candidateId !== "string" || !SHA256.test(policy.candidateId)) throw new Error("policy.candidateId must be a SHA-256 candidate ID");
  requireExact(policy.runtime, "docker", "policy.runtime");
  requireExact(policy.network, "none", "policy.network");
  requireExact(policy.readOnlyRootFilesystem, true, "policy.readOnlyRootFilesystem");
  requireExactArray(policy.capDrop, ["ALL"], "policy.capDrop");
  requireExactArray(policy.securityOpt, ["no-new-privileges"], "policy.securityOpt");
  requireExact(policy.user, "65532:65532", "policy.user");
  requireExactArray(policy.tmpfs, ["/work:rw,nosuid,nodev,size=512m", "/tmp:rw,nosuid,nodev,noexec,size=128m"], "policy.tmpfs");
  const resources = requireRecord(policy.resources, "policy.resources");
  requireExact(resources.pids, 64, "policy.resources.pids");
  requireExact(resources.memory, "2g", "policy.resources.memory");
  requireExact(resources.cpus, "2", "policy.resources.cpus");
  requireExact(resources.timeoutMs, 60_000, "policy.resources.timeoutMs");
  requireExact(resources.outputLimitBytes, 65_536, "policy.resources.outputLimitBytes");
  const environment = requireRecord(policy.environment, "policy.environment");
  if (Object.keys(environment).length !== 2 || environment.CI !== "1" || environment.HOME !== "/home/napplet") throw new Error("policy.environment must be the exact scrubbed allowlist");
  const inputMount = requireRecord(policy.inputMount, "policy.inputMount");
  requireExact(inputMount.destination, "/input", "policy.inputMount.destination");
  requireExact(inputMount.readOnly, true, "policy.inputMount.readOnly");
  requireExact(policy.entrypoint, "/toolchain/bin/bun", "policy.entrypoint");
  return policy as ToolchainImagePolicy;
}

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
      const child = Bun.spawn(["docker", "build", "--pull=false", "--file", "infra/toolchain/Dockerfile", "--tag", tag, "."], { stdout: "inherit", stderr: "inherit", stdin: "ignore", env: { PATH: process.env.PATH ?? "" } });
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
