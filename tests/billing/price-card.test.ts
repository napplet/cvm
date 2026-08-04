import { describe, expect, test } from "bun:test";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, maximumOperationCharge, priceReceipt } from "../../src/model/price-card";

function receipt(usage: readonly { dimension: "input_tokens" | "output_tokens" | "cached_tokens" | "reasoning_tokens"; units: string }[]) {
  return {
    operationId: "operation-1", providerRequestId: "provider-request-1", provider: "deterministic_fixture" as const, model: "phase-04-fixture-model",
    profileId: "code-proposal", priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id, selection: "unselected" as const,
    completedAt: "2026-08-04T00:00:01.000Z", provenance: { protectedEvidenceReference: "provider-evidence-1" }, usage,
  };
}

describe("Phase 04 deterministic price card", () => {
  test("discloses deterministic identity, unit ceilings, and ceil rounding without a floating point boundary", () => {
    expect(PHASE_04_DETERMINISTIC_PRICE_CARD).toMatchObject({ kind: "deterministic_fixture", currency: "sat", rounding: "ceil", ceilings: { inputTokens: expect.any(String), outputTokens: expect.any(String) } });
    expect(maximumOperationCharge({ card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] })).toBe("3000");
  });

  test("prices every dimension in canonical order and retains quotient/remainder evidence", () => {
    const forward = priceReceipt({ receipt: receipt([{ dimension: "reasoning_tokens", units: "3" }, { dimension: "cached_tokens", units: "3" }, { dimension: "output_tokens", units: "1" }, { dimension: "input_tokens", units: "2" }]), card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"], reservation: "20" });
    const reverse = priceReceipt({ receipt: receipt([{ dimension: "input_tokens", units: "2" }, { dimension: "output_tokens", units: "1" }, { dimension: "cached_tokens", units: "3" }, { dimension: "reasoning_tokens", units: "3" }]), card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"], reservation: "20" });
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({ status: "priced", total: "11", lines: [{ dimension: "cached_tokens", quotient: "1", remainder: "1", charge: "2" }, { dimension: "input_tokens", charge: "2" }, { dimension: "output_tokens", charge: "1" }, { dimension: "reasoning_tokens", charge: "6" }] });
  });

  test("fails closed for an unauthorized card/profile identity or receipt total above reservation", () => {
    expect(priceReceipt({ receipt: { ...receipt([{ dimension: "input_tokens", units: "1" }]), priceCardId: "different-card" }, card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] })).toEqual({ status: "billing_invariant_failed", code: "RECEIPT_PRICE_IDENTITY_MISMATCH" });
    expect(priceReceipt({ receipt: receipt([{ dimension: "input_tokens", units: "900719925474099300000" }]), card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"], reservation: "1" })).toEqual({ status: "billing_invariant_failed", code: "RECEIPT_EXCEEDS_RESERVATION" });
  });
});
