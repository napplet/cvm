import { canonicalJson } from "../promotion/schema";

export type CommandDisposition =
  | "passed"
  | "non-zero-exit"
  | "timeout"
  | "output-overflow"
  | "egress-attempt"
  | "resource-limit";

export type HermeticCommand = {
  readonly id: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly allowedExecutables: readonly { readonly path: string; readonly sha256: string }[];
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly toolchainId: string;
  readonly imageDigest: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: () => number;
};

export type CommandEvidence = {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly cwdSha256: string;
  readonly toolchainId: string;
  readonly imageDigest: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly disposition: CommandDisposition;
  readonly evidenceSha256: string;
};

const SHA256 = /^[a-f0-9]{64}$/i;
const SECRET_NAME = /(?:secret|token|password|credential|private.?key|api.?key)/i;

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireSafeCommand(command: HermeticCommand): void {
  if (!command.executable.startsWith("/")) throw new Error("executable must be absolute");
  if (!command.cwd.startsWith("/")) throw new Error("working directory must be absolute");
  if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1) throw new Error("timeout must be a positive integer");
  if (!Number.isInteger(command.outputLimitBytes) || command.outputLimitBytes < 1) throw new Error("output limit must be a positive integer");
  if (!SHA256.test(command.executableSha256) || !SHA256.test(command.imageDigest)) throw new Error("command digests must be SHA-256 values");
  if ((command as unknown as Record<string, unknown>).shell === true) throw new Error("shell execution is prohibited");
  if (!command.argv.every((argument) => typeof argument === "string")) throw new Error("argv must contain only literal strings");
  if (!command.allowedExecutables.some((entry) => entry.path === command.executable && entry.sha256 === command.executableSha256)) {
    throw new Error("executable is not in the manifest allowlist");
  }
  for (const [name, value] of Object.entries(command.env ?? {})) {
    if (SECRET_NAME.test(name) || SECRET_NAME.test(value)) throw new Error("secret-shaped environment entries are prohibited");
  }
}

async function capture(stream: ReadableStream<Uint8Array>, limit: number, terminate: () => void): Promise<{ bytes: Uint8Array; overflowed: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let overflowed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - length;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.slice(0, remaining));
        length = limit;
        overflowed = true;
        terminate();
        await reader.cancel();
        break;
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflowed };
}

/**
 * Runs one manifest-approved executable without a shell or inherited environment.
 * The sealed image supervisor may signal egress/resource denials on stderr; both
 * signals are terminal blockers and are retained as structured command evidence.
 */
export async function runHermeticCommand(command: HermeticCommand): Promise<CommandEvidence> {
  requireSafeCommand(command);
  const executableDigest = await sha256(new Uint8Array(await Bun.file(command.executable).arrayBuffer()));
  if (executableDigest !== command.executableSha256) throw new Error("executable digest does not match manifest allowlist");

  const now = command.now ?? Date.now;
  const startedAtMs = now();
  const child = Bun.spawn([command.executable, ...command.argv], {
    cwd: command.cwd,
    env: { LANG: "C", TZ: "UTC", ...(command.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, command.timeoutMs);
  const [exitCode, stdoutCapture, stderrCapture] = await Promise.all([
    child.exited,
    capture(child.stdout, command.outputLimitBytes, () => child.kill()),
    capture(child.stderr, command.outputLimitBytes, () => child.kill()),
  ]).finally(() => clearTimeout(timeout));
  const finishedAtMs = now();
  const stdout = new TextDecoder().decode(stdoutCapture.bytes);
  const stderr = new TextDecoder().decode(stderrCapture.bytes);
  const disposition: CommandDisposition = timedOut
    ? "timeout"
    : stdoutCapture.overflowed || stderrCapture.overflowed
      ? "output-overflow"
      : stderr.includes("CVM_EGRESS_ATTEMPT")
        ? "egress-attempt"
        : stderr.includes("CVM_RESOURCE_LIMIT")
          ? "resource-limit"
          : exitCode === 0
            ? "passed"
            : "non-zero-exit";
  const evidence = {
    id: command.id,
    argv: [command.executable, ...command.argv],
    cwd: command.cwd,
    cwdSha256: await sha256(command.cwd),
    toolchainId: command.toolchainId,
    imageDigest: command.imageDigest,
    startedAtMs,
    finishedAtMs,
    exitCode,
    stdout,
    stderr,
    stdoutSha256: await sha256(stdoutCapture.bytes),
    stderrSha256: await sha256(stderrCapture.bytes),
    disposition,
  };
  return { ...evidence, evidenceSha256: await sha256(canonicalJson(evidence)) };
}
