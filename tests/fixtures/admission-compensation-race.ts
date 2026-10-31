import { expect } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "./admission-ready";

/** Two real SQL coordinators; local capacity/rail fixture, never live evidence. */
export async function proveAdmissionCompensationWins(pool: PostgresSqlPool) {
  const now = Date.now(), principal = { pubkey: "5".repeat(64) }, database = new PostgresFundingDatabase(pool, { realm: "production-real" });
  const funding = new FundingService(database.funding);
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "compensation-race-seed", policyVersion: "p1", protocolVersion: "v1",
    payload: { settlement: { topUpId: "compensation-race-topup", rail: "lightning", unit: "sat", amount: "100", externalReference: "compensation-race-external",
      settlementReference: "compensation-race-settlement", verifiedAt: new Date(now).toISOString() } } });
  let enterReserve = () => {}, returnReady = () => {}, reserves = 0, releases = 0;
  const entered = new Promise<void>(resolve => { enterReserve = resolve; }), gate = new Promise<void>(resolve => { returnReady = resolve; });
  const reference = `capacity:${"d".repeat(64)}`;
  const open = () => new FundedAdmissionService({ funding, store: database.funding, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => now,
    capacity: {
      async reserveNow(value) { reserves++; enterReserve(); await gate; return exactReadyReservation(value.intentReference, reference, new Date(now + 60_000).toISOString()); },
      async observe(value) { return exactReadyReservation(value.intentReference, reference, new Date(now - 1).toISOString()); },
      async release() { releases++; },
    } });
  const command = { principal, idempotencyKey: "compensation-race", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
  const receipt = await trustedAdmissionReceipt(command), stale = open().admit(command, receipt);
  try {
    await entered;
    expect((await open().admit(command, receipt)).status).toBe("refused");
  } finally { returnReady(); }
  expect((await stale).status).toBe("refused");
  expect({ reserves, releases }).toEqual({ reserves: 1, releases: 1 });
  expect((await funding.status(principal)).held).toBe("0");
  expect((await funding.status(principal)).available).toBe("100");
  expect((await open().admit(command, receipt)).status).toBe("refused");
}

export async function proveAdmissionAcceptanceWins(pool: PostgresSqlPool) {
  const now = Date.now(), principal = { pubkey: "f".repeat(64) }, database = new PostgresFundingDatabase(pool, { realm: "production-real" });
  const funding = new FundingService(database.funding);
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "acceptance-race-seed", policyVersion: "p1", protocolVersion: "v1",
    payload: { settlement: { topUpId: "acceptance-race-topup", rail: "lightning", unit: "sat", amount: "100", externalReference: "acceptance-race-external",
      settlementReference: "acceptance-race-settlement", verifiedAt: new Date(now).toISOString() } } });
  let enterHold = () => {}, commitHold = () => {}, enterFence = () => {}, reserves = 0, releases = 0;
  const holdEntered = new Promise<void>(resolve => { enterHold = resolve; }), gate = new Promise<void>(resolve => { commitHold = resolve; });
  const fenceEntered = new Promise<void>(resolve => { enterFence = resolve; });
  const hooked = (side: "accept" | "compensate"): PostgresSqlPool => ({ async connect() {
    const client = await pool.connect();
    return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      if (side === "accept" && sql.startsWith("INSERT INTO session_cap_holds")) { enterHold(); await gate; }
      if (side === "compensate" && sql.includes("FROM capacity_intents") && sql.includes("FOR UPDATE")) enterFence();
      return client.query<Row>(sql, values);
    }, release() { client.release(); } };
  } });
  const reference = `capacity:${"e".repeat(64)}`;
  const open = (side: "accept" | "compensate") => {
    const store = new PostgresFundingDatabase(hooked(side), { realm: "production-real" }).funding;
    return new FundedAdmissionService({ store, funding: new FundingService(store), receiptAuthority: trustedAdmissionReceiptAuthority, now: () => now,
      capacity: {
        async reserveNow(value) { reserves++; return exactReadyReservation(value.intentReference, reference, new Date(now + 60_000).toISOString()); },
        async observe(value) { return exactReadyReservation(value.intentReference, reference, new Date(now - 1).toISOString()); },
        async release() { releases++; },
      } });
  };
  const command = { principal, idempotencyKey: "acceptance-race", policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
  const receipt = await trustedAdmissionReceipt(command), accepting = open("accept").admit(command, receipt);
  let compensating: ReturnType<FundedAdmissionService["admit"]> | undefined;
  try {
    await holdEntered;
    compensating = open("compensate").admit(command, receipt);
    await fenceEntered;
    expect(releases).toBe(0);
  } finally { commitHold(); }
  const accepted = await accepting;
  expect(accepted.status).toBe("accepted");
  expect(await compensating).toEqual(accepted);
  expect({ reserves, releases }).toEqual({ reserves: 1, releases: 0 });
  expect((await funding.status(principal)).held).toBe("80");
  expect((await funding.status(principal)).available).toBe("20");
}

export async function proveAdmissionCompensationFaults(pool: PostgresSqlPool) {
  const now = Date.now();
  for (const [index, mode] of ["claim-ack", "release-ack", "finalization-ack"].entries()) {
    const principal = { pubkey: "789"[index]!.repeat(64) }, good = new PostgresFundingDatabase(pool, { realm: "production-real" });
    const funding = new FundingService(good.funding);
    await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: `compensation-seed:${mode}`, policyVersion: "p1", protocolVersion: "v1",
      payload: { settlement: { topUpId: `compensation-topup:${mode}`, rail: "lightning", unit: "sat", amount: "100", externalReference: `compensation-external:${mode}`,
        settlementReference: `compensation-settlement:${mode}`, verifiedAt: new Date(now).toISOString() } } });
    let lost = false, reserves = 0, releases = 0, gone = false, visible = false;
    const faultPool: PostgresSqlPool = { async connect() {
      const client = await pool.connect(); let target = false;
      return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        if ((mode === "claim-ack" && sql.startsWith("UPDATE capacity_intents SET state='refused',capacity_reference="))
          || (mode === "finalization-ack" && sql.startsWith("UPDATE capacity_intents SET state='released'"))) target = true;
        const result = await client.query<Row>(sql, values);
        if (sql === "COMMIT" && target && !lost) { lost = true; throw new Error("FIXTURE_COMPENSATION_COMMIT_ACK_LOST"); }
        return result;
      }, release() { client.release(); } };
    } };
    const store = new PostgresFundingDatabase(faultPool, { realm: "production-real" }).funding;
    const reference = `capacity:${"123"[index]!.repeat(64)}`;
    const open = () => new FundedAdmissionService({ store, funding: new FundingService(store), receiptAuthority: trustedAdmissionReceiptAuthority, now: () => now,
      capacity: {
        async reserveNow(value) { reserves++; return exactReadyReservation(value.intentReference, reference, new Date(now - 1).toISOString()); },
        async observe() { throw new Error("FENCED_INTENT_CANNOT_REENTER_READINESS"); },
        async release() { releases++; gone = true; if (mode === "release-ack") throw new Error("FIXTURE_NATIVE_RELEASE_ACK_LOST"); },
        async observeRelease() { return { status: gone && visible ? "terminated" : "unknown" }; },
      } });
    const command = { principal, idempotencyKey: `compensation:${mode}`, policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
    const receipt = await trustedAdmissionReceipt(command), first = await open().admit(command, receipt);
    expect(first.status).toBe("reconciliation_pending");
    if (mode !== "finalization-ack") expect((await open().admit(command, receipt)).status).toBe("reconciliation_pending");
    gone = true; visible = true;
    expect((await open().admit(command, receipt)).status).toBe("refused");
    expect((await open().admit(command, receipt)).status).toBe("refused");
    expect({ reserves, releases }).toEqual({ reserves: 1, releases: mode === "claim-ack" ? 0 : 1 });
    expect((await funding.status(principal)).held).toBe("0");
    const accountId = (await funding.status(principal)).accountId;
    const intent = await good.funding.transact(accountId, tx => tx.findCapacityIntent(command.idempotencyKey));
    if (!intent) throw new Error("COMPENSATION_ORIGINAL_REQUIRED");
    expect(intent.state).toBe("released");
    expect((await good.funding.transact(accountId, tx => tx.recordCapacityObservation({ intentReference: intent.intentReference, state: "available", capacityReference: reference, expiresAt: new Date(now + 60_000).toISOString() }))).state).toBe("released");
    for (const changedReference of ["capacity:substituted", ""]) {
      await expect(good.funding.transact(accountId, tx => tx.recordCapacityObservation({ intentReference: intent.intentReference, state: "available", capacityReference: changedReference, expiresAt: new Date(now + 60_000).toISOString() }))).rejects.toThrow("CAPACITY_REFERENCE_CONFLICT");
    }
    await expect(good.funding.transact(accountId, tx => {
      if (!tx.claimCapacityCompensation) throw new Error("COMPENSATION_FENCE_REQUIRED");
      return tx.claimCapacityCompensation({ idempotencyKey: command.idempotencyKey, intentReference: "capacity-intent:foreign", capacityReference: reference });
    })).rejects.toThrow("CAPACITY_COMPENSATION_BINDING_REQUIRED");
  }
}
