import { expect, test } from "bun:test";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { FundingService } from "../../src/funding/funding-service";
import { FundingCommitOutcomeUnknownError } from "../../src/funding/transaction-outcome";
import { TransactionalMemoryFundingStore, type FundingStore } from "../../src/persistence/funding-store";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";

for (const fault of ["claim-ack", "release-ack", "finalization-ack", "missing-fence"] as const) {
  test(`compensation recovery is original-only across ${fault}`, async () => {
    const now = Date.now(), principal = { pubkey: "a".repeat(64) }, inner = new TransactionalMemoryFundingStore();
    let lost = false, reserves = 0, releases = 0, readiness = 0, observations = 0, terminated = false;
    const store: FundingStore = {
      status: account => inner.status(account), findRecordedResult: (account, key) => inner.findRecordedResult(account, key),
      async transact(account, operation) {
        const result = await inner.transact(account, transaction => operation(fault === "missing-fence" ? { ...transaction, claimCapacityCompensation: undefined } : transaction));
        if (!lost && result && typeof result === "object"
          && ((fault === "claim-ack" && "status" in result && result.status === "claimed") || (fault === "finalization-ack" && "state" in result && result.state === "released"))) {
          lost = true; throw new FundingCommitOutcomeUnknownError(new Error("FIXTURE_COMPENSATION_COMMIT_ACK_LOST"));
        }
        return result;
      },
    };
    const open = () => new FundedAdmissionService({ store, funding: new FundingService(store), now: () => now,
      receiptAuthority: trustedAdmissionReceiptAuthority, capacity: {
        async reserveNow(value) { reserves++; return exactReadyReservation(value.intentReference, "capacity:compensating", new Date(now - 1).toISOString()); },
        async observe() { readiness++; return { status: "unknown" }; },
        async release() { releases++; if (fault === "release-ack") throw new Error("FIXTURE_NATIVE_RELEASE_ACK_LOST"); terminated = true; },
        async observeRelease() { observations++; return { status: terminated ? "terminated" : "unknown" }; },
      } });
    const command = { principal, idempotencyKey: "compensate", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
    const receipt = await trustedAdmissionReceipt(command);
    expect((await open().admit(command, receipt)).status).toBe("reconciliation_pending");
    expect(reserves).toBe(1); expect(releases).toBe(fault === "claim-ack" || fault === "missing-fence" ? 0 : 1);
    expect(inner.activeHolds).toHaveLength(0);
    if (fault === "missing-fence") {
      expect((await open().admit(command, receipt)).status).toBe("reconciliation_pending");
      expect(releases).toBe(0);
    } else {
      if (!terminated) expect((await open().admit(command, receipt)).status).toBe("reconciliation_pending");
      terminated = true;
      expect((await open().admit(command, receipt)).status).toBe("refused");
      expect((await open().admit(command, receipt)).status).toBe("refused");
      expect(readiness).toBe(0);
      expect(observations).toBe(fault === "finalization-ack" ? 0 : 2);
    }
    expect(reserves).toBe(1); expect(releases).toBe(fault === "claim-ack" || fault === "missing-fence" ? 0 : 1);
  });
}

test("older capacity ports cannot substitute readiness refusal for termination proof", async () => {
  const now = Date.now(), inner = new TransactionalMemoryFundingStore();
  let releases = 0, readiness = 0;
  const open = () => new FundedAdmissionService({ store: inner, funding: new FundingService(inner), now: () => now,
    receiptAuthority: trustedAdmissionReceiptAuthority, capacity: {
      async reserveNow(value) { return exactReadyReservation(value.intentReference, "capacity:no-observer", new Date(now - 1).toISOString()); },
      async observe() { readiness++; return { status: "refused" }; },
      async release() { releases++; throw new Error("FIXTURE_RELEASE_UNKNOWN"); },
    } });
  const command = { principal: { pubkey: "a".repeat(64) }, idempotencyKey: "no-observer", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
  const receipt = await trustedAdmissionReceipt(command);
  expect((await open().admit(command, receipt)).status).toBe("reconciliation_pending");
  expect((await open().admit(command, receipt)).status).toBe("reconciliation_pending");
  expect({ releases, readiness }).toEqual({ releases: 1, readiness: 0 });
});
