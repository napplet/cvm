import { describe, expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { TransactionalMemoryFundingStore } from "../../src/persistence/funding-store";

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
});
