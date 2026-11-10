import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import type { ModelGateway, ProviderOperationIntent, SourceProposalLookup } from "../../src/model/model-gateway";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

const principal = { pubkey: "ab".repeat(32) };
const proposalSha256 = "a".repeat(64);
const reportSha256 = "b".repeat(64);
const proposal = { reference: `proposal:sha256:${proposalSha256}`, sha256: proposalSha256, files: [{ path: "src/main.ts", content: "export {};" }] };

async function setup() {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "topup", rail: "lightning", unit: "sat", amount: "10000", externalReference: "external", settlementReference: "settlement", verifiedAt: "2026-08-04T00:00:00.000Z" } } });
  const admissions = new FundedAdmissionService({ funding, store, capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "capacity", "2026-08-05T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, "capacity", "2026-08-05T00:00:00.000Z"), release: async () => {} }, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
  const admissionCommand = { principal, idempotencyKey: "admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "6500", unit: "sat" as const } };
  const admission = await admissions.admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
  if (admission.status !== "accepted") throw new Error("expected funded admission");
  return { store, admissions, admission };
}

function receipt(intent: ProviderOperationIntent) {
  return { operationId: intent.operationId, providerRequestId: intent.providerRequestId, provider: "deterministic_fixture" as const, model: "phase-04-fixture-model", profileId: intent.profileId, priceCardId: intent.priceCardId, selection: "unselected" as const, completedAt: "2026-08-04T00:00:01.000Z", provenance: { protectedEvidenceReference: `receipt:${intent.operationId}` }, usage: [{ dimension: "input_tokens" as const, units: "10" }, { dimension: "output_tokens" as const, units: "5" }] };
}

const artifactVerifier: ArtifactVerifier = { async verify(facts) {
  if (facts.result.status !== "completed") return undefined;
  return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "c".repeat(64), scannerReportSha256: "d".repeat(64), conformanceReportSha256: "e".repeat(64) }, contractInput: facts.result.artifact };
} };

function completedWorker(calls: { count: number }): WorkerPort {
  return { async run(request) {
    calls.count += 1;
    return { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: `call:${calls.count}`, evidenceId: `evidence:${calls.count}`, tool: "capture_evidence", label: "generated" } }], artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: `artifact:${request.actionId}`, purpose: { kind: "focused", statements: ["one focused napplet"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:scanner" }, conformance: { verdict: "pass", checkId: "upstream:conformance" } } } };
  } };
}

function repairFixture(input: Readonly<{ validationFailure?: boolean; automatic?: boolean }> = {}) {
  const dispatches: ProviderOperationIntent[] = [];
  const workerCalls = { count: 0 };
  const gateway: ModelGateway = { async dispatch(intent) { dispatches.push(intent); return { status: "completed", receipt: receipt(intent), sourceProposalReference: proposal.reference }; }, async lookup() { throw new Error("unexpected provider lookup"); } };
  const worker: WorkerPort = input.validationFailure === false ? { async run() { return { status: "unavailable", code: "WORKER_UNAVAILABLE" }; } } : { async run(request) {
    workerCalls.count += 1;
    if (workerCalls.count === 1) return { status: "validation_failed", code: "WORKER_VALIDATION_FAILED", failedArtifactId: proposal.reference, validationReportReference: `validation:sha256:${reportSha256}` };
    return completedWorker({ count: workerCalls.count - 1 }).run(request, new AbortController().signal);
  } };
  const proposals: SourceProposalLookup = { async lookup() { return { proposal }; } };
  return { dispatches, workerCalls, gateway, worker, proposals, automatic: input.automatic ?? true };
}

describe("automatic compiler validation repair", () => {
  test("uses one separately metered repair and replays it without a further provider call", async () => {
    const { store, admissions, admission } = await setup();
    const fixture = repairFixture();
    const command = { principal, admissionReference: admission.reference, idempotencyKey: "root", expectedVersion: 0, maximum: "6500", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." };
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway: fixture.gateway, worker: fixture.worker, artifactVerifier, proposalStore: fixture.proposals, automaticValidationRepair: fixture.automatic });

    const [result, duplicate] = await Promise.all([service.startSession(command), service.startSession(command)]);
    expect(result).toMatchObject({ status: "completed", code: "ACTION_COMMITTED", confirmedSpend: "15" });
    expect(duplicate).toEqual(result);
    expect(fixture.dispatches).toHaveLength(2);
    expect(fixture.dispatches[1]?.validationRepair).toEqual({ originOperationId: fixture.dispatches[0]?.operationId, sourceReference: proposal.reference, reportReference: `validation:sha256:${reportSha256}` });
    expect(store.meteredActions).toHaveLength(2);
    expect(store.meteredActions[0]).toMatchObject({ status: "failed", receiptCharge: "15", artifact: { failedArtifactId: proposal.reference, validationReportReference: `validation:sha256:${reportSha256}` } });
    expect(store.meteredActions[1]).toMatchObject({ idempotencyKey: "root:validation-repair", status: "completed", receiptCharge: "15" });

    expect(await service.startSession(command)).toEqual(result);
    const afterRestart = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway: fixture.gateway, worker: fixture.worker, artifactVerifier, proposalStore: fixture.proposals, automaticValidationRepair: true });
    expect(await afterRestart.startSession(command)).toEqual(result);
    expect(fixture.dispatches).toHaveLength(2);

    const root = store.meteredActions[0];
    const repairAction = store.meteredActions[1];
    if (!root || !repairAction) throw new Error("expected retained root and repair actions");
    expect(await afterRestart.recoverRecordedAction({ operationId: repairAction.operationId, command: { principal, sessionId: root.sessionId, admissionReference: repairAction.admissionReference, idempotencyKey: repairAction.idempotencyKey, expectedVersion: repairAction.expectedVersion, maximum: repairAction.maximum.toString(), policyVersion: command.policyVersion, originatingActionId: root.actionId, originatingIdempotencyKey: root.idempotencyKey, workspaceLineage: root.artifact?.workspaceLineage ?? "", snapshotReference: root.artifact?.snapshotReference ?? "", failedArtifactId: root.artifact?.failedArtifactId ?? "", validationReportReference: root.artifact?.validationReportReference ?? "", repair: true } })).toEqual(result);
    expect(fixture.dispatches).toHaveLength(2);
  });

  test("never creates a repair when the root approval covers only one profile ceiling", async () => {
    const { store, admissions, admission } = await setup();
    const fixture = repairFixture();
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway: fixture.gateway, worker: fixture.worker, artifactVerifier, proposalStore: fixture.proposals, automaticValidationRepair: true });
    const result = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "one-ceiling", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    expect(result).toMatchObject({ status: "failed", code: "WORKER_OR_ARTIFACT_FAILED", confirmedSpend: "15" });
    expect(fixture.dispatches).toHaveLength(1);
    expect(store.meteredActions).toHaveLength(1);
  });

  test("does not reinterpret an ordinary worker failure as a compiler repair candidate", async () => {
    const { store, admissions, admission } = await setup();
    const fixture = repairFixture({ validationFailure: false });
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway: fixture.gateway, worker: fixture.worker, artifactVerifier, proposalStore: fixture.proposals, automaticValidationRepair: true });
    const result = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "worker-unavailable", expectedVersion: 0, maximum: "6500", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    expect(result).toMatchObject({ status: "failed", code: "WORKER_OR_ARTIFACT_FAILED" });
    expect(fixture.dispatches).toHaveLength(1);
    expect(store.meteredActions).toHaveLength(1);
  });

  test("never repairs an ambiguous provider operation", async () => {
    const { store, admissions, admission } = await setup();
    let dispatches = 0;
    const gateway: ModelGateway = { async dispatch(intent) { dispatches += 1; return { status: "usage_unknown", operationId: intent.operationId, providerRequestId: intent.providerRequestId, reason: "lost_response", provenance: { protectedEvidenceReference: "provider:ambiguous" } }; }, async lookup() { throw new Error("unexpected lookup"); } };
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker({ count: 0 }), artifactVerifier, automaticValidationRepair: true });
    const result = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "ambiguous-root", expectedVersion: 0, maximum: "6500", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    expect(result).toMatchObject({ status: "usage_unknown", code: "USAGE_UNKNOWN" });
    expect(dispatches).toBe(1);
    expect(store.meteredActions).toHaveLength(1);
  });

  test("stops after the one repair when the repair candidate also fails TypeScript", async () => {
    const { store, admissions, admission } = await setup();
    const dispatches: ProviderOperationIntent[] = [];
    const gateway: ModelGateway = { async dispatch(intent) { dispatches.push(intent); return { status: "completed", receipt: receipt(intent), sourceProposalReference: proposal.reference }; }, async lookup() { throw new Error("unexpected provider lookup"); } };
    const worker: WorkerPort = { async run() { return { status: "validation_failed", code: "WORKER_VALIDATION_FAILED", failedArtifactId: proposal.reference, validationReportReference: `validation:sha256:${reportSha256}` }; } };
    const proposals: SourceProposalLookup = { async lookup() { return { proposal }; } };
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker, artifactVerifier, proposalStore: proposals, automaticValidationRepair: true });
    const command = { principal, admissionReference: admission.reference, idempotencyKey: "repeat-compiler", expectedVersion: 0, maximum: "6500", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." };

    const result = await service.startSession(command);
    expect(result).toMatchObject({ status: "failed", code: "WORKER_OR_ARTIFACT_FAILED", confirmedSpend: "15" });
    expect(dispatches).toHaveLength(2);
    expect(store.meteredActions).toHaveLength(2);
    expect(await service.startSession(command)).toEqual(result);
    expect(dispatches).toHaveLength(2);
  });

  test("rejects caller-supplied repair lineage that does not exactly match the failed root", async () => {
    const { store, admissions, admission } = await setup();
    const fixture = repairFixture();
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway: fixture.gateway, worker: fixture.worker, artifactVerifier, proposalStore: fixture.proposals });
    const root = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "lineage-root", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    if (root.status !== "failed") throw new Error("expected failed root");
    const origin = store.meteredActions[0];
    if (!origin) throw new Error("expected durable root action");

    const result = await service.triggerValidationRepair({ principal, sessionId: root.sessionId, admissionReference: admission.reference, idempotencyKey: "tampered-repair", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", originatingActionId: origin.actionId, originatingIdempotencyKey: origin.idempotencyKey, workspaceLineage: origin.artifact?.workspaceLineage, snapshotReference: origin.artifact?.snapshotReference, failedArtifactId: `proposal:sha256:${"f".repeat(64)}`, validationReportReference: origin.artifact?.validationReportReference });
    expect(result).toEqual({ status: "denied", code: "REPAIR_LINEAGE_UNAVAILABLE" });
    expect(fixture.dispatches).toHaveLength(1);
    expect(store.meteredActions).toHaveLength(1);
  });

  test("lets the owner explicitly approve a fresh repair for a retained compiler failure", async () => {
    const { store, admissions, admission } = await setup();
    const fixture = repairFixture();
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway: fixture.gateway, worker: fixture.worker, artifactVerifier, proposalStore: fixture.proposals });
    const root = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "manual-root", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    if (root.status !== "failed") throw new Error("expected failed root");
    const origin = store.meteredActions[0];
    if (!origin) throw new Error("expected durable root action");

    const repair = await service.reviseSession({ principal, sessionId: root.sessionId, admissionReference: admission.reference, idempotencyKey: "manual-repair", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "Repair the compiler diagnostic.", repairOperationId: origin.operationId });
    expect(repair).toMatchObject({ status: "completed", code: "ACTION_COMMITTED" });
    expect(fixture.dispatches).toHaveLength(2);
    expect(fixture.dispatches[1]?.validationRepair).toEqual({ originOperationId: origin.operationId, sourceReference: proposal.reference, reportReference: `validation:sha256:${reportSha256}` });
    expect(store.meteredActions).toHaveLength(2);
  });

  test("rejects a stale or foreign explicit repair origin before provider dispatch", async () => {
    const { store, admissions, admission } = await setup();
    const fixture = repairFixture();
    const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway: fixture.gateway, worker: fixture.worker, artifactVerifier, proposalStore: fixture.proposals });
    const root = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "stale-root", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    if (root.status !== "failed") throw new Error("expected failed root");
    const origin = store.meteredActions[0];
    if (!origin) throw new Error("expected durable root action");

    const stale = await service.reviseSession({ principal, sessionId: root.sessionId, admissionReference: admission.reference, idempotencyKey: "stale-repair", expectedVersion: 1, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "Repair.", repairOperationId: origin.operationId });
    const foreign = await service.reviseSession({ principal, sessionId: root.sessionId, admissionReference: admission.reference, idempotencyKey: "foreign-repair", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "Repair.", repairOperationId: "operation:foreign" });
    expect(stale).toEqual({ status: "denied", code: "STALE_SESSION_VERSION" });
    expect(foreign).toEqual({ status: "denied", code: "REPAIR_LINEAGE_UNAVAILABLE" });
    expect(fixture.dispatches).toHaveLength(1);
    expect(store.meteredActions).toHaveLength(1);
  });

  test("a new coordinator recovers an already claimed repair by lookup without a second provider post", async () => {
    const { store, admissions, admission } = await setup();
    let releaseRepairDispatch!: () => void;
    const repairEntered = new Promise<void>((resolve) => { releaseRepairDispatch = resolve; });
    let dispatches = 0;
    const gateway: ModelGateway = {
      async dispatch(intent) {
        dispatches += 1;
        if (dispatches === 1) return { status: "completed", receipt: receipt(intent), sourceProposalReference: proposal.reference };
        releaseRepairDispatch();
        return new Promise<never>(() => {});
      },
      async lookup(intent) { return { status: "receipt_found", receipt: receipt(intent), sourceProposalReference: proposal.reference }; },
    };
    let workerCalls = 0;
    const worker: WorkerPort = { async run(request) {
      workerCalls += 1;
      if (workerCalls === 1) return { status: "validation_failed", code: "WORKER_VALIDATION_FAILED", failedArtifactId: proposal.reference, validationReportReference: `validation:sha256:${reportSha256}` };
      return completedWorker({ count: 0 }).run(request, new AbortController().signal);
    } };
    const proposals: SourceProposalLookup = { async lookup() { return { proposal }; } };
    const command = { principal, admissionReference: admission.reference, idempotencyKey: "claimed-repair", expectedVersion: 0, maximum: "6500", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." };
    const original = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker, artifactVerifier, proposalStore: proposals, automaticValidationRepair: true }).startSession(command);
    await repairEntered;
    const recovered = await new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker, artifactVerifier, proposalStore: proposals, automaticValidationRepair: true }).startSession(command);
    expect(recovered).toMatchObject({ status: "completed", code: "ACTION_COMMITTED" });
    expect(dispatches).toBe(2);
    expect(workerCalls).toBe(2);
    void original;
  });
});
