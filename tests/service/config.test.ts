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
  funding: { mode: "adapters", adapters: [{ id: "operator", module: "/opt/payments/adapter.ts", options: {} }] },
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
  expect(() => parseServiceConfig({ ...baseConfig, funding: { mode: "adapters", adapters: [] } })).toThrow();
  expect(() => parseServiceConfig({ ...baseConfig, funding: { mode: "free", allowlist: [], maximumCredits: "1000" } })).toThrow();
  expect(() => parseServiceConfig({ ...baseConfig, funding: { mode: "adapters", adapters: [{ id: "operator", module: "./untrusted-relative.ts" }] } })).toThrow();
  expect(JSON.stringify(baseConfig).toLowerCase()).not.toContain("google");
});

test("the real realm preserves TLS, metered-model and worker isolation requirements independently of payment providers", () => {
  const real = { ...baseConfig, realm: "real" };
  expect(parseServiceConfig(real).realm).toBe("real");
  expect(() => parseServiceConfig({ ...real, origins: { ...baseConfig.origins, relay: "ws://cvm.example.org/relay" } })).toThrow();
  expect(() => parseServiceConfig({ ...real, worker: { ...baseConfig.worker, runtime: "runc" } })).toThrow();
  expect(parseServiceConfig({ ...baseConfig, model: { adapter: "deterministic-test" } }).model.adapter).toBe("deterministic-test");
  expect(() => parseServiceConfig({ ...real, model: { adapter: "deterministic-test" } })).toThrow();
});

test("free operation requires an explicit owner allowlist and bounded credits", () => {
  const funding = { mode: "free", allowlist: ["ab".repeat(32)], maximumCredits: "5000" };
  expect(parseServiceConfig({ ...baseConfig, funding }).funding.mode).toBe("free");
  expect(() => parseServiceConfig({ ...baseConfig, funding: { ...funding, allowlist: ["nsec-invalid"] } })).toThrow();
  expect(() => parseServiceConfig({ ...baseConfig, funding: { ...funding, adapters: baseConfig.funding.adapters } })).toThrow();
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
  await writeFile(join(directory, "database_url"), "value\n", { mode: 0o600 });
  expect(await new ServiceSecrets(directory).text("database_url")).toBe("value");
  await chmod(join(directory, "database_url"), 0o644);
  await expect(new ServiceSecrets(directory).text("database_url")).rejects.toThrow("SERVICE_SECRET_WORLD_READABLE");
  await expect(new ServiceSecrets(directory).text("openai_api_key")).rejects.toThrow("SERVICE_MOUNT_UNAVAILABLE");
});
