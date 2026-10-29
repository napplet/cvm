import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReleaseCertificationController } from "../../src/release/controller";
import { RELEASE_COST_FAMILIES } from "../../src/release/costs/live-estimator";

const candidatePath = join(import.meta.dir, "..", "..", "toolchains/candidates/initial.json");
const digest = (letter: string) => letter.repeat(64);

function catalog(priceOffset = 0) {
  return {
    listPriceFacts: async () => RELEASE_COST_FAMILIES.map((provider, index) => ({
      provider,
      sourceId: `${provider}-fixture-price`,
      sourceDocumentSha256: digest((index % 16).toString(16)),
      quoteSha256: digest(((index + 1 + priceOffset) % 16).toString(16)),
      currency: "USD",
      unit: "operation",
      priceMicros: index + 1 + priceOffset,
      observedAtMs: 900,
      freshUntilMs: 20_000,
      status: "available",
    })),
  };
}

test("fresh sixteen-family price facts produce an exact immutable authorization request", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-release-cost-request-"));
  try {
    const controller = new ReleaseCertificationController({ candidatePath, workspace, now: () => 1_000, costCatalog: catalog() });
    const result = await controller.dryRun();
    const request = result.authorizationRequest;

    expect(request.orderedEffects).toHaveLength(16);
    expect(request.providerScopes).toHaveLength(16);
    expect(request.priceLines).toHaveLength(16);
    expect(request.currency).toBe("USD");
    expect(request.maximumAuthorizedCostMicros).toBe(request.orderedEffects.reduce((sum, effect) => sum + effect.estimatedCostMicros, 0));
    expect(request.priceLines!.map((line) => line.provider)).toEqual([...RELEASE_COST_FAMILIES]);
    expect(request.priceLines!.every((line) => line.sourceDocumentSha256.length === 64 && line.quoteSha256.length === 64 && line.quantityNanos > 0)).toBeTrue();
    expect(request.estimateSourceId).not.toContain("release-effect-plan");
    expect(request.estimateSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(request.cleanupByMs).toBeLessThanOrEqual(request.expiresAtMs);

    const persisted = await readFile(join(workspace, "authorization-requests", `${request.authorizationRequestSha256}.json`), "utf8");
    expect(persisted).toContain("priceLines");
    expect(persisted).not.toContain("release-effect-plan");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a changed fresh quote supersedes the old request while preserving its immutable history", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-release-cost-supersede-"));
  try {
    const first = await new ReleaseCertificationController({ candidatePath, workspace, now: () => 1_000, costCatalog: catalog() }).dryRun();
    const second = await new ReleaseCertificationController({ candidatePath, workspace, now: () => 1_001, costCatalog: catalog(1) }).dryRun();
    expect(second.authorizationRequest.authorizationRequestSha256).not.toBe(first.authorizationRequest.authorizationRequestSha256);
    expect(second.authorizationRequest.supersedesAuthorizationRequestSha256).toBe(first.authorizationRequest.authorizationRequestSha256);
    await expect(readFile(join(workspace, "authorization-requests", `${first.authorizationRequest.authorizationRequestSha256}.json`), "utf8")).resolves.toContain(first.authorizationRequest.authorizationRequestSha256);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
