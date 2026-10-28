import { DeterministicPostgresFundingExecutor } from "../../src/persistence/postgres-funding-store";
import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";
import { createFundedCore } from "../../src/phase-03/funded-core";

const principal = "ab".repeat(32);
const settlement = {
  topUpId: "topup-0001",
  rail: "lightning" as const,
  unit: "sat" as const,
  amount: "300",
  externalReference: "lightning-settlement-0001",
  settlementReference: "settlement-0001",
  verifiedAt: "2026-08-04T00:00:00.000Z",
};

function command(kind: "credit_settlement" | "funded_admission", idempotencyKey: string, payload: unknown) {
  return {
    principal: { pubkey: principal },
    kind,
    idempotencyKey,
    policyVersion: "funding-policy-v1",
    protocolVersion: "funding-contract-v1",
    payload,
  };
}

describe("Phase 3 funded-account tracer", () => {
  test("credits one verified settlement, holds the lesser approved cap, exposes redacted status, and replays exactly", async () => {
    const store = new TransactionalMemoryFundingStore();
    const service = new FundingService(store);

    const credit = await service.execute(command("credit_settlement", "credit-0001", { settlement }));
    const accountId = credit.accountId;
    expect(credit).toMatchObject({ status: "credited", accountId: expect.any(String), creditedAmount: "300", unit: "sat" });
    expect(store.postings).toHaveLength(1);
    expect(store.projection(accountId)).toEqual({ settledAvailable: "300", held: "0", unit: "sat" });

    const admissionCommand = command("funded_admission", "admission-0001", {
      requestedCap: "500",
      unit: "sat",
      capacity: { reference: "ready-capacity-0001", usable: true },
    });
    const admission = await service.execute(admissionCommand);
    expect(admission).toMatchObject({ status: "accepted", approvedCap: "300", heldAmount: "300", unit: "sat" });
    expect(store.postings).toHaveLength(1);
    expect(store.projection(accountId)).toEqual({ settledAvailable: "300", held: "300", unit: "sat" });

    const replay = await service.execute(admissionCommand);
    expect(replay).toEqual(admission);
    expect(store.postings).toHaveLength(1);
    expect(store.activeHolds).toHaveLength(1);
    expect(store.evidence).toHaveLength(2);
    expect(store.outbox).toHaveLength(2);

    const status = await service.status({ pubkey: principal });
    expect(status).toMatchObject({ available: "0", held: "300", unit: "sat" });
    expect(JSON.stringify(status)).not.toMatch(/token|proof|preimage|invoice|secret|private|event/i);
  });

  test("rejects conflicts and unsafe settlement/admission inputs without financial or work effects", async () => {
    const store = new TransactionalMemoryFundingStore();
    const service = new FundingService(store);
    const creditCommand = command("credit_settlement", "credit-0001", { settlement });
    await service.execute(creditCommand);
    const before = store.snapshot();

    await expect(service.execute(command("credit_settlement", "credit-0001", { settlement: { ...settlement, amount: "301" } }))).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    await expect(service.execute(command("credit_settlement", "credit-0002", { settlement: { ...settlement, amount: "0" } }))).rejects.toThrow();
    await expect(service.execute(command("funded_admission", "admission-0001", { requestedCap: "500", unit: "sat", capacity: { reference: "no-capacity", usable: false } }))).rejects.toThrow("CAPACITY_UNAVAILABLE");
    expect(store.snapshot()).toEqual(before);
  });

  test("contains a throwing lifecycle observer after the durable settlement result", async () => {
    const store = new TransactionalMemoryFundingStore();
    const service = new FundingService(store, { observe: () => { throw new Error("exporter unavailable"); } });
    const result = await service.execute(command("credit_settlement", "credit-throwing-observer", { settlement: { ...settlement, topUpId: "topup-throwing-observer", externalReference: "external-throwing-observer", settlementReference: "settlement-throwing-observer" } }));
    expect(result).toMatchObject({ status: "credited", creditedAmount: "300" });
    expect(store.postings).toHaveLength(1);
    expect(store.projection(result.accountId)).toEqual({ settledAvailable: "300", held: "0", unit: "sat" });
  });

  test("funded-core forwards settlement lifecycle telemetry without making the observer authoritative", async () => {
    const observations: unknown[] = [];
    const collectorStore = new TransactionalMemoryFundingStore();
    const collectorCore = createFundedCore({ testOnly: true, store: collectorStore, lifecycle: { observe: (observation) => { observations.push(observation); } } });
    const verifiedSettlement = command("credit_settlement", "credit-funded-core-lifecycle", {
      settlement: { ...settlement, topUpId: "topup-funded-core-lifecycle", externalReference: "external-funded-core-lifecycle", settlementReference: "settlement-funded-core-lifecycle" },
    });

    const collectedResult = await collectorCore.funding.execute(verifiedSettlement);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual({
      version: "admission-lifecycle-v1",
      correlationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      stage: "ledger_settlement",
      outcome: "succeeded",
      monotonicMs: expect.any(Number),
    });
    const observation = observations[0] as Record<string, unknown>;
    expect(Number.isFinite(observation.monotonicMs)).toBeTrue();
    expect(Object.keys(observation).sort()).toEqual(["correlationDigest", "monotonicMs", "outcome", "stage", "version"]);
    expect(JSON.stringify(observation)).not.toMatch(/topup|external|settlement-funded-core-lifecycle|ababab/i);

    const throwingStore = new TransactionalMemoryFundingStore();
    const throwingCore = createFundedCore({ testOnly: true, store: throwingStore, lifecycle: { observe: () => { throw new Error("exporter unavailable"); } } });
    const throwingResult = await throwingCore.funding.execute(verifiedSettlement);
    expect(throwingResult).toEqual(collectedResult);
    expect(throwingStore.snapshot()).toEqual(collectorStore.snapshot());
  });
});


test("explicit test-only SQL executor composition constructs its store and credits once", async () => {
  const core = createFundedCore({ testOnly: true, postgresExecutor: new DeterministicPostgresFundingExecutor() });
  const first = await core.funding.execute(command("credit_settlement", "executor-credit-1", { settlement }));
  const replay = await core.funding.execute(command("credit_settlement", "executor-credit-1", { settlement }));
  expect(first).toMatchObject({ status: "credited", creditedAmount: "300" });
  expect(replay).toEqual(first);
});
