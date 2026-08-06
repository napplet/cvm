import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReleaseCertificationController } from "../../src/release/controller";
import { RELEASE_COST_FAMILIES } from "../../src/release/costs/live-estimator";
import { createAuthorizationReceipt } from "../../src/release/authorization";

const candidatePath = join(import.meta.dir, "..", "..", "toolchains/candidates/initial.json");
const digest = (letter: string) => letter.repeat(64);

function fixtureCatalog() {
  return { listPriceFacts: async () => RELEASE_COST_FAMILIES.map((provider, index) => ({
    provider, sourceId: `${provider}-loopback`, sourceDocumentSha256: digest((index % 16).toString(16)), quoteSha256: digest(((index + 1) % 16).toString(16)),
    currency: "USD", unit: "operation", priceMicros: index + 1, observedAtMs: 900, freshUntilMs: 20_000, status: "available",
  })) };
}

test("the pre-approval controller path performs only sixteen fake discovery and price reads", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-release-readiness-"));
  let discoveryCalls = 0;
  let priceCalls = 0;
  let effects = 0;
  try {
    const result = await new ReleaseCertificationController({
      candidatePath, workspace, now: () => 1_000,
      providers: Object.fromEntries(RELEASE_COST_FAMILIES.map((provider) => [provider, { discover: async () => { discoveryCalls += 1; return { capability: "available" as const, authentication: "not_configured" as const, accountScopeSha256: digest("a"), costEstimateSha256: digest("b"), secretReferenceNames: [], reasonCode: "AUTHORIZATION_REQUIRED" as const }; } }])) as never,
      costCatalog: { listPriceFacts: async (input) => { priceCalls += 1; return fixtureCatalog().listPriceFacts(input); } },
    }).dryRun();
    expect(result.state.status).toBe("authorization_required");
    expect(discoveryCalls).toBe(16);
    expect(priceCalls).toBe(1);
    expect(effects).toBe(0);
    expect(result.authorizationRequest.priceLines).toHaveLength(16);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("a structured deny-effects fixture receipt can enter receipt_valid without execution", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-release-receipt-"));
  try {
    const controller = new ReleaseCertificationController({ candidatePath, workspace, now: () => 1_000, costCatalog: fixtureCatalog() });
    const pending = await controller.dryRun();
    const receipt = await createAuthorizationReceipt(pending.authorizationRequest);
    const validated = await controller.validateStructuredReceipt(receipt);
    expect(validated.state.status).toBe("receipt_valid");
    expect(validated.state.authorizationReceiptSha256).toBe(receipt.authorizationReceiptSha256);
    expect(validated.state.providerOperationIds).toEqual([]);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
