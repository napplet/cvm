import { expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveServiceIdentity, parseServiceConfig, ServiceSecrets } from "../../src/service/config";

export const baseConfig = {
  version: 1, realm: "test", listen: { port: 8080 },
  origins: { public: "https://cvm.example.org", preview: "https://preview.cvm.example.org", blobs: "https://blobs.cvm.example.org", relay: "wss://cvm.example.org/relay" },
  relay: { url: "ws://relay:8080" },
  database: { adapter: "postgresql" },
  storage: { adapter: "filesystem", root: "/var/lib/napplet-cvm" },
  funding: { nwc: { adapter: "nip47-receive-only" }, cashu: { mintPolicyVersion: "service-test-v1", mints: [{ url: "https://mint.test.example", route: "http://mint:3338" }, { url: "https://mint-2.test.example", route: "http://mint-2:3338" }] } },
  model: { adapter: "openai-responses", pricingFile: "/etc/napplet-cvm/model-pricing.json" },
  worker: { adapter: "docker", image: "napplet-cvm/dev-worker:development", runtime: "runsc" },
  policy: { version: "service-v1" },
} as const;

test("one adapter per concern, defaults are explicit and the result is immutable", () => {
  const config = parseServiceConfig(baseConfig);
  expect(config.database.maxConnections).toBe(10);
  expect(config.funding.reserveSat).toBe("3750");
  expect(Object.isFrozen(config.origins)).toBe(true);
  expect(() => parseServiceConfig({ ...baseConfig, worker: { ...baseConfig.worker, adapter: "modal" } })).toThrow();
  expect(() => parseServiceConfig({ ...baseConfig, extra: true })).toThrow();
  expect(() => parseServiceConfig({ ...baseConfig, funding: { ...baseConfig.funding, cashu: { ...baseConfig.funding.cashu, mints: [baseConfig.funding.cashu.mints[0]] } } })).toThrow();
  expect(JSON.stringify(baseConfig).toLowerCase()).not.toContain("google");
});

test("the real-money realm rejects test rails, private mint routes, plaintext relays and runc", () => {
  const real = { ...baseConfig, realm: "real", funding: { ...baseConfig.funding, cashu: { mintPolicyVersion: "service-real-v1", mints: [{ url: "https://mint.example.org" }, { url: "https://mint.example.net" }] } } };
  expect(parseServiceConfig(real).realm).toBe("real");
  expect(() => parseServiceConfig({ ...real, funding: baseConfig.funding })).toThrow();
  expect(() => parseServiceConfig({ ...real, origins: { ...baseConfig.origins, relay: "ws://cvm.example.org/relay" } })).toThrow();
  expect(() => parseServiceConfig({ ...real, worker: { ...baseConfig.worker, runtime: "runc" } })).toThrow();
  expect(parseServiceConfig({ ...baseConfig, model: { adapter: "deterministic-test" } }).model.adapter).toBe("deterministic-test");
  expect(() => parseServiceConfig({ ...real, model: { adapter: "deterministic-test" } })).toThrow();
  expect(() => parseServiceConfig({ ...real, funding: { ...real.funding, cashu: { mintPolicyVersion: "service-real-v1", mints: [{ url: "https://mint.dev.invalid" }, { url: "https://mint.example.net" }] } } })).toThrow("SERVICE_REAL_REALM_TEST_MARKER");
});

test("the service seed deterministically derives independent identity keys", () => {
  const seed = "1f".repeat(32);
  const one = deriveServiceIdentity(seed); const two = deriveServiceIdentity(seed);
  expect(one.signerPrivateKey).toBe(two.signerPrivateKey);
  const keys = [one.signerPrivateKey, ...[one.admissionSecret, one.cursorSecret, one.fundingKey, one.pendingActionKey].map((key) => Buffer.from(key).toString("hex"))];
  expect(new Set(keys).size).toBe(5);
  expect(() => deriveServiceIdentity("not-a-seed")).toThrow("SERVICE_SEED_INVALID");
});

test("mounted secrets must be private regular files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "service-secrets-"));
  await writeFile(join(directory, "nwc_uri"), "value\n", { mode: 0o600 });
  expect(await new ServiceSecrets(directory).text("nwc_uri")).toBe("value");
  await chmod(join(directory, "nwc_uri"), 0o644);
  await expect(new ServiceSecrets(directory).text("nwc_uri")).rejects.toThrow("SERVICE_SECRET_WORLD_READABLE");
  await expect(new ServiceSecrets(directory).text("openai_api_key")).rejects.toThrow("SERVICE_MOUNT_UNAVAILABLE");
});
