import { describe, expect, test } from "bun:test";
import {
  DeterministicModelGateway,
  DeterministicGatewayScenarioSchema,
} from "../../src/model/deterministic-model-gateway";
import type { ProviderOperationIntent } from "../../src/model/model-gateway";
import { ModelReconciliationService } from "../../src/model/reconciliation";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

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

const reconciliationPrincipal = { pubkey: "ef".repeat(32) };

async function ambiguousAction(lookup: "receipt_found" | "definitive_not_accepted" | "pending" | "unresolved") {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({
    principal: reconciliationPrincipal, kind: "credit_settlement", idempotencyKey: "reconciliation-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: "reconciliation-topup", rail: "lightning", unit: "sat", amount: "300", externalReference: "reconciliation-external", settlementReference: "reconciliation-settlement", verifiedAt: "2026-08-04T00:00:00.000Z" } },
  });
  const fundedAdmission = new FundedAdmissionService({
    funding, store,
    capacity: { reserveNow: async () => ({ status: "available" as const, reference: "reconciliation-capacity", expiresAt: "2026-08-05T00:00:00.000Z" }), observe: async () => ({ status: "available" as const, reference: "reconciliation-capacity", expiresAt: "2026-08-05T00:00:00.000Z" }), release: async () => {} },
  });
  const admission = await fundedAdmission.admit({ principal: reconciliationPrincipal, idempotencyKey: "reconciliation-admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "200", unit: "sat" } });
  if (admission.status !== "accepted") throw new Error("expected funded admission");
  const gateway = new DeterministicModelGateway({ scenario: { dispatch: "accepted_timeout", lookup } });
  const service = new MeteredGenerationService({ fundedAdmission, store, gateway, worker: { run: async () => { throw new Error("worker must remain fenced"); } } as never, artifactVerifier: { verify: async () => undefined } });
  const started = await service.startSession({ principal: reconciliationPrincipal, admissionReference: admission.reference, idempotencyKey: `reconciliation-${lookup}`, expectedVersion: 0, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
  if (started.status !== "usage_unknown") throw new Error("expected usage_unknown");
  const action = store.meteredActions[0];
  if (!action) throw new Error("expected ambiguous action");
  return { store, gateway, action };
}

describe("reconciliation", () => {
  test("settles one found receipt under concurrent original-operation-only recovery", async () => {
    const { store, gateway, action } = await ambiguousAction("receipt_found");
    const reconciliation = new ModelReconciliationService({ store, gateway });
    const command = { principal: reconciliationPrincipal, sessionId: action.sessionId, actionId: action.actionId, operationId: action.operationId };

    const [first, duplicate] = await Promise.all([reconciliation.reconcile(command), reconciliation.reconcile(command)]);

    expect(first).toMatchObject({ status: "failed", code: "RECONCILED_RECEIPT_FOUND", operationId: action.operationId });
    expect(duplicate).toMatchObject({ status: "failed", code: "RECONCILED_RECEIPT_FOUND", operationId: action.operationId });
    expect(gateway.dispatchCount(action.operationId)).toBe(1);
    expect(gateway.lookupCount(action.operationId)).toBe(1);
    expect(store.postings.filter((posting) => posting.reference === action.operationId)).toHaveLength(1);
  });

  test("keeps pending reconciliation blocked and releases only proven zero-use observations", async () => {
    const pending = await ambiguousAction("pending");
    const pendingResult = await new ModelReconciliationService({ store: pending.store, gateway: pending.gateway }).reconcile({ principal: reconciliationPrincipal, sessionId: pending.action.sessionId, actionId: pending.action.actionId, operationId: pending.action.operationId });
    expect(pendingResult).toMatchObject({ status: "usage_unknown", code: "RECONCILIATION_PENDING" });
    expect(pending.store.meteredActions[0]).toMatchObject({ status: "usage_unknown" });

    const zero = await ambiguousAction("definitive_not_accepted");
    const zeroResult = await new ModelReconciliationService({ store: zero.store, gateway: zero.gateway }).reconcile({ principal: reconciliationPrincipal, sessionId: zero.action.sessionId, actionId: zero.action.actionId, operationId: zero.action.operationId });
    expect(zeroResult).toMatchObject({ status: "failed", code: "PROVIDER_NOT_ACCEPTED" });
    expect(zero.store.postings.filter((posting) => posting.reference === zero.action.operationId)).toHaveLength(1);
    expect(zero.store.postings.find((posting) => posting.reference === zero.action.operationId)?.amount).toBe("-0");
  });
});
