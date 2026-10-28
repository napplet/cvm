import { describe, expect, test } from "bun:test";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { ProductionWorkerOwnershipResolver } from "../../src/production/worker-bridge";

const accountId = `account:${"a".repeat(64)}`;
const ownerId = "b".repeat(64);
const request = {
  sessionId: "session:worker-bridge", actionId: "action:worker-bridge", expectedVersion: 0,
  policyVersion: "funding-policy-v1", capabilityGrant: "phase-04-coordinator-grant", workspaceId: "workspace:session:worker-bridge",
  sourceProposalReference: `proposal:sha256:${"c".repeat(64)}`, sourceProposalSha256: "c".repeat(64), sourceProposalFiles: [{ path: "src/main.ts", content: "export {}" }],
};

describe("production worker ownership resolver", () => {
  test("reads only the exact production metered action owner", async () => {
    let released = false; let query = ""; let values: readonly unknown[] = [];
    const resolver = new ProductionWorkerOwnershipResolver({
      policyVersion: "funding-policy-v1",
      pool: { async connect() { return { async query(sql: string, parameters: readonly unknown[]) { query = sql; values = parameters; return { rows: [{ account_id: accountId, owner_id: ownerId }] }; }, release() { released = true; } }; } } as never,
    });
    await expect(resolver.resolve(request)).resolves.toEqual({ accountId, ownerId });
    expect(query).toContain("production_real.metered_actions");
    expect(query).toContain("production_real.funding_accounts");
    expect(values).toEqual([request.sessionId, request.actionId, request.expectedVersion]);
    expect(released).toBe(true);
  });

  test("rejects caller-shaped workspace or grant before database access", async () => {
    let connected = false;
    const resolver = new ProductionWorkerOwnershipResolver({ policyVersion: "funding-policy-v1", pool: { async connect() { connected = true; throw new Error("must not connect"); } } as never });
    await expect(resolver.resolve({ ...request, workspaceId: "workspace:other" })).rejects.toThrow("PRODUCTION_WORKER_REQUEST_BINDING_INVALID");
    expect(connected).toBe(false);
  });

  test("accepts the exact forty-hex worker operation emitted by production capacity", async () => {
    const intentReference = `capacity-intent:${"c".repeat(64)}`;
    const capacityReference = `capacity:${"d".repeat(64)}`;
    const workerOperationId = `capacity:${"e".repeat(40)}`.replace(":", "-");
    const pool = {
      async connect() {
        return {
          async query(sql: string) {
            if (sql.includes("session_user::text AS session_user")) return { rows: [{ current_user: "napplet_runtime", session_user: "napplet_runtime", current_is_superuser: false, session_is_superuser: false }] };
            if (sql === "SET ROLE napplet_production_real") return { rows: [] };
            if (sql === "SELECT current_user::text AS current_user") return { rows: [{ current_user: "napplet_production_real" }] };
            if (sql.includes("SET search_path TO production_real")) return { rows: [] };
            if (sql.includes("FROM production_real.metered_actions")) return { rows: [{ account_id: accountId, owner_id: ownerId, intent_reference: intentReference, capacity_reference: capacityReference }] };
            if (sql.includes("FROM production_real.release_operation_journal")) return { rows: [{ operation_id: `capacity-intent:${"f".repeat(64)}`, identity_sha256: "f".repeat(64), revision: 1, value_json: { intentReference, reference: capacityReference, workerOperationId, provider: "modal", deadlineEpochMs: Date.now() + 60_000 } }] };
            return { rows: [] };
          },
          release() {},
        };
      },
    };
    const journal = new PostgresOperationJournal(pool as never, { namespace: "capacity", scopeSha256: "f".repeat(64) });
    const resolver = new ProductionWorkerOwnershipResolver({ policyVersion: "funding-policy-v1", pool: pool as never, capacityJournal: journal });
    const resolved = await resolver.resolveWorker(request).catch(error => { throw new Error(`WORKER_RESOLUTION:${error instanceof Error ? error.message : String(error)}`); });
    expect(resolved).toMatchObject({ workerOperationId, provider: "modal", capacityReference });
  });
});
