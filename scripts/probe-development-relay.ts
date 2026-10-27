import { randomBytes } from "node:crypto";

export const DEVELOPMENT_RELAY_IMAGE = "scsibug/nostr-rs-relay:0.9.0@sha256:03f54bfbffff80a50db62c9287913bd25a2dec08033b56d2122bc2550363d5c5";
const name = `napplet-cvm-relay-probe-${randomBytes(8).toString("hex")}`;

async function command(argv: string[], timeoutMs = 30_000): Promise<string> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`DEV_RELAY_PROBE_COMMAND_FAILED:${argv[0]}:${stderr.trim().slice(0, 1_000)}`);
  return stdout.trim();
}

async function waitForWebSocket(endpoint: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(endpoint);
        const timeout = setTimeout(() => { socket.close(); reject(new Error("timeout")); }, 2_000);
        socket.onopen = () => { clearTimeout(timeout); socket.close(); resolve(); };
        socket.onerror = () => { clearTimeout(timeout); reject(new Error("connect")); };
      });
      return;
    } catch { await Bun.sleep(250); }
  }
  throw new Error("DEV_RELAY_PROBE_WS_TIMEOUT");
}

async function cleanup(): Promise<void> {
  const child = Bun.spawn(["docker", "rm", "--force", name], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await child.exited;
}

async function probe(): Promise<void> {
  await command(["docker", "pull", "--platform", "linux/amd64", DEVELOPMENT_RELAY_IMAGE], 120_000);
  const architecture = await command(["docker", "image", "inspect", DEVELOPMENT_RELAY_IMAGE, "--format", "{{.Architecture}}"]);
  if (architecture !== "amd64") throw new Error("DEV_RELAY_PROBE_ARCHITECTURE_INVALID");
  await command(["docker", "run", "--detach", "--rm", "--name", name, "--platform", "linux/amd64", "--publish", "127.0.0.1::8080", DEVELOPMENT_RELAY_IMAGE]);
  const address = await command(["docker", "port", name, "8080"]);
  if (!/^127\.0\.0\.1:\d+$/u.test(address)) throw new Error("DEV_RELAY_PROBE_PORT_INVALID");
  await waitForWebSocket(`ws://${address}`);
  console.log(JSON.stringify({ relayImage: DEVELOPMENT_RELAY_IMAGE, architecture, websocket: "ready" }));
}

if (import.meta.main) {
  const interrupt = () => { void cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try { await probe(); }
  catch (error) { console.error(error instanceof Error ? error.message : "DEV_RELAY_PROBE_FAILED"); process.exitCode = 1; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); await cleanup(); }
}
