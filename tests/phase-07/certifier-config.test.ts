import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCertifierConfig } from "../../src/certification/config";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

test("ordinary tests default to authority-free local configuration", async () => {
  const config = await loadCertifierConfig({ env: {} });
  expect(config).toMatchObject({ version: 1, mode: "local" });
  expect(config.evidenceDirectory).toStartWith(tmpdir());
  expect(JSON.stringify(config)).not.toContain("credential");
  expect(JSON.stringify(config)).not.toContain("trustRoot");
});

test("the checked-in local profile resolves its evidence directory without a digest pin", async () => {
  const config = await loadCertifierConfig({ env: { NAPPLET_CVM_CERTIFIER_CONFIG: "./config/certifier.local.json" }, cwd: process.cwd() });
  expect(config).toEqual({ version: 1, mode: "local", evidenceDirectory: join(process.cwd(), ".local/evidence/certification") });
});

test("protected configuration requires absolute, digest-pinned config bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-certifier-config-"));
  try {
    const modulePath = join(root, "authority.ts");
    const profilePath = join(root, "release.json");
    const configPath = join(root, "certifier.json");
    const moduleSha256 = "a".repeat(64);
    const source = JSON.stringify({
      version: 1,
      mode: "protected",
      releaseProfilePath: profilePath,
      evidenceDirectory: join(root, "evidence"),
      credentials: "unavailable",
      adapter: { root, modulePath, sha256: moduleSha256 },
      trustRoot: { root, modulePath, sha256: moduleSha256 },
      releaseExecution: { root, modulePath, sha256: moduleSha256, configPath: configPath, configSha256: moduleSha256 },
    });
    await writeFile(configPath, source);

    await expect(loadCertifierConfig({ env: { NAPPLET_CVM_CERTIFIER_CONFIG: configPath } })).rejects.toThrow("CERTIFIER_CONFIG_PIN_REJECTED");
    await expect(loadCertifierConfig({ env: { NAPPLET_CVM_CERTIFIER_CONFIG: "certifier.json", NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: sha256(source) }, cwd: root })).rejects.toThrow("CERTIFIER_CONFIG_PIN_REJECTED");
    await expect(loadCertifierConfig({ env: { NAPPLET_CVM_CERTIFIER_CONFIG: configPath, NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: "0".repeat(64) } })).rejects.toThrow("CERTIFIER_CONFIG_PIN_REJECTED");

    const config = await loadCertifierConfig({ env: { NAPPLET_CVM_CERTIFIER_CONFIG: configPath, NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: sha256(source) } });
    expect(config).toMatchObject({ mode: "protected", releaseProfilePath: profilePath, trustRoot: { root, modulePath, sha256: moduleSha256 }, releaseExecution: { root, modulePath, sha256: moduleSha256 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local configuration cannot smuggle protected authority fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-cvm-local-config-"));
  try {
    const configPath = join(root, "certifier.json");
    await writeFile(configPath, JSON.stringify({ version: 1, mode: "local", adapter: { root } }));
    await expect(loadCertifierConfig({ env: { NAPPLET_CVM_CERTIFIER_CONFIG: configPath } })).rejects.toThrow("CERTIFIER_CONFIG_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
