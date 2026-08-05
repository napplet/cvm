import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import type { ModelGateway } from "../../src/model/model-gateway";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import type { WorkerPort } from "../../src/phase-02/contracts";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { exactReadyReservation, trustedAdmissionReceipt } from "../fixtures/admission-ready";

const principal = { pubkey: "ab".repeat(32) };

function worker(effects: { workers: number }): WorkerPort {
  return { async run() { effects.workers += 1; throw new Error("must not run"); } };
}

const verifier: ArtifactVerifier = { async verify() { throw new Error("must not verify"); } };

async function setup(input: Readonly<{ credit: string; requestedCap: string }>) {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  await funding.execute({
    principal, kind: "credit_settlement", idempotencyKey: `credit:${input.credit}:${input.requestedCap}`,
    policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: `topup:${input.credit}:${input.requestedCap}`, rail: "lightning", unit: "sat", amount: input.credit, externalReference: `external:${input.credit}:${input.requestedCap}`, settlementReference: `settlement:${input.credit}:${input.requestedCap}`, verifiedAt: "2026-08-05T00:00:00.000Z" } },
  });
  let budgetAuthorizations = 0;
  const admissions = new FundedAdmissionService({
    funding,
    store,
    capacity: { reserveNow: async ({ intentReference }) => exactReadyReservation(intentReference, `capacity:${input.credit}:${input.requestedCap}`, "2026-08-06T00:00:00.000Z"), observe: async ({ intentReference }) => exactReadyReservation(intentReference, `capacity:${input.credit}:${input.requestedCap}`, "2026-08-06T00:00:00.000Z"), release: async () => {} },
    now: () => Date.parse("2026-08-05T00:00:00.000Z"),
  });
  const authorizeActionBudget = admissions.authorizeActionBudget.bind(admissions);
  admissions.authorizeActionBudget = async (value) => { budgetAuthorizations += 1; return authorizeActionBudget(value); };
  const admission = await admissions.admit({ principal, idempotencyKey: `admission:${input.credit}:${input.requestedCap}`, policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: input.requestedCap, unit: "sat" } }, trustedAdmissionReceipt);
  if (admission.status !== "accepted") throw new Error("test admission must be accepted");
  const effects = { dispatches: 0, workers: 0 };
  const gateway: ModelGateway = { async dispatch() { effects.dispatches += 1; throw new Error("must not dispatch"); }, async lookup() { return { status: "not_found" }; } };
  const service = new MeteredGenerationService({ fundedAdmission: admissions, store, gateway, worker: worker(effects), artifactVerifier: verifier, clock: { nowMs: () => 1_700_000_000_000 } });
  return { admission, budgetAuthorizations: () => budgetAuthorizations, effects, service, store };
}

describe("funding interruption before every new effect", () => {
  test("persists and exactly replays a balance-only pause before budget, provider, worker, or debit effects", async () => {
    const fixture = await setup({ credit: "4000", requestedCap: "3250" });
    const command = { principal, admissionReference: fixture.admission.reference, idempotencyKey: "balance-shortfall", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." };

    const first = await fixture.service.startSession(command);
    const replay = await fixture.service.startSession(command);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "needs_top_up", actionMaximum: "3250", requiredAdditionalFunding: "2500", requiredCapApproval: "0",
      settledBalance: "4000", availableBalance: "750", remainingCap: "3250", graceDeadlineMs: 1_700_000_600_000,
    });
    expect(fixture.budgetAuthorizations()).toBe(0);
    expect(fixture.effects).toEqual({ dispatches: 0, workers: 0 });
    expect(fixture.store.meteredActions).toEqual([]);
    expect(fixture.store.postings).toHaveLength(1);
    const durablePause = await fixture.store.transact(first.accountId, (transaction) => transaction.findContinuationPause(first.sessionId, 1));
    expect(durablePause).toMatchObject({
      state: "needs_top_up",
      graceDeadlineMs: first.graceDeadlineMs,
      liveLeaseToken: expect.stringMatching(/^lease:live:pending:/u),
      intent: { reference: first.pendingActionReference, actionMaximum: first.actionMaximum, expectedSessionVersion: 0 },
      result: first,
    });
  });

  test("reports independent cap and balance shortfalls without extending the first deadline", async () => {
    const capOnly = await setup({ credit: "10000", requestedCap: "3000" });
    const capResult = await capOnly.service.startSession({ principal, admissionReference: capOnly.admission.reference, idempotencyKey: "cap-shortfall", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." });
    expect(capResult).toMatchObject({ status: "needs_top_up", requiredAdditionalFunding: "0", requiredCapApproval: "250", availableBalance: "7000", remainingCap: "3000" });

    const both = await setup({ credit: "2000", requestedCap: "3250" });
    const first = await both.service.startSession({ principal, admissionReference: both.admission.reference, idempotencyKey: "both-shortfalls", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." });
    const duplicate = await both.service.startSession({ principal, admissionReference: both.admission.reference, idempotencyKey: "both-shortfalls", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." });
    expect(first).toMatchObject({ status: "needs_top_up", requiredAdditionalFunding: "3250", requiredCapApproval: "1250", availableBalance: "0", remainingCap: "2000" });
    expect(duplicate).toEqual(first);
  });

  test("keeps an exact balance and cap eligible, while altered reuse of a paused idempotency key fails closed", async () => {
    const exact = await setup({ credit: "6500", requestedCap: "3250" });
    const eligible = await exact.service.startSession({ principal, admissionReference: exact.admission.reference, idempotencyKey: "exact", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." });
    expect(eligible.status).not.toBe("needs_top_up");
    expect(exact.budgetAuthorizations()).toBe(1);

    const paused = await setup({ credit: "4000", requestedCap: "3250" });
    const command = { principal, admissionReference: paused.admission.reference, idempotencyKey: "conflict", expectedVersion: 0, maximum: "3250", policyVersion: "phase-02-policy-2026-08-04", idea: "Build one focused counter napplet." };
    await paused.service.startSession(command);
    await expect(paused.service.startSession({ ...command, idea: "Build a different focused counter napplet." })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    expect(paused.budgetAuthorizations()).toBe(0);
    expect(paused.effects).toEqual({ dispatches: 0, workers: 0 });
  });
});
