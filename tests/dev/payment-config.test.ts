import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readDevelopmentPaymentConfig } from "./payment-config";

const root = resolve(import.meta.dir, "../..");
const runs = new Set<string>();

const paymentConfig = () => ({
  version: 1,
  developmentOnly: true,
  mintUrl: "http://127.0.0.1:3338",
  secondaryMintUrl: "http://127.0.0.1:3339",
  relayUrl: "ws://127.0.0.1:7777",
  hubUrl: "http://127.0.0.1:8081",
  nwcUri: "nostr+walletconnect://" + "a".repeat(64) + "?relay=ws%3A%2F%2F127.0.0.1%3A7777&secret=" + "b".repeat(64),
  cashuToken: "cashuA-test-only",
  databaseUrl: "postgresql://napplet_dev:development-only-no-real-funds@127.0.0.1:55432/napplet_dev",
  fundingKey: "c".repeat(64),
});

async function writeRun(runId: string, value = paymentConfig()): Promise<string> {
  runs.add(runId);
  const directory = resolve(root, ".local", "napplet-cvm-dev", runId, "payments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, "payments.json");
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

function environment(runId: string, file: string) {
  return { NAPPLET_CVM_DEV_TEST_RUN_ID: runId, NAPPLET_CVM_DEV_TEST_PAYMENTS_FILE: file };
}

afterEach(async () => {
  await Promise.all([...runs].map((runId) => rm(resolve(root, ".local", "napplet-cvm-dev", runId), { recursive: true, force: true })));
  runs.clear();
});

test("requires an explicit private config owned by this test run", async () => {
  const runId = "config-valid";
  const file = await writeRun(runId);
  await expect(readDevelopmentPaymentConfig(environment(runId, file))).resolves.toMatchObject({ developmentOnly: true, databaseUrl: expect.stringContaining("127.0.0.1") });
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
  await expect(readDevelopmentPaymentConfig({})).rejects.toThrow("DEV_TEST_PAYMENT_CONFIG_REQUIRED");
});

test("rejects malformed, non-loopback, and non-development payment config", async () => {
  const runId = "config-invalid";
  const file = await writeRun(runId, { ...paymentConfig(), mintUrl: "https://mint.example" });
  await expect(readDevelopmentPaymentConfig(environment(runId, file))).rejects.toThrow("DEV_TEST_PAYMENT_CONFIG_ENDPOINT_INVALID");
  await writeFile(file, "{", { mode: 0o600 });
  await expect(readDevelopmentPaymentConfig(environment(runId, file))).rejects.toThrow("DEV_TEST_PAYMENT_CONFIG_INVALID");
  await writeFile(file, JSON.stringify({ ...paymentConfig(), developmentOnly: false }), { mode: 0o600 });
  await expect(readDevelopmentPaymentConfig(environment(runId, file))).rejects.toThrow("DEV_TEST_PAYMENT_CONFIG_NOT_DEVELOPMENT_ONLY");
});

test("rejects symlinks, escaped paths, and another run's config", async () => {
  const runId = "config-owner";
  const file = await writeRun(runId);
  const other = await writeRun("config-other");
  await expect(readDevelopmentPaymentConfig(environment(runId, other))).rejects.toThrow("DEV_TEST_PAYMENT_CONFIG_OWNERSHIP_INVALID");
  await expect(readDevelopmentPaymentConfig(environment(runId, `${resolve(root, ".local", "napplet-cvm-dev", runId, "payments")}/../payments.json`))).rejects.toThrow("DEV_TEST_PAYMENT_CONFIG_OWNERSHIP_INVALID");
  await rm(file);
  await symlink(other, file);
  await expect(readDevelopmentPaymentConfig(environment(runId, file))).rejects.toThrow("DEV_TEST_PAYMENT_CONFIG_SYMLINK");
});

test("keeps concurrent run identities isolated", async () => {
  const one = await writeRun("config-concurrent-one");
  const two = await writeRun("config-concurrent-two");
  await expect(readDevelopmentPaymentConfig(environment("config-concurrent-one", one))).resolves.toMatchObject({ developmentOnly: true });
  await expect(readDevelopmentPaymentConfig(environment("config-concurrent-two", two))).resolves.toMatchObject({ developmentOnly: true });
  await expect(readDevelopmentPaymentConfig(environment("config-concurrent-one", two))).rejects.toThrow("DEV_TEST_PAYMENT_CONFIG_OWNERSHIP_INVALID");
});
