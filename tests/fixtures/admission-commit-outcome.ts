import { expect } from "bun:test";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "./admission-ready";

/** Actual restricted SQL commit faults; rail/capacity are local fixtures. */
export async function proveAdmissionCommitOutcomes(pool: PostgresSqlPool) {
  const now = Date.now();
  for (const [index, mode] of ["after", "before", "readback-unavailable", "rollback"].entries()) {
    const principal = { pubkey: String(index + 1).repeat(64) };
    const good = new PostgresFundingDatabase(pool, { realm: "production-real" });
    const seed = new FundingService(good.funding);
    await seed.execute({ principal, kind: "credit_settlement", idempotencyKey: `commit-seed:${mode}`, policyVersion: "p1", protocolVersion: "v1",
      payload: { settlement: { topUpId: `commit-topup:${mode}`, rail: "lightning", unit: "sat", amount: "100", externalReference: `commit-external:${mode}`,
        settlementReference: `commit-settlement:${mode}`, verifiedAt: new Date(now).toISOString() } } });
    let faulted = false, readbackFaults = 0;
    const faultPool: PostgresSqlPool = { async connect() {
      const client = await pool.connect(); let holds = false;
      return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        if (sql.startsWith("INSERT INTO session_cap_holds")) {
          holds = true;
          if (mode === "rollback" && !faulted) { faulted = true; throw new Error("FIXTURE_ADMISSION_PRECOMMIT_FAILURE"); }
        }
        if (mode === "readback-unavailable" && faulted && readbackFaults === 0 && sql.includes("FROM funding_commands")) {
          readbackFaults++; throw new Error("FIXTURE_ADMISSION_READBACK_UNAVAILABLE");
        }
        const lose = sql === "COMMIT" && holds && !faulted;
        if (lose && mode === "before") { faulted = true; throw new Error("FIXTURE_ADMISSION_COMMIT_RESPONSE_LOST"); }
        const result = await client.query<Row>(sql, values);
        if (lose) { faulted = true; throw new Error("FIXTURE_ADMISSION_COMMIT_RESPONSE_LOST"); }
        return result;
      }, release() { client.release(); } };
    } };
    const database = new PostgresFundingDatabase(faultPool, { realm: "production-real" });
    let reserves = 0, releases = 0;
    const open = () => new FundedAdmissionService({ store: database.funding, funding: new FundingService(database.funding), now: () => now,
      receiptAuthority: trustedAdmissionReceiptAuthority, capacity: {
        async reserveNow(value) { reserves++; return exactReadyReservation(value.intentReference, `capacity:${"789a"[index]!.repeat(64)}`, new Date(now + 60_000).toISOString()); },
        async observe(value) { return exactReadyReservation(value.intentReference, `capacity:${"789a"[index]!.repeat(64)}`, new Date(now + 60_000).toISOString()); },
        async release() { releases++; },
      } });
    const command = { principal, idempotencyKey: `commit-admission:${mode}`, policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
    const receipt = await trustedAdmissionReceipt(command), first = await open().admit(command, receipt);
    expect(faulted).toBe(true);
    expect(first.status).toBe(mode === "after" ? "accepted" : mode === "rollback" ? "refused" : "reconciliation_pending");
    expect(releases).toBe(mode === "rollback" ? 1 : 0);
    const repeated = await open().admit(command, receipt);
    expect(repeated.status).toBe(mode === "rollback" ? "refused" : "accepted");
    expect(await open().admit(command, receipt)).toEqual(repeated);
    expect(reserves).toBe(1); expect(releases).toBe(mode === "rollback" ? 1 : 0);
    expect((await seed.status(principal)).held).toBe(mode === "rollback" ? "0" : "80");
    expect((await seed.status(principal)).available).toBe(mode === "rollback" ? "100" : "20");
    const client = await pool.connect();
    try {
      const status = await seed.status(principal);
      const result = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM production_real.funding_commands WHERE account_id=$1 AND idempotency_key=$2", [status.accountId, command.idempotencyKey]);
      expect(result.rows[0]?.count).toBe(mode === "rollback" ? 0 : 1);
      const holds = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM production_real.session_cap_holds WHERE account_id=$1", [status.accountId]);
      expect(holds.rows[0]?.count).toBe(mode === "rollback" ? 0 : 1);
    } finally { client.release(); }
    expect(readbackFaults).toBe(mode === "readback-unavailable" ? 1 : 0);
  }
}
