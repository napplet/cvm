#!/usr/bin/env bun
const result = Bun.spawn(["/usr/local/bin/napplet-cvm-worker", "ready", ...process.argv.slice(3)], { stdout: "pipe", stderr: "pipe", env: process.env });
const [status, stdout, stderr] = await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()]);
if (process.argv[2] !== "observe-isolation" || status !== 0) {
  console.error(stderr.slice(0, 4_000)); process.exitCode = 1;
} else {
  const readiness = JSON.parse(stdout) as { checks: Record<string, boolean>; exactReady: unknown };
  console.log(JSON.stringify({ checks: readiness.checks, exactReady: readiness.exactReady }));
}
