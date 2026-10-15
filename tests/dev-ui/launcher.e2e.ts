import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const instance = `test-launcher-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const env = { ...process.env, NAPPLET_CVM_DEV_INSTANCE: instance };

async function launcher(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "scripts/dev.ts", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}
function json(stdout: string): Record<string, unknown> { return JSON.parse(stdout.trim()) as Record<string, unknown>; }

async function main(): Promise<void> {
  const requested = process.argv.find((argument) => argument.startsWith("--case="));
  if (requested && requested !== "--case=clean-up-idempotent-down-persist-reset") throw new Error("DEV_LAUNCHER_CASE_INVALID");
  try {
    const first = await launcher("up"); expect(first.code).toBe(0); const ready = json(first.stdout);
    expect(ready).toMatchObject({ ready: true, instance, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u), mode: expect.any(String) });
    const configPath = String(ready.configPath); const before = JSON.parse(await readFile(configPath, "utf8")) as { fundingKey: string };
    const markerPath = resolve(String(ready.stateRoot), "launcher-retain.marker"); await writeFile(markerPath, "preserve\n", { mode: 0o600 });
    const repeated = await launcher("up"); expect(repeated.code).toBe(0); expect(json(repeated.stdout)).toMatchObject({ pid: ready.pid, url: ready.url, configPath });
    const inspected = await launcher("status"); expect(inspected.code).toBe(0); expect(json(inspected.stdout)).toMatchObject({ ready: true, url: ready.url, stateRoot: ready.stateRoot, configPath });
    const stopped = await launcher("down"); expect(stopped.code).toBe(0);
    const restarted = await launcher("up"); expect(restarted.code).toBe(0); expect(json(restarted.stdout)).toMatchObject({ ready: true, url: ready.url });
    expect((JSON.parse(await readFile(configPath, "utf8")) as { fundingKey: string }).fundingKey).toBe(before.fundingKey);
    const refused = await launcher("reset"); expect(refused.code).not.toBe(0); expect(refused.stderr).toContain("DEV_RESET_CONFIRM_REQUIRED");
    const reset = await launcher("reset", "--confirm"); expect(reset.code).toBe(0); expect(json(reset.stdout)).toEqual({ reset: true, instance });
    const clean = await launcher("up"); expect(clean.code).toBe(0); expect(json(clean.stdout)).toMatchObject({ ready: true, instance });
    expect((JSON.parse(await readFile(configPath, "utf8")) as { fundingKey: string }).fundingKey).not.toBe(before.fundingKey);
    expect(await Bun.file(markerPath).text()).toBe("preserve\n");
  } finally { await launcher("reset", "--confirm"); }
}

if (import.meta.main) await main();
