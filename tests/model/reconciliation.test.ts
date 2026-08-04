import { describe, expect, test } from "bun:test";
import {
  DeterministicModelGateway,
  DeterministicGatewayScenarioSchema,
} from "../../src/model/deterministic-model-gateway";
import type { ProviderOperationIntent } from "../../src/model/model-gateway";

const intent = (operationId = "operation:gateway"): ProviderOperationIntent => ({
  operationId,
  accountId: "account:gateway",
  sessionId: "session:gateway",
  actionId: "action:gateway",
  expectedVersion: 0,
  actionBudgetReference: "budget:gateway",
  profileId: "profile:deterministic-v1",
  priceCardId: "card:deterministic-v1",
  requestFingerprint: "a".repeat(64),
  maximumUnits: [
    { dimension: "input_tokens", units: "10" },
    { dimension: "output_tokens", units: "20" },
  ],
  selection: "unselected",
});

describe("gateway", () => {
  test("returns a strict authoritative receipt from an unselected deterministic fixture", async () => {
    const gateway = new DeterministicModelGateway({
      scenario: DeterministicGatewayScenarioSchema.parse({ dispatch: "completed", lookup: "receipt_found" }),
      now: () => "2026-08-04T00:00:00.000Z",
    });

    const result = await gateway.dispatch(intent(), new AbortController().signal);

    expect(result).toMatchObject({ status: "completed", receipt: {
      operationId: "operation:gateway", provider: "deterministic_fixture", selection: "unselected",
      profileId: "profile:deterministic-v1", priceCardId: "card:deterministic-v1",
    } });
    if (result.status !== "completed") throw new Error("expected completed receipt");
    expect(result.receipt.provenance.protectedEvidenceReference).toContain("fixture-evidence:");
    expect(result.receipt.provenance.protectedEvidenceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(gateway.dispatchCount("operation:gateway")).toBe(1);
    expect(gateway.lookupCount("operation:gateway")).toBe(0);
  });

  test("preserves the original operation after accepted timeout and lookup never redispatches", async () => {
    const gateway = new DeterministicModelGateway({
      scenario: { dispatch: "accepted_timeout", lookup: "receipt_found" },
    });
    const original = intent("operation:timeout");

    const dispatch = await gateway.dispatch(original, new AbortController().signal);
    const lookup = await gateway.lookup(original, new AbortController().signal);

    expect(dispatch).toMatchObject({ status: "usage_unknown", operationId: original.operationId, providerRequestId: "deterministic:operation:timeout" });
    expect(lookup).toMatchObject({ status: "receipt_found", receipt: { operationId: original.operationId, providerRequestId: "deterministic:operation:timeout" } });
    expect(gateway.dispatchCount(original.operationId)).toBe(1);
    expect(gateway.lookupCount(original.operationId)).toBe(1);
  });

  test("turns malformed and mismatched native receipts into ambiguity rather than priced usage", async () => {
    for (const scenario of ["malformed_receipt", "mismatched_receipt"] as const) {
      const gateway = new DeterministicModelGateway({ scenario: { dispatch: scenario, lookup: "unresolved" } });
      const result = await gateway.dispatch(intent(`operation:${scenario}`), new AbortController().signal);

      expect(result).toMatchObject({ status: "usage_unknown", reason: scenario });
      expect(gateway.dispatchCount(`operation:${scenario}`)).toBe(1);
    }
  });

  test("models pending, definitive zero-use, and unresolved lookup states without a dispatch", async () => {
    for (const lookup of ["pending", "definitive_not_accepted", "unresolved"] as const) {
      const gateway = new DeterministicModelGateway({ scenario: { dispatch: "lost_response", lookup } });
      const original = intent(`operation:${lookup}`);
      const result = await gateway.lookup(original, new AbortController().signal);

      expect(result.status).toBe(lookup);
      expect(gateway.dispatchCount(original.operationId)).toBe(0);
      expect(gateway.lookupCount(original.operationId)).toBe(1);
    }
  });
});
