import { expect, test } from "bun:test";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { createNativeHttpModelGateway } from "../../src/release/native/model";
import { createProtectedLiveModelPort } from "../../src/certification/live/model-port";
import { ModelReconciliationService } from "../../src/model/reconciliation";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

const digest = (letter: string) => letter.repeat(64);
const candidateSha256 = digest("a");
const accountScopeSha256 = digest("b");
const endpointScopeSha256 = digest("c");
const priceCardSha256 = digest("d");
const principal = { pubkey: "ef".repeat(32) };

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorizedCapability(urls: Readonly<{ dispatchUrl: string; lookupUrl: string }>) {
  const binding = {
    version: 1,
    candidateSha256,
    endpointReference: "model-endpoint:primary",
    endpointScopeSha256,
    accountReference: "model-account:primary",
    accountScopeSha256,
    dispatchUrl: urls.dispatchUrl,
    lookupUrl: urls.lookupUrl,
    receiptSchemaVersion: "model-usage-v1",
    model: "phase-04-fixture-model",
    modelVersion: "2026-08-04",
    profileId: "code-proposal",
    priceCardId: "phase-04-deterministic-card-2026-08-04",
    priceCardSha256,
    freshUntilMs: 2_000,
  } as const;
  const capabilitySha256 = await sha256(binding);
  const request = await createAuthorizationRequest({
    candidateSha256,
    topologySha256: digest("e"),
    effectPlanSha256: digest("f"),
    controllerStateSha256: digest("1"),
    providerCapabilitiesSha256: capabilitySha256,
    orderedEffects: [{ id: "model.verify", provider: "model", operation: "verify_integration", estimatedCostMicros: 1 }],
    providerScopes: [{ provider: "model", accountScopeSha256, projectScopeSha256: endpointScopeSha256 }],
    estimate: { currency: "USD", maximumMicros: 1, sourceId: "model-capability-v1", observedAtMs: 1_000, freshUntilMs: 2_000 },
    maximumRunDurationMs: 1_000,
    cleanupByMs: 1_400,
    evidenceRetentionDays: 30,
    artifactRetentionDays: 30,
    gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["run.googleapis.com"] },
    expiresAtMs: 1_500,
  });
  return {
    capability: { ...binding, authorizationRequestSha256: request.authorizationRequestSha256 },
    capabilitySha256,
    request,
    receipt: await createAuthorizationReceipt(request),
  };
}

function intent(operationId = "model-original-op") {
  return {
    operationId,
    providerRequestId: operationId,
    accountId: "account:model",
    sessionId: "session:model",
    actionId: "action:model",
    expectedVersion: 0,
    actionBudgetReference: "budget:model",
    profileId: "code-proposal",
    priceCardId: "phase-04-deterministic-card-2026-08-04",
    requestFingerprint: digest("2"),
    maximumUnits: [{ dimension: "input_tokens" as const, units: "1" }],
    selection: "unselected" as const,
  };
}

test("native model gateway binds a candidate capability to one authorized dispatch and redacts credential material", async () => {
  const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() });
      return Response.json({
        status: "completed",
        operationId: "model-original-op",
        providerRequestId: "model-original-op",
        receipt: {
          operationId: "model-original-op",
          providerRequestId: "model-original-op",
          model: "phase-04-fixture-model",
          modelVersion: "2026-08-04",
          profileId: "code-proposal",
          priceCardId: "phase-04-deterministic-card-2026-08-04",
          priceCardSha256,
          completedAt: "2026-08-06T00:00:00.000Z",
          usage: [{ dimension: "input_tokens", units: "1" }],
        },
      });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const authorization = await authorizedCapability({ dispatchUrl: `${base}/dispatch`, lookupUrl: `${base}/lookup` });
    const gateway = await createNativeHttpModelGateway({
      ...authorization,
      credentialReference: "credential-ref:model-primary",
      credentialResolver: { resolve: async () => "private-token-canary" },
      now: () => 1_250,
    });

    const result = await gateway.dispatch(intent(), new AbortController().signal);
    expect(result).toMatchObject({ status: "completed", receipt: { operationId: "model-original-op", provider: "deterministic_fixture", model: "phase-04-fixture-model" } });
    expect(calls).toEqual([expect.objectContaining({ path: "/dispatch", authorization: "Bearer private-token-canary", body: expect.objectContaining({ operationId: "model-original-op" }) })]);
    expect(JSON.stringify({ discovery: gateway.discovery(), evidence: result })).not.toMatch(/private-token|authorization|credential|response|prompt/i);
    expect(JSON.stringify(gateway.discovery())).toContain("credential-ref:model-primary");
  } finally {
    server.stop(true);
  }
});

test("missing lookup, stale capability, mismatched price identity, and malformed provider payload fail closed without replacement dispatch", async () => {
  let dispatches = 0;
  let lookups = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/dispatch") {
        dispatches += 1;
        return Response.json({ status: "completed", operationId: "model-unknown", providerRequestId: "model-unknown", receipt: { operationId: "model-unknown", providerRequestId: "model-unknown", model: "phase-04-fixture-model", modelVersion: "2026-08-04", profileId: "code-proposal", priceCardId: "wrong-card", priceCardSha256, completedAt: "2026-08-06T00:00:00.000Z", usage: [{ dimension: "input_tokens", units: "1" }], rawProviderResponse: "must-not-survive" } });
      }
      lookups += 1;
      return Response.json({ status: "unresolved", operationId: "model-unknown", providerRequestId: "model-unknown" });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const authorization = await authorizedCapability({ dispatchUrl: `${base}/dispatch`, lookupUrl: `${base}/lookup` });
    const gateway = await createNativeHttpModelGateway({ ...authorization, credentialReference: "credential-ref:model", credentialResolver: { resolve: async () => "token" }, now: () => 1_250 });
    const original = intent("model-unknown");
    await expect(gateway.dispatch(original, new AbortController().signal)).resolves.toMatchObject({ status: "usage_unknown", reason: "malformed_receipt" });
    await expect(gateway.lookup(original, new AbortController().signal)).resolves.toMatchObject({ status: "unresolved", operationId: "model-unknown" });
    expect(dispatches).toBe(1);
    expect(lookups).toBe(1);

    await expect(createNativeHttpModelGateway({ ...authorization, capability: { ...authorization.capability, lookupUrl: "" }, credentialReference: "credential-ref:model", credentialResolver: { resolve: async () => "token" }, now: () => 1_250 })).rejects.toThrow();
    await expect(createNativeHttpModelGateway({ ...authorization, capability: { ...authorization.capability, priceCardSha256: digest("9") }, credentialReference: "credential-ref:model", credentialResolver: { resolve: async () => "token" }, now: () => 1_250 })).rejects.toThrow("NATIVE_MODEL_CAPABILITY_DIGEST_MISMATCH");
    await expect(createNativeHttpModelGateway({ ...authorization, credentialReference: "credential-ref:model", credentialResolver: { resolve: async () => "token" }, now: () => 2_000 })).rejects.toThrow("NATIVE_MODEL_CAPABILITY_STALE");
  } finally {
    server.stop(true);
  }
});

test("protected model port reconciles the one persisted ambiguous operation with the exact receipt and no redispatch", async () => {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "model-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "model-topup", rail: "lightning", unit: "sat", amount: "10000", externalReference: "model-external", settlementReference: "model-settlement", verifiedAt: "2026-08-06T00:00:00.000Z" } } });
  const fundedAdmission = new FundedAdmissionService({ funding, store, capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "model-capacity", "2026-08-06T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, "model-capacity", "2026-08-06T00:00:00.000Z"), release: async () => {} }, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => 0 });
  const admissionCommand = { principal, idempotencyKey: "model-admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "6500", unit: "sat" as const } };
  const admission = await fundedAdmission.admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
  if (admission.status !== "accepted") throw new Error("expected accepted admission");

  let dispatches = 0;
  let lookups = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json() as { operationId: string; providerRequestId: string };
      if (new URL(request.url).pathname === "/dispatch") {
        dispatches += 1;
        expect(store.meteredActions).toHaveLength(1);
        return Response.json({ status: "usage_unknown", operationId: body.operationId, providerRequestId: body.providerRequestId });
      }
      lookups += 1;
      return Response.json({ status: "receipt_found", receipt: { operationId: body.operationId, providerRequestId: body.providerRequestId, model: "phase-04-fixture-model", modelVersion: "2026-08-04", profileId: "code-proposal", priceCardId: "phase-04-deterministic-card-2026-08-04", priceCardSha256, completedAt: "2026-08-06T00:00:00.000Z", usage: [{ dimension: "input_tokens", units: "1" }] } });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const authorization = await authorizedCapability({ dispatchUrl: `${base}/dispatch`, lookupUrl: `${base}/lookup` });
    const gateway = await createNativeHttpModelGateway({ ...authorization, credentialReference: "credential-ref:model", credentialResolver: { resolve: async () => "token" }, now: () => 1_250 });
    const service = new MeteredGenerationService({ fundedAdmission, store, gateway, worker: { run: async () => { throw new Error("worker must stay fenced"); } } as never, artifactVerifier: { verify: async () => undefined } });
    const started = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "model-action", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    expect(started).toMatchObject({ status: "usage_unknown" });
    const action = store.meteredActions[0]!;
    const port = createProtectedLiveModelPort({
      candidateSha256,
      request: authorization.request,
      receipt: authorization.receipt,
      gateway,
      reconciliation: new ModelReconciliationService({ store, gateway }),
      reconciliationCommand: { principal, sessionId: action.sessionId, actionId: action.actionId, operationId: action.operationId },
      now: () => 1_250,
    });
    await expect(port.reconcileOriginalModelOperation({ candidateId: candidateSha256 })).resolves.toEqual({ status: "passed", operationId: action.operationId, lookupUsesOriginalOperationOnly: true, dispatchCount: 1, debitCount: 1, cancellationOrAmbiguityVisible: true });
    expect(dispatches).toBe(1);
    expect(lookups).toBe(1);
    expect(store.postings.filter((posting) => posting.reference === action.operationId)).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});
