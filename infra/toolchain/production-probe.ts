#!/usr/bin/env bun
const result = Bun.spawn(["/usr/local/bin/napplet-cvm-worker", "ready", ...process.argv.slice(3)], { stdout: "pipe", stderr: "pipe", env: process.env });
const read = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 64 * 1024) { result.kill(); throw new Error("PROBE_OUTPUT_LIMIT"); } parts.push(item.value); } }
  finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(parts));
};
let timer: ReturnType<typeof setTimeout> | undefined;
const timed = new Promise<never>((_, reject) => { timer = setTimeout(() => { result.kill(); reject(new Error("PROBE_TIMEOUT")); }, 60_000); });
const [status, stdout, stderr] = await Promise.race([Promise.all([result.exited, read(result.stdout), read(result.stderr)]), timed]).finally(() => clearTimeout(timer));
if (process.argv[2] !== "observe-isolation" || status !== 0) {
  console.error(stderr.slice(0, 4_000)); process.exitCode = 1;
} else {
  const readiness = JSON.parse(stdout) as { image?: unknown; sessionLeaseSha256?: unknown; toolchainSha256?: unknown; remainingLifetimeMs?: unknown; checks?: unknown };
  if (typeof readiness.image !== "string" || typeof readiness.sessionLeaseSha256 !== "string" || typeof readiness.toolchainSha256 !== "string" || !Number.isInteger(readiness.remainingLifetimeMs) || !readiness.checks || typeof readiness.checks !== "object") throw new Error("PROBE_READINESS_SHAPE_INVALID");
  console.log(JSON.stringify({ checks: readiness.checks, exactReady: { image: readiness.image, sessionLeaseSha256: readiness.sessionLeaseSha256, toolchainSha256: readiness.toolchainSha256, remainingLifetimeMs: readiness.remainingLifetimeMs } }));
}
