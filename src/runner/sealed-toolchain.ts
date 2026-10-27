import { runHermeticCommand, type CommandEvidence, type HermeticCommand } from "./hermetic-command";

export type { CommandEvidence } from "./hermetic-command";

type JsonRecord = Record<string, unknown>;

export type SealedToolchainPolicy = {
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

export type SealedToolchainRequest = {
  readonly id: string;
  readonly policyPath: string;
  readonly imageDigest: string;
  readonly inputDirectory: string;
  readonly script: string;
  readonly executableSha256?: string;
  readonly args: readonly string[];
  readonly toolchainId: string;
  readonly timeoutMs?: number;
  readonly dockerExecutable?: string;
  readonly dockerClientEnv?: Readonly<Record<string, string>>;
  readonly now?: () => number;
  readonly execute?: (command: HermeticCommand) => Promise<CommandEvidence>;
};

const SHA256 = /^[a-f0-9]{64}$/i;
const POLICY_KEYS = new Set(["schemaVersion", "candidateId", "runtime", "network", "readOnlyRootFilesystem", "capDrop", "securityOpt", "user", "tmpfs", "resources", "environment", "inputMount", "entrypoint"]);
const CLIENT_ENV = new Set(["DOCKER_HOST", "DOCKER_CONTEXT"]);
const SECRET = /(?:secret|token|password|credential|private.?key|api.?key)/i;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${String(expected)}`);
}

function exactArray(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) throw new Error(`${label} must be exactly ${expected.join(", ")}`);
}

/** Parses every required isolation control and rejects policy expansion or relaxation. */
export function parseSealedToolchainPolicy(value: unknown): SealedToolchainPolicy {
  const policy = record(value, "policy");
  for (const key of Object.keys(policy)) if (!POLICY_KEYS.has(key)) throw new Error(`policy has unknown control ${key}`);
  exact(policy.schemaVersion, 1, "policy.schemaVersion");
  if (typeof policy.candidateId !== "string" || !SHA256.test(policy.candidateId)) throw new Error("policy.candidateId must be a SHA-256 candidate ID");
  exact(policy.runtime, "docker", "policy.runtime");
  exact(policy.network, "none", "policy.network");
  exact(policy.readOnlyRootFilesystem, true, "policy.readOnlyRootFilesystem");
  exactArray(policy.capDrop, ["ALL"], "policy.capDrop");
  exactArray(policy.securityOpt, ["no-new-privileges"], "policy.securityOpt");
  exact(policy.user, "65532:65532", "policy.user");
  exactArray(policy.tmpfs, ["/work:rw,nosuid,nodev,size=512m", "/tmp:rw,nosuid,nodev,noexec,size=128m"], "policy.tmpfs");
  const resources = record(policy.resources, "policy.resources");
  exact(resources.pids, 64, "policy.resources.pids");
  exact(resources.memory, "2g", "policy.resources.memory");
  exact(resources.cpus, "2", "policy.resources.cpus");
  exact(resources.timeoutMs, 60_000, "policy.resources.timeoutMs");
  exact(resources.outputLimitBytes, 65_536, "policy.resources.outputLimitBytes");
  const environment = record(policy.environment, "policy.environment");
  if (Object.keys(environment).length !== 2 || environment.CI !== "1" || environment.HOME !== "/home/napplet") throw new Error("policy.environment must be the exact scrubbed allowlist");
  const inputMount = record(policy.inputMount, "policy.inputMount");
  exact(inputMount.destination, "/input", "policy.inputMount.destination");
  exact(inputMount.readOnly, true, "policy.inputMount.readOnly");
  exact(policy.entrypoint, "/toolchain/bin/bun", "policy.entrypoint");
  return policy as SealedToolchainPolicy;
}

async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Bun.file(path).arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scrubDockerClientEnv(value: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value ?? {})) {
    if (!CLIENT_ENV.has(name) || SECRET.test(name) || SECRET.test(entry)) throw new Error("Docker client environment is not allowlisted");
    output[name] = entry;
  }
  return output;
}

function dockerArgv(policy: SealedToolchainPolicy, request: SealedToolchainRequest): string[] {
  if (!SHA256.test(request.imageDigest)) throw new Error("image digest must be a SHA-256 value");
  if (request.executableSha256 !== undefined && !SHA256.test(request.executableSha256)) throw new Error("image-local executable digest must be a SHA-256 value");
  if (!request.inputDirectory.startsWith("/")) throw new Error("input directory must be absolute");
  if (!request.script.startsWith("/toolchain/")) throw new Error("sealed script must be image-local");
  if (!request.args.every((argument) => typeof argument === "string")) throw new Error("sealed args must be literal strings");
  const mount = `type=bind,src=${request.inputDirectory},dst=${policy.inputMount.destination},readonly`;
  return [
    "run", "--rm", "--pull=never", `--network=${policy.network}`, "--read-only", `--cap-drop=${policy.capDrop[0]}`, `--security-opt=${policy.securityOpt[0]}`, `--user=${policy.user}`,
    ...policy.tmpfs.map((tmpfs) => `--tmpfs=${tmpfs}`), `--pids-limit=${policy.resources.pids}`, `--memory=${policy.resources.memory}`, `--cpus=${policy.resources.cpus}`,
    ...Object.entries(policy.environment).flatMap(([name, value]) => [`--env=${name}=${value}`]), `--mount=${mount}`, `--entrypoint=${policy.entrypoint}`,
    `napplet-cvm/toolchain@sha256:${request.imageDigest}`, request.script, ...request.args,
  ];
}

/** Runs the only allowed host-to-container adapter for a promotion command. */
export async function runSealedToolchain(request: SealedToolchainRequest): Promise<CommandEvidence> {
  const policy = parseSealedToolchainPolicy(await Bun.file(request.policyPath).json());
  if (policy.candidateId !== request.toolchainId) throw new Error("sealed policy candidate ID does not match the requested toolchain");
  const timeoutMs = request.timeoutMs ?? policy.resources.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > policy.resources.timeoutMs) throw new Error("sealed timeout must be within the policy ceiling");
  // Reject invalid commands before reading or invoking a host executable.
  const argv = dockerArgv(policy, request);
  const executable = request.dockerExecutable ?? Bun.which("docker") ?? "/usr/local/bin/docker";
  const executableSha256 = request.execute ? "0".repeat(64) : await sha256File(executable);
  const command: HermeticCommand = {
    id: request.id,
    executable,
    executableSha256,
    allowedExecutables: [{ path: executable, sha256: executableSha256 }],
    argv,
    cwd: request.inputDirectory,
    timeoutMs,
    outputLimitBytes: policy.resources.outputLimitBytes,
    toolchainId: request.toolchainId,
    imageDigest: request.imageDigest,
    env: scrubDockerClientEnv(request.dockerClientEnv),
    now: request.now,
  };
  return (request.execute ?? runHermeticCommand)(command);
}

const DENIAL_PROBES = ["dns", "http", "https", "tcp"] as const;

/** Requires every external-network and secret-canary attempt to execute and deny. */
export async function runSealedDenialProbes(request: Omit<SealedToolchainRequest, "id" | "script" | "args">): Promise<readonly CommandEvidence[]> {
  const results: CommandEvidence[] = [];
  for (const probe of DENIAL_PROBES) {
    const result = await runSealedToolchain({ ...request, id: `deny-${probe}`, script: "/toolchain/bin/denial-probe", args: [`--probe=${probe}`, "--assert-secret-absent"] });
    if (
      result.disposition === "passed" ||
      !result.stderr.includes(`CVM_DENIAL_PROBE:${probe}:denied`) ||
      result.stdout.includes("CVM_CANARY_SECRET") ||
      result.stderr.includes("CVM_CANARY_SECRET")
    ) throw new Error(`denial probe ${probe} did not fail closed`);
    results.push(result);
  }
  return results;
}
