import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

/** Local actual CLI/Chromium mechanism, not live-provider or release evidence.
 * No host workspace or secrets are mounted in the container. */
export async function openLocalProductionWorker(image: string) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("LOCAL_WORKER_EXACT_IMAGE_ID_REQUIRED");
  const name = `cvm-priced-artifact-${crypto.randomUUID().replaceAll("-", "")}`;
  const logPath = `/tmp/${name}.ndjson`;
  const execute = async (args: string[], stdin?: string) => {
    const child = Bun.spawn(["docker", ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (stdin !== undefined && typeof child.stdin !== "number" && child.stdin) { child.stdin.write(stdin); child.stdin.end(); }
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
        if (size > 512_000) throw new Error("LOCAL_WORKER_OUTPUT_LIMIT"); chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      return Buffer.concat(chunks).toString("utf8");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [exitCode, stdout, stderr] = await Promise.race([Promise.all([child.exited, read(child.stdout), read(child.stderr)]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("LOCAL_WORKER_COMMAND_TIMEOUT")); }, 30_000); })]);
      return { exitCode, stdout, stderr };
    } finally { clearTimeout(timer); child.kill(); }
  };
  const paths = ["production-worker.ts", "production-job.ts", "production-bootstrap.sh"];
  const installed = ["napplet-cvm-worker", "napplet-cvm-job", "napplet-cvm-bootstrap"];
  const hashes = await execute(["run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "sha256sum", image,
    ...installed.map(file => `/usr/local/bin/${file}`)]);
  const expected = await Promise.all(paths.map(async file => createHash("sha256").update(await Bun.file(`infra/toolchain/${file}`).bytes()).digest("hex")));
  if (hashes.exitCode !== 0 || hashes.stdout.trim().split("\n").some((line, index) => line.split(/\s+/u)[0] !== expected[index])
    || hashes.stdout.trim().split("\n").length !== paths.length) throw new Error("LOCAL_WORKER_IMAGE_SOURCE_MISMATCH");
  const start = await execute(["run", "-d", "--pull", "never", "--name", name, "--cpus", "1", "--memory", "1024m", "--memory-swap", "1024m",
    "--security-opt", "apparmor=unconfined", "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "-e", "NAPPLET_CVM_POLICY_VERSION=production-worker-policy-2026-10-27",
    image, "/usr/local/bin/napplet-cvm-worker", "idle", "--provider-deadline-epoch-ms", String(Date.now() + 1_200_000)]);
  if (start.exitCode !== 0) { await execute(["rm", "-f", name]); throw new Error(`LOCAL_WORKER_START_FAILED:${start.stderr.slice(0, 1000)}`); }
  return { image, name, logPath,
    async exec(command: readonly string[], stdin?: string): Promise<{ status: "completed"; exitCode: number; stdout: string; stderr: string }> {
      const result = await execute(["exec", "-i", name, "/usr/local/bin/napplet-cvm-bootstrap", ...command], stdin);
      await appendFile(logPath, `${JSON.stringify({ command, ...result })}\n`, { mode: 0o600 });
      return { status: "completed", ...result };
    },
    async close() {
      const removed = await execute(["rm", "-f", name]);
      const remaining = await execute(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
      if (removed.exitCode !== 0 || remaining.exitCode !== 0 || remaining.stdout.trim() !== "") throw new Error("LOCAL_WORKER_CLEANUP_UNCONFIRMED");
    },
  };
}
