import { expect, test } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { FundingCommitOutcomeUnknownError } from "../../src/funding/transaction-outcome";
import { TransactionalMemoryFundingStore, type FundingStore } from "../../src/persistence/funding-store";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

test("unknown commit errors retain their cause without granting rollback authority", () => {
  const cause = new Error("FIXTURE_LOST_COMMIT_ACK"), error = new FundingCommitOutcomeUnknownError(cause);
  expect(error.cause).toBe(cause); expect(error.message).toBe(cause.message);
  expect(error.name).toBe("FundingCommitOutcomeUnknownError");
});

test("a still-pending original COMMIT remains funded-admission uncertainty until its result becomes visible", async () => {
  const inner = new TransactionalMemoryFundingStore(), principal = { pubkey: "b".repeat(64) }, now = Date.now();
  await new FundingService(inner).execute({ principal, kind: "credit_settlement", idempotencyKey: "seed", policyVersion: "p1", protocolVersion: "v1",
    payload: { settlement: { topUpId: "seed-topup", rail: "lightning", unit: "sat", amount: "100", externalReference: "seed-external",
      settlementReference: "seed-settlement", verifiedAt: new Date(now).toISOString() } } });
  let releaseCommit = () => {}, pending: Promise<unknown> | undefined, reserves = 0, releases = 0;
  const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
  const store: FundingStore = {
    status: account => inner.status(account), findRecordedResult: (account, key) => inner.findRecordedResult(account, key),
    async transact(account, operation) {
      let commitStarted = () => {};
      const started = new Promise<void>(resolve => { commitStarted = resolve; });
      const work = inner.transact(account, async transaction => {
        const result = await operation(transaction);
        if (result && typeof result === "object" && "status" in result && result.status === "accepted") { commitStarted(); await commitGate; }
        return result;
      });
      const outcome = await Promise.race([work.then(value => ({ kind: "complete" as const, value })), started.then(() => ({ kind: "pending" as const }))]);
      if (outcome.kind === "complete") return outcome.value;
      pending = work;
      throw new FundingCommitOutcomeUnknownError(new Error("FIXTURE_COMMIT_STILL_PENDING"));
    },
  };
  const open = () => new FundedAdmissionService({ store, funding: new FundingService(store), now: () => now,
    receiptAuthority: trustedAdmissionReceiptAuthority, capacity: {
      async reserveNow(value) { reserves++; return exactReadyReservation(value.intentReference, "capacity:delayed", new Date(now + 60_000).toISOString()); },
      async observe() { throw new Error("ORIGINAL_COMMIT_MUST_BE_QUERIED"); }, async release() { releases++; },
    } });
  const command = { principal, idempotencyKey: "delayed", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
  const receipt = await trustedAdmissionReceipt(command);
  try {
    expect((await open().admit(command, receipt)).status).toBe("reconciliation_pending");
    expect(inner.activeHolds).toHaveLength(0);
    expect({ reserves, releases }).toEqual({ reserves: 1, releases: 0 });
    if (!pending) throw new Error("EXPECTED_PENDING_ORIGINAL_COMMIT");
  } finally { releaseCommit(); await pending; }
  expect((await open().admit(command, receipt)).status).toBe("accepted");
  expect((await open().admit(command, receipt)).status).toBe("accepted");
  expect(inner.activeHolds).toHaveLength(1);
  expect({ reserves, releases }).toEqual({ reserves: 1, releases: 0 });
});

for (const mutation of ["fingerprint", "capacity", "owner"] as const) {
  test(`admission refuses ${mutation} substitution in committed readback without releasing capacity`, async () => {
    const inner = new TransactionalMemoryFundingStore(), principal = { pubkey: "a".repeat(64) }, now = Date.now();
    await new FundingService(inner).execute({ principal, kind: "credit_settlement", idempotencyKey: "seed", policyVersion: "p1", protocolVersion: "v1",
      payload: { settlement: { topUpId: "seed-topup", rail: "lightning", unit: "sat", amount: "100", externalReference: "seed-external",
        settlementReference: "seed-settlement", verifiedAt: new Date(now).toISOString() } } });
    let committed = false, releases = 0, reserves = 0;
    const store: FundingStore = {
      status: account => inner.status(account),
      async findRecordedResult(account, key) {
        const record = await inner.findRecordedResult(account, key);
        if (!committed || !record || record.result.status !== "accepted") return record;
        if (mutation === "fingerprint") return { ...record, fingerprint: "0".repeat(64) };
        return { ...record, result: { ...record.result, ...(mutation === "capacity" ? { reference: "capacity:substituted" } : { accountId: `account:${"e".repeat(64)}` }) } };
      },
      async transact(account, operation) {
        const result = await inner.transact(account, operation);
        if (result && typeof result === "object" && "status" in result && result.status === "accepted") {
          committed = true; throw new FundingCommitOutcomeUnknownError(new Error("FIXTURE_LOST_COMMIT_ACK"));
        }
        return result;
      },
    };
    const admission = new FundedAdmissionService({ store, funding: new FundingService(store), now: () => now,
      receiptAuthority: trustedAdmissionReceiptAuthority, capacity: {
        async reserveNow(value) { reserves++; return exactReadyReservation(value.intentReference, "capacity:original", new Date(now + 60_000).toISOString()); },
        async observe() { throw new Error("READBACK_MUST_NOT_REDISPATCH"); }, async release() { releases++; },
      } });
    const command = { principal, idempotencyKey: "admit", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
    await expect(admission.admit(command, await trustedAdmissionReceipt(command))).rejects.toThrow(mutation === "fingerprint" ? "IDEMPOTENCY_KEY_CONFLICT" : "FUNDED_ADMISSION_REPLAY_INVALID");
    expect({ reserves, releases }).toEqual({ reserves: 1, releases: 0 });
    expect(inner.activeHolds).toHaveLength(1);
    expect((await new FundingService(inner).status(principal)).held).toBe("80");
  });
}
