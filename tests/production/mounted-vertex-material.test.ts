import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadProductionConfig } from "../../src/production/config";
import { createMountedVertexMaterial } from "../../src/production/mounted-vertex-material";
import { MountedProductionSecretMaterial } from "../../src/production/secret-material";
import { mountedBillingRecoveryFixture } from "../release/helpers/mounted-billing-recovery-fixture";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("mounted Vertex material retains only its validated quote binding for the real deployment client", async () => {
  const base = resolve(import.meta.dir, "../../.runtime/release-certification/native-discovery-v1");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "mounted-vertex-material-"));
  const workspace = join(root, "workspace");
  const now = Date.now();
  try {
    await mkdir(join(workspace, "states"), { recursive: true, mode: 0o700 });
    const fixture = await mountedBillingRecoveryFixture(workspace, now);
    const sourceDocument = new TextEncoder().encode("mounted Vertex source");
    const quote = {
      sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
      sourceDocumentSha256: sha256(sourceDocument),
      observedAtMs: now - 1_000,
      freshUntilMs: now + 60_000,
      effectiveFromMs: now - 1_000,
      effectiveUntilMs: now + 60_000,
      inputMicrosPerMillion: 1_000,
      cachedInputMicrosPerMillion: 500,
      outputAndThoughtMicrosPerMillion: 2_000,
    };
    const quoteSha256 = sha256(JSON.stringify(quote));
    const config = loadProductionConfig({ ...fixture.config, vertex: { ...fixture.config.vertex, credentialReference: "gcp:adc:fixture", priceSnapshotSha256: quoteSha256 } });
    const secrets = new MountedProductionSecretMaterial(config, { root: join(workspace, "fixture-mount") });
    const write = async (value: unknown) => writeFile(secrets.path("vertex.credentialReference"), JSON.stringify(value), { mode: 0o600 });
    const material = { credentialReference: "gcp:adc:fixture", price: { ...quote, sourceDocumentBase64: Buffer.from(sourceDocument).toString("base64"), quoteSha256 }, conversion: { source: { url: "https://cloud.google.com/fixture-fx", capturedBytesSha256: sha256("fx"), observedAt: new Date(now - 1_000).toISOString(), effectiveAt: new Date(now - 1_000).toISOString(), freshUntil: new Date(now + 60_000).toISOString() }, satsPerUsd: { numerator: "1000", denominator: "1" } } };
    await write(material);
    const mounted = await createMountedVertexMaterial({ config, secrets, now: () => now });
    expect(mounted.vertexPrice.quoteSha256).toBe(quoteSha256);
    expect(mounted.vertexPrice.sourceDocumentSha256).toBe(quote.sourceDocumentSha256);
    const { quoteSha256: _missing, ...missingPrice } = material.price;
    await write({ ...material, price: missingPrice });
    await expect(createMountedVertexMaterial({ config, secrets, now: () => now })).rejects.toThrow();
    await write({ ...material, price: { ...material.price, quoteSha256: "0".repeat(64) } });
    await expect(createMountedVertexMaterial({ config, secrets, now: () => now })).rejects.toThrow("PRODUCTION_VERTEX_PRICE_SNAPSHOT_BINDING_INVALID");
  } finally { await rm(root, { recursive: true, force: true }); }
});
