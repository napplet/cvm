import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { type ModelGateway } from "../../src/model/model-gateway";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { type WorkerPort } from "../../src/phase-02/contracts";
import { type ArtifactVerifier } from "../../src/phase-02/trusted-core";
import { MeteredGenerationService, ReviseSessionCommandSchema } from "../../src/phase-04/metered-generation-service";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

const principal = { pubkey: "ab".repeat(32) };

function completedWorker(effects: { workers: number }): WorkerPort {
  return { async run(request) {
    effects.workers += 1;
    return {
      status: "completed", code: "WORKER_PROPOSALS_VALIDATED",
      events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, callId: `call:${request.actionId}`, evidenceId: `evidence:${request.actionId}`, tool: "capture_evidence", label: "generated" } }],
      artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: `artifact:${request.actionId}`, purpose: { kind: "focused", statements: ["one focused napplet"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:scanner" }, conformance: { verdict: "pass", checkId: "upstream:conformance" } } },
    };
  } };
}

const verifier: ArtifactVerifier = { async verify(facts) {
  if (facts.result.status !== "completed") return undefined;
  return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact };
} };

async function setup(artifactVerifier = verifier) {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "topup", rail: "lightning", unit: "sat", amount: "10000", externalReference: "external", settlementReference: "settlement", verifiedAt: "2026-08-04T00:00:00.000Z" } } });
  const admissions = new FundedAdmissionService({
    funding, store,
    capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "capacity", "2026-08-05T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, "capacity", "2026-08-05T00:00:00.000Z"), release: async () => {} },
    receiptAuthority: trustedAdmissionReceiptAuthority,
    now: () => Date.parse("2026-08-04T00:00:00.000Z"),
  });
  const command = { principal, idempotencyKey: "admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "6500", unit: "sat" as const } };
  const admission = await admissions.admit(command, await trustedAdmissionReceipt(command));
  if (admission.status !== "accepted") throw new Error("test admission must be accepted");
  const effects = { dispatches: 0, workers: 0 };
  const gateway: ModelGateway = { async dispatch(intent) {
    effects.dispatches += 1;
    return { status: "completed", receipt: { operationId: intent.operationId, providerRequestId: intent.providerRequestId, provider: "deterministic_fixture", model: "phase-04-fixture-model", profileId: intent.profileId, priceCardId: intent.priceCardId, selection: "unselected", completedAt: "2026-08-04T00:00:01.000Z", provenance: { protectedEvidenceReference: `receipt:${intent.operationId}` }, usage: [{ dimension: "input_tokens", units: "10" }, { dimension: "output_tokens", units: "5" }] } };
  }, async lookup(intent) { return { status: "unresolved", operationId: intent.operationId, providerRequestId: intent.providerRequestId, provenance: { protectedEvidenceReference: `unresolved:${intent.operationId}` } }; } };
  const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker(effects), artifactVerifier });
  const initial = await service.startSession({ principal, admissionReference: admission.reference, idempotencyKey: "start", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." });
  if (initial.status !== "completed") throw new Error("test start must be completed");
  return { admission, admissions, effects, gateway, initial, service, store };
}

describe("same-lineage revisions", () => {
  test("a claimed revision recovers before readiness and affordability checks using the same held budget", async () => {
    const { admission, admissions, effects, gateway, initial, service, store } = await setup();
    const command = { principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "lost-revision", expectedVersion: 1, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "Change the counter color." };
    gateway.dispatch = async () => { effects.dispatches++; throw new Error("FIXTURE_LOST_ACK"); };
    gateway.lookup = async intent => ({ status: "receipt_found", receipt: { operationId: intent.operationId, providerRequestId: intent.providerRequestId, provider: "deterministic_fixture", model: "phase-04-fixture-model", profileId: intent.profileId, priceCardId: intent.priceCardId, selection: "unselected", completedAt: "2026-08-04T00:00:02.000Z", provenance: { protectedEvidenceReference: `receipt:${intent.operationId}` }, usage: [{ dimension: "input_tokens", units: "10" }, { dimension: "output_tokens", units: "5" }] } });
    expect((await service.reviseSession(command)).status).toBe("usage_unknown");
    const prepared = await store.findMeteredAction(initial.accountId, command.idempotencyKey);
    const recovered = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: completedWorker(effects), artifactVerifier: verifier });
    const result = await recovered.reviseSession(command);
    expect(result).toMatchObject({ status: "completed", sessionVersion: 2, confirmedSpend: "15" });
    expect(await recovered.reviseSession(command)).toEqual(result);
    expect(effects).toEqual({ dispatches: 2, workers: 2 });
    expect((await store.findMeteredAction(initial.accountId, command.idempotencyKey))?.actionBudgetReference).toBe(prepared?.actionBudgetReference);
    expect((await store.listMeteredActionsForSession(initial.accountId, initial.sessionId)).length).toBe(2);
  });

  test("a fresh coordinator recovers a claimed operation by lookup without a second provider post", async () => {
    const store = new TransactionalMemoryFundingStore();
    const funding = new FundingService(store);
    await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "claim-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "claim-topup", rail: "lightning", unit: "sat", amount: "10000", externalReference: "claim-external", settlementReference: "claim-settlement", verifiedAt: "2026-08-04T00:00:00.000Z" } } });
    const admissions = new FundedAdmissionService({ funding, store, capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, "claim-capacity", "2026-08-05T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, "claim-capacity", "2026-08-05T00:00:00.000Z"), release: async () => {} }, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => Date.parse("2026-08-04T00:00:00.000Z") });
    const command = { principal, idempotencyKey: "claim-admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "6500", unit: "sat" as const } };
    const admission = await admissions.admit(command, await trustedAdmissionReceipt(command));
    if (admission.status !== "accepted") throw new Error("expected admission");
    let dispatches = 0;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { release = resolve; });
    const effects = { workers: 0 };
    const gateway: ModelGateway = {
      dispatch: async () => { dispatches += 1; release(); return new Promise<never>(() => {}); },
      lookup: async (intent) => ({
        status: "receipt_found",
        receipt: {
          operationId: intent.operationId, providerRequestId: intent.providerRequestId,
          provider: "deterministic_fixture", model: "phase-04-fixture-model",
          profileId: intent.profileId, priceCardId: intent.priceCardId, selection: "unselected",
          completedAt: "2026-08-04T00:00:01.000Z",
          provenance: { protectedEvidenceReference: `receipt:${intent.operationId}` },
          usage: [{ dimension: "input_tokens", units: "10" }, { dimension: "output_tokens", units: "5" }],
        },
      }),
    };
    const options = { fundedAdmission: admissions, store, gateway, worker: completedWorker(effects), artifactVerifier: verifier };
    const first = new MeteredGenerationService(options).startSession({ principal, admissionReference: admission.reference, idempotencyKey: "claimed-operation", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    await entered;
    const recovered = await new MeteredGenerationService(options).startSession({ principal, admissionReference: admission.reference, idempotencyKey: "claimed-operation", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused napplet." });
    expect(recovered).toMatchObject({ status: "completed", code: "ACTION_COMMITTED" });
    expect(dispatches).toBe(1);
    expect(effects.workers).toBe(1);
    void first;
  });

  test("persists ambiguous provider acceptance when dispatch throws", async () => {
    const { admission, effects, gateway, initial, service, store } = await setup();
    gateway.dispatch = async () => {
      effects.dispatches += 1;
      throw new Error("response lost after provider acceptance");
    };
    const result = await service.reviseSession({ principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "dispatch-throws", expectedVersion: 1, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "A bounded update." });
    expect(result).toMatchObject({ status: "usage_unknown", code: "USAGE_UNKNOWN" });
    expect(store.meteredActions.at(-1)).toMatchObject({ status: "usage_unknown", providerReceiptReference: expect.stringContaining("dispatch-error:") });
    expect(effects.dispatches).toBe(2);
    expect(await service.reviseSession({ principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "must-not-retry-unknown", expectedVersion: 1, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "Try again." })).toMatchObject({ status: "denied", code: "SESSION_NOT_REVISION_READY" });
    expect(effects.dispatches).toBe(2);
  });

  test("holds a receipt-backed novel settlement failure instead of inventing provider ambiguity", async () => {
    const { admission, admissions, effects, gateway, initial, store } = await setup();
    const service = new MeteredGenerationService({
      fundedAdmission: admissions, store, gateway, worker: completedWorker(effects), artifactVerifier: verifier,
      settlement: {
        async prepare() { return { maximum: "3250" }; },
        async finalize() { throw new Error("NEW_DETERMINISTIC_LEDGER_VALIDATION_FAILURE"); },
      },
    });
    const command = { principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "novel-settlement-failure", expectedVersion: 1, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "A bounded update." };
    const result = await service.reviseSession(command);
    expect(result).toMatchObject({ status: "billing_invariant_failed", code: "ACCOUNTING_SETTLEMENT_FAILED" });
    expect((await store.findMeteredAction(initial.accountId, command.idempotencyKey))).toMatchObject({ status: "billing_invariant_failed" });
    expect(effects.dispatches).toBe(2);
    expect(await service.reviseSession(command)).toEqual(result);
    expect(effects.dispatches).toBe(2);
  });

  test("a failed revision retains the verified base for a new explicit action and exact replay", async () => {
    let fail = false;
    const { admission, effects, initial, service, store } = await setup({ verify: async (facts) => fail ? undefined : verifier.verify(facts) });
    const command = { principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "invalid-revision", expectedVersion: 1, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "Make a focused change." };
    fail = true;
    expect(await service.reviseSession(command)).toMatchObject({ status: "failed", artifactVersion: 1 });
    expect(await store.sessionStatus(initial.accountId, initial.sessionId)).toMatchObject({ status: "failed", version: 1 });
    const original = store.meteredActions[0]!.artifact;
    fail = false;
    const next = { ...command, idempotencyKey: "corrected-revision", revision: "Try a simpler focused change." };
    const result = await service.reviseSession(next);
    expect(result).toMatchObject({ status: "completed", artifactVersion: 2, sessionId: initial.sessionId });
    expect(await service.reviseSession(next)).toEqual(result);
    expect(store.meteredActions[0]!.artifact).toEqual(original);
    expect(effects).toEqual({ dispatches: 3, workers: 3 });
  });

  test("parses exactly one bounded revision field", () => {
    expect(ReviseSessionCommandSchema.parse({ principal, sessionId: "session:stable", admissionReference: "admission", idempotencyKey: "revision", expectedVersion: 1, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", revision: "Make the counter support a reset action." }).revision).toContain("reset");
    expect(() => ReviseSessionCommandSchema.parse({ principal, sessionId: "session:stable", admissionReference: "admission", idempotencyKey: "revision", expectedVersion: 1, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", revision: "", idea: "forbidden second text field" })).toThrow();
  });

  test("creates one new action on the same session and exactly replays its duplicate", async () => {
    const { admission, effects, initial, service, store } = await setup();
    const command = { principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "revision-1", expectedVersion: 1, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "Make the counter support a reset action." };
    const [first, replay] = await Promise.all([service.reviseSession(command), service.reviseSession(command)]);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: "completed", sessionId: initial.sessionId, sessionVersion: 2, artifactVersion: 2, nextAction: "revise_session" });
    expect(effects).toEqual({ dispatches: 2, workers: 2 });
    expect(store.meteredActions).toHaveLength(2);
    const actionIds = store.meteredActions.map((action) => action.actionId);
    expect(actionIds).toEqual([expect.stringMatching(/^start:[a-f0-9]{24}$/u), expect.stringMatching(/^revision:[a-f0-9]{24}$/u)]);
    expect(new Set(actionIds).size).toBe(2);
  });

  test("denies foreign, stale, and simultaneous writers before duplicate provider effects", async () => {
    const { admission, effects, initial, service, store } = await setup();
    const empty = await service.reviseSession({ principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "empty", expectedVersion: 1, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", revision: "" });
    const malformed = await service.reviseSession({ principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "malformed", expectedVersion: 1, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", revision: "\ud800" });
    const repository = await service.reviseSession({ principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "repository", expectedVersion: 1, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", revision: "Use https://github.com/example/private-app.git as the source." });
    const stale = await service.reviseSession({ principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "stale", expectedVersion: 0, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", revision: "A bounded update." });
    const foreign = await service.reviseSession({ principal, sessionId: "session:wrong-lineage", admissionReference: admission.reference, idempotencyKey: "foreign", expectedVersion: 1, maximum: "100", policyVersion: "phase-02-policy-2026-08-04", revision: "A bounded update." });
    const left = { principal, sessionId: initial.sessionId, admissionReference: admission.reference, idempotencyKey: "left", expectedVersion: 1, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", revision: "First contender." };
    const right = { ...left, idempotencyKey: "right", revision: "Second contender." };
    const concurrent = await Promise.all([service.reviseSession(left), service.reviseSession(right)]);

    expect(empty).toMatchObject({ status: "denied", code: "INPUT_REQUIRED" });
    expect(malformed).toMatchObject({ status: "denied", code: "INPUT_MALFORMED_UNICODE" });
    expect(repository).toMatchObject({ status: "denied", code: "INPUT_REPOSITORY_OR_CODE" });
    expect(stale).toMatchObject({ status: "denied", code: "STALE_SESSION_VERSION" });
    expect(foreign).toMatchObject({ status: "denied", code: "SESSION_LINEAGE_MISMATCH" });
    expect(concurrent.filter((result) => result.status === "completed")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "denied")).toHaveLength(1);
    expect(effects).toEqual({ dispatches: 2, workers: 2 });
    expect(store.meteredActions).toHaveLength(2);
  });
});
