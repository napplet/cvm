import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationDefaultTokenPort } from "../../src/release/costs/official-sources";

test("actual ADC child process is bounded and returns only a valid token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cvm-adc-process-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${directory}:${previousPath ?? ""}`;
    const fixture = async (script: string) => writeFile(join(directory, "gcloud"), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    const port = createApplicationDefaultTokenPort();
    await fixture(`printf '%s\\n' '${"x".repeat(64)}'`);
    expect(await port.readAccessToken()).toBe("x".repeat(64));
    await fixture(`printf '%s\\n' '${"x".repeat(9000)}'`);
    await expect(port.readAccessToken()).rejects.toThrow("ADC_TOKEN_RESPONSE_REJECTED");
    await fixture("exit 1");
    await expect(port.readAccessToken()).rejects.toThrow("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
    await fixture("exec sleep 30");
    const start = performance.now();
    await expect(port.readAccessToken()).rejects.toThrow("ADC_TOKEN_TIMEOUT");
    expect(performance.now() - start).toBeLessThan(7000);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
