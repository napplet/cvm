import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import type { ModelGateway } from "../../src/model/model-gateway";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import { exactReadyReservation, trustedAdmissionReceipt } from "../fixtures/admission-ready";

const principal = { pubkey: "ab".repeat(32) };

async function fundedDependencies() {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({
    principal, kind: "credit_settlement", idempotencyKey: "credit-1", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: "topup-1", rail: "lightning", unit: "sat", amount: "10000", externalReference: "lightning-1", settlementReference: "settlement-1", verifiedAt: "2026-08-04T00:00:00.000Z" } },
  });
  const admissions = new FundedAdmissionService({
    funding, store,
    capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "capacity-1", "2026-08-05T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, "capacity-1", "2026-08-05T00:00:00.000Z"), release: async () => {} },
    now: () => Date.parse("2026-08-04T00:00:00.000Z"),
  });
  const admission = await admissions.admit({ principal, idempotencyKey: "admission-1", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "6500", unit: "sat" } }, trustedAdmissionReceipt);
  if (admission.status !== "accepted") throw new Error("test funding admission did not succeed");
  return { store, admissions, admission };
}

function completedWorker(counter: { workers: number }): WorkerPort {
  return { async run(request) {
    counter.workers += 1;
    return {
      status: "completed", code: "WORKER_PROPOSALS_VALIDATED",
      events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: "call-1", evidenceId: "evidence-1", tool: "capture_evidence", label: "generated" } }],
      artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: "artifact-1", purpose: { kind: "focused", statements: ["one focused napplet"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:scanner" }, conformance: { verdict: "pass", checkId: "upstream:conformance" } } },
    };
  } };
}

const verifier: ArtifactVerifier = { async verify(facts) {
  if (facts.result.status !== "completed") return undefined;
  return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact };
} };

describe("Phase 04 funded start tracer", () => {
  test("settles one persisted provider intent, then replays concurrent duplicates without new effects", async () => {
    const { store, admissions, admission } = await fundedDependencies();
    const effects = { dispatches: 0, workers: 0 };
    const gateway: ModelGateway = {
      async dispatch(intent) { effects.dispatches += 1; return { status: "completed", receipt: { operationId: intent.operationId, providerRequestId: intent.providerRequestId, provider: "deterministic_fixture", model: "phase-04-fixture-model", profileId: intent.profileId, priceCardId: intent.priceCardId, selection: "unselected", completedAt: "2026-08-04T00:00:01.000Z", provenance: { protectedEvidenceReference: "provider-evidence-1" }, usage: [{ dimension: "input_tokens", units: "10" }, { dimension: "output_tokens", units: "5" }] } }; },
      async lookup() { return { status: "not_found" }; },
    };
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker(effects), artifactVerifier: verifier });
    const command = { principal, admissionReference: admission.reference, idempotencyKey: "start-1", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." };

    const [first, duplicate] = await Promise.all([service.startSession(command), service.startSession(command)]);

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ status: "completed", sessionId: expect.any(String), sessionVersion: 1, artifactVersion: 1, confirmedSpend: "15", remainingCap: "6485", nextAction: "revise_session" });
    expect(effects).toEqual({ dispatches: 1, workers: 1 });
    expect(store.meteredActions).toHaveLength(1);
    expect(store.meteredActions[0]).toMatchObject({ status: "completed", receiptCharge: "15" });
    expect(store.projection(first.accountId)).toEqual({ settledAvailable: "9985", held: "6485", unit: "sat" });
  });

  test("denies invalid text before budget, provider, worker, ledger, or artifact effects", async () => {
    const { store, admissions, admission } = await fundedDependencies();
    const effects = { dispatches: 0, workers: 0 };
    const gateway: ModelGateway = { async dispatch() { effects.dispatches += 1; throw new Error("must not dispatch"); }, async lookup() { return { status: "not_found" }; } };
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker(effects), artifactVerifier: verifier });

    const result = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "invalid-1", expectedVersion: 0, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", idea: "" });

    expect(result).toMatchObject({ status: "denied", code: "INPUT_REQUIRED" });
    expect(effects).toEqual({ dispatches: 0, workers: 0 });
    expect(store.meteredActions).toEqual([]);
    expect(store.activeHolds).toHaveLength(1);
  });

  test("rejects a one-sat approval before creating or dispatching provider work", async () => {
    const { store, admissions, admission } = await fundedDependencies();
    const effects = { dispatches: 0, workers: 0 };
    const gateway: ModelGateway = { async dispatch() { effects.dispatches += 1; throw new Error("must not dispatch"); }, async lookup() { return { status: "not_found" }; } };
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker(effects), artifactVerifier: verifier });

    const result = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "one-sat", expectedVersion: 0, maximum: "1", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });

    expect(result).toMatchObject({ status: "denied", code: "ACTION_MAXIMUM_BELOW_PROFILE_CEILING" });
    expect(effects).toEqual({ dispatches: 0, workers: 0 });
    expect(store.meteredActions).toEqual([]);
  });
});
