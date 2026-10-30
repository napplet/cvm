import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHermeticCommand } from "../../src/runner/hermetic-command";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Bun.file(path).arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function command(argv: string[], overrides: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "napplet-cvm-runner-"));
  cleanup.push(cwd);
  return {
    id: `command-${cleanup.length}`,
    executable: process.execPath,
    executableSha256: await sha256File(process.execPath),
    allowedExecutables: [{ path: process.execPath, sha256: await sha256File(process.execPath) }],
    argv,
    cwd,
    timeoutMs: 200,
    outputLimitBytes: 512,
    toolchainId: "toolchain-test",
    imageDigest: "a".repeat(64),
    ...overrides,
  };
}

describe("runHermeticCommand", () => {
  test("delivers literal argv values and scrubs inherited secrets", async () => {
    const original = process.env.CVM_INHERITED_SECRET;
    process.env.CVM_INHERITED_SECRET = "must-not-reach-child";
    try {
      const literal = "$(touch no-shell) ; && | has spaces";
      const result = await runHermeticCommand(await command([
        "-e",
        "console.log(JSON.stringify({ literal: process.argv[1], secret: process.env.CVM_INHERITED_SECRET ?? 'absent' }))",
        literal,
      ]));
      expect(result.disposition).toBe("passed");
      expect(result.stdout).toContain(JSON.stringify({ literal, secret: "absent" }));
      expect(await Bun.file(join(process.cwd(), "no-shell")).exists()).toBeFalse();
    } finally {
      if (original === undefined) delete process.env.CVM_INHERITED_SECRET;
      else process.env.CVM_INHERITED_SECRET = original;
    }
  });

  test("isolates concurrent work directories and command evidence IDs", async () => {
    const [first, second] = await Promise.all([
      runHermeticCommand(await command(["-e", "console.log(process.cwd())"])),
      runHermeticCommand(await command(["-e", "console.error('expected failure'); process.exit(3)"])),
    ]);
    expect(first.disposition).toBe("passed");
    expect(second.disposition).toBe("non-zero-exit");
    expect(first.id).not.toBe(second.id);
    expect(first.cwd).not.toBe(second.cwd);
    expect(first.stdout).toContain(first.cwd);
  });

  test.each<[string, string[], Record<string, unknown>, Awaited<ReturnType<typeof runHermeticCommand>>["disposition"]]>([
    ["timeout", ["-e", "await Bun.sleep(1000)"], { timeoutMs: 5 }, "timeout"],
    ["output overflow", ["-e", "process.stdout.write('x'.repeat(2000))"], { outputLimitBytes: 32 }, "output-overflow"],
    ["egress signal", ["-e", "console.error('CVM_EGRESS_ATTEMPT')"], {}, "egress-attempt"],
    ["resource signal", ["-e", "console.error('CVM_RESOURCE_LIMIT')"], {}, "resource-limit"],
  ])("blocks %s", async (_name, argv, overrides, disposition) => {
    const result = await runHermeticCommand(await command(argv, overrides));
    expect(result.disposition).toBe(disposition);
  });

  test("rejects a shell request, a secret env key, and executables outside the allowlist", async () => {
    await expect(runHermeticCommand(await command(["-e", "console.log('no')"], { shell: true }))).rejects.toThrow("shell");
    await expect(runHermeticCommand(await command(["-e", "console.log('no')"], { env: { API_SECRET: "leak" } }))).rejects.toThrow("secret");
    await expect(runHermeticCommand(await command(["-e", "console.log('no')"], { allowedExecutables: [] }))).rejects.toThrow("allowlist");
  });
});
