import { describe, expect, test } from "bun:test";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

const admissionReference = "admission:grace-wake";
const liveLeaseToken = "lease:original-worker";
const pendingFingerprint = "a".repeat(64);
const deadlineMs = 1_700_000_600_000;

type Effects = { authorizations: number; actions: number; model: number; tool: number; build: number; network: number; provider: number; debit: number };

async function setup(input: Readonly<{ credited?: boolean; cap: string; nowMs?: number }> = { cap: "3250" }) {
  const store = new TransactionalMemoryFundingStore();
  const funding = new FundingService(store);
  const accountId = await accountIdForPrincipal({ pubkey: "ab".repeat(32) });
  await funding.execute({
    principal: { pubkey: "ab".repeat(32) }, kind: "credit_settlement", idempotencyKey: "initial-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { settlement: { topUpId: "initial", rail: "lightning", unit: "sat", amount: input.cap, externalReference: "external:initial", settlementReference: "settlement:initial", verifiedAt: "2026-08-05T00:00:00.000Z" } },
  });
  await funding.execute({
    principal: { pubkey: "ab".repeat(32) }, kind: "funded_admission", idempotencyKey: "admission", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
    payload: { requestedCap: input.cap, unit: "sat", capacity: { usable: true, reference: admissionReference } },
  });
  await store.transact(accountId, (transaction) => transaction.pauseForFunding({
    accountId, sessionId: "session:grace-wake", admissionReference, idempotencyKey: "pause:grace-wake", fingerprint: "b".repeat(64), pendingFingerprint,
    expectedSessionVersion: 4, pauseGeneration: 1, graceDeadlineMs: deadlineMs, liveLeaseToken,
    intent: { accountId, sessionId: "session:grace-wake", idempotencyKey: "pause:grace-wake", fingerprint: pendingFingerprint, reference: "pending:grace-wake", actionKind: "revise_session", boundedPayloadHash: "d".repeat(64), expectedSessionVersion: 4, expectedArtifactVersion: 4, policyVersion: "policy:grace-wake", priceCardId: "price:grace-wake", profileId: "profile:grace-wake", toolchainId: "toolchain:grace-wake", actionMaximum: "3250", admissionReference },
    result: { status: "needs_top_up", code: "ACTION_AFFORDABILITY_REQUIRED", accountId, sessionId: "session:grace-wake", pendingActionReference: "pending:grace-wake", pendingActionFingerprint: pendingFingerprint, pendingActionKind: "revise_session", actionMaximum: "3250", requiredAdditionalFunding: "3250", requiredCapApproval: "0", settledBalance: input.cap, availableBalance: "0", remainingCap: input.cap, graceDeadlineMs: deadlineMs, checkpoint: { state: "live_worker", reference: "checkpoint-pending:grace-wake" }, nextRequiredAction: "top_up" },
  }));
  if (input.credited) {
    await funding.execute({
      principal: { pubkey: "ab".repeat(32) }, kind: "credit_settlement", idempotencyKey: "verified-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1",
      payload: { settlement: { topUpId: "verified", rail: "cashu", unit: "sat", amount: "3250", externalReference: "external:verified", settlementReference: "settlement:verified", verifiedAt: "2026-08-05T00:01:00.000Z" } },
    });
  }
  const effects: Effects = { authorizations: 0, actions: 0, model: 0, tool: 0, build: 0, network: 0, provider: 0, debit: 0 };
  const service = new ContinuationService({ store, clock: { nowMs: () => input.nowMs ?? deadlineMs - 1 } });
  const wake = (overrides: Partial<Parameters<typeof service.wakePausedAction>[0]> = {}) => service.wakePausedAction({
    accountId, sessionId: "session:grace-wake", pauseGeneration: 1, liveLeaseToken, pendingFingerprint, expectedSessionVersion: 4, expectedArtifactVersion: 4,
    onAuthorized: async () => { effects.actions += 1; effects.model += 1; effects.tool += 1; effects.build += 1; effects.network += 1; effects.provider += 1; effects.debit += 1; },
    onAuthorization: () => { effects.authorizations += 1; }, ...overrides,
  });
  return { accountId, effects, funding, service, store, wake };
}

describe("verified-credit grace wake", () => {
  test("uses only durable verified credit before the deadline to authorize and continue once on the original lease", async () => {
    const fixture = await setup({ credited: true, cap: "3250" });
    expect(fixture.effects).toEqual({ authorizations: 0, actions: 0, model: 0, tool: 0, build: 0, network: 0, provider: 0, debit: 0 });

    const first = await fixture.wake();
    const duplicate = await fixture.wake();

    expect(first).toMatchObject({ status: "continued", leaseToken: liveLeaseToken, pendingActionReference: "pending:grace-wake" });
    expect(duplicate).toMatchObject({ status: "replayed" });
    expect(fixture.effects).toEqual({ authorizations: 1, actions: 1, model: 1, tool: 1, build: 1, network: 1, provider: 1, debit: 1 });
    expect(fixture.store.projection(fixture.accountId)).toMatchObject({ settledAvailable: "6500", held: "3250" });
  });

  test("makes notification-only, cap-insufficient, stale, foreign, deadline, reconnect, and reordered hints stable no-effects", async () => {
    const noCredit = await setup({ cap: "3250" });
    const capOnly = await setup({ credited: true, cap: "3000" });
    const deadline = await setup({ credited: true, cap: "3250", nowMs: deadlineMs });
    const afterDeadline = await setup({ credited: true, cap: "3250", nowMs: deadlineMs + 1 });

    await expect(noCredit.wake()).resolves.toMatchObject({ status: "no_effect", code: "VERIFIED_CREDIT_REQUIRED" });
    await expect(capOnly.wake()).resolves.toMatchObject({ status: "no_effect", code: "APPROVED_CAP_INSUFFICIENT" });
    await expect(deadline.wake()).resolves.toMatchObject({ status: "no_effect", code: "GRACE_DEADLINE_EXPIRED" });
    await expect(afterDeadline.wake()).resolves.toMatchObject({ status: "no_effect", code: "GRACE_DEADLINE_EXPIRED" });
    await expect((await setup({ credited: true, cap: "3250" })).wake({ accountId: "account:foreign" })).resolves.toMatchObject({ status: "no_effect", code: "PAUSE_NOT_FOUND_OR_DENIED" });
    await expect((await setup({ credited: true, cap: "3250" })).wake({ liveLeaseToken: "lease:stale" })).resolves.toMatchObject({ status: "no_effect", code: "STALE_LIVE_LEASE" });
    await expect((await setup({ credited: true, cap: "3250" })).wake({ expectedSessionVersion: 5 })).resolves.toMatchObject({ status: "no_effect", code: "STALE_SESSION_VERSION" });
    await expect((await setup({ credited: true, cap: "3250" })).wake({ pendingFingerprint: "c".repeat(64) })).resolves.toMatchObject({ status: "no_effect", code: "PENDING_ACTION_MISMATCH" });
    expect(noCredit.effects.actions + capOnly.effects.actions + deadline.effects.actions + afterDeadline.effects.actions).toBe(0);
  });

  test("concurrent eligible hints converge on exactly one fresh authorization and continuation", async () => {
    const fixture = await setup({ credited: true, cap: "3250" });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => fixture.wake()));
    expect(outcomes.filter((outcome) => outcome.status === "continued")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "replayed")).toHaveLength(7);
    expect(fixture.effects.authorizations).toBe(1);
    expect(fixture.effects.actions).toBe(1);
  });

  test("two independent coordinators claim one durable wake effect and complete the old pause", async () => {
    const fixture = await setup({ credited: true, cap: "3250" });
    let externalDispatches = 0;
    const options = (continuation: ContinuationService) => ({ fundedAdmission: {} as never, store: fixture.store, gateway: {} as never, worker: {} as never, artifactVerifier: {} as never, continuation, clock: { nowMs: () => deadlineMs - 1 }, continuationWake: { continueAction: async () => { externalDispatches += 1; } } });
    const left = new MeteredGenerationService(options(new ContinuationService({ store: fixture.store, clock: { nowMs: () => deadlineMs - 1 } })));
    const right = new MeteredGenerationService(options(new ContinuationService({ store: fixture.store, clock: { nowMs: () => deadlineMs - 1 } })));
    const hint = { accountId: fixture.accountId, sessionId: "session:grace-wake", pauseGeneration: 1, liveLeaseToken, pendingFingerprint, expectedSessionVersion: 4, expectedArtifactVersion: 4 };
    const outcomes = await Promise.all([left.wakePausedAction(hint), right.wakePausedAction(hint)]);
    expect(outcomes.filter((outcome) => outcome.status === "continued")).toHaveLength(1);
    expect(externalDispatches).toBe(1);
    expect(await fixture.store.sessionStatus(fixture.accountId, "session:grace-wake")).toMatchObject({ status: "active" });
    expect(await fixture.store.transact(fixture.accountId, (tx) => tx.findContinuationPause("session:grace-wake", 1))).toMatchObject({ state: "completed", liveLeaseToken: undefined });
  });

  test("a dispatch throw is durably unknown and never blindly redispatched", async () => {
    const fixture = await setup({ credited: true, cap: "3250" });
    let externalDispatches = 0;
    const service = new MeteredGenerationService({ fundedAdmission: {} as never, store: fixture.store, gateway: {} as never, worker: {} as never, artifactVerifier: {} as never, continuation: fixture.service, clock: { nowMs: () => deadlineMs - 1 }, continuationWake: { continueAction: async () => { externalDispatches += 1; throw new Error("WORKER_CONNECTION_LOST"); } } });
    const hint = { accountId: fixture.accountId, sessionId: "session:grace-wake", pauseGeneration: 1, liveLeaseToken, pendingFingerprint, expectedSessionVersion: 4, expectedArtifactVersion: 4 };
    await expect(service.wakePausedAction(hint)).rejects.toThrow("WORKER_CONNECTION_LOST");
    await expect(service.wakePausedAction(hint)).resolves.toMatchObject({ status: "replayed", code: "WAKE_RECONCILIATION_REQUIRED" });
    expect(externalDispatches).toBe(1);
    expect(await fixture.store.sessionStatus(fixture.accountId, "session:grace-wake")).toMatchObject({ status: "active" });
  });

  test("recovery still denies every pending/session/artifact fence mismatch", async () => {
    const fixture = await setup({ credited: true, cap: "3250" });
    await fixture.wake();
    await expect(fixture.wake({ pendingFingerprint: "c".repeat(64) })).resolves.toMatchObject({ status: "no_effect", code: "PENDING_ACTION_MISMATCH" });
    await expect(fixture.wake({ expectedSessionVersion: 5 })).resolves.toMatchObject({ status: "no_effect", code: "STALE_SESSION_VERSION" });
    await expect(fixture.wake({ expectedArtifactVersion: 5 })).resolves.toMatchObject({ status: "no_effect", code: "STALE_ARTIFACT_VERSION" });
  });
});
