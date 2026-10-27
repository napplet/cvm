import { expect, test } from "bun:test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ProductionChaosCertificationService, executeSqlSerializationFault } from "../../src/production/chaos-certification";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../src/release/authorization";
import { D122_FAULT_MATRIX, NO_EFFECTS_ORACLE } from "../../src/resilience/fault-harness";
import type { ProductionConfig } from "../../src/production/config";
import type { ProductionGenerationRuntime } from "../../src/production/generation-runtime";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";

const candidate = "a".repeat(64), topology = "b".repeat(64);
const config = { realm: "production-real", candidateSha256: candidate, topologySha256: topology } as ProductionConfig;
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
test("chaos rejects invalid authorization before connecting to a database", async () => {
  let connects = 0;
  const generation = { config, authorization: { request: {}, receipt: {}, authorizationRequestSha256: topology }, dependencies: { pool: { async connect() { connects++; throw new Error("unexpected connection"); } } } } as unknown as ProductionGenerationRuntime;
  const service = new ProductionChaosCertificationService({ config, generation });
  await expect(service.injectFault({ operationId: "fault-sql", schedule: D122_FAULT_MATRIX[3] })).rejects.toThrow();
  expect(connects).toBe(0);
});

// Actual PostgreSQL-wire mechanism test. This is not Cloud SQL failover or
// protected release evidence and cannot satisfy the other twelve fault rows.
integration("SQL fault obtains real 40001 once and fresh-process recovery only reads originals", async () => {
  const container = `cvm-chaos-${randomUUID()}`;
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 60_000);
    try { const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); if (code) throw new Error(`DOCKER_${args[0]}:${err.slice(-500)}`); return out.trim(); }
    finally { clearTimeout(timer); }
  };
  let admin: Pool | undefined, application: Pool | undefined, started = false;
  try {
    await docker("run", "-d", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"); started = true;
    const port = (await docker("port", container, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)![1];
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; ; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 59) throw error; await Bun.sleep(100); } }
    for (const path of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${path}`).text());
    await admin.query("CREATE ROLE chaos_test LOGIN"); await admin.query("GRANT napplet_production_real TO chaos_test");
    application = new Pool({ connectionString: `postgresql://chaos_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const now = Date.now();
    const request = await createAuthorizationRequest({ candidateSha256: candidate, topologySha256: topology, effectPlanSha256: topology, controllerStateSha256: topology, providerCapabilitiesSha256: topology,
      orderedEffects: [{ id: "sql-fault", provider: "cloud_sql_postgres", operation: "verify_integration", estimatedCostMicros: 1 }], providerScopes: [{ provider: "cloud_sql_postgres", accountScopeSha256: topology, projectScopeSha256: topology }],
      estimate: { currency: "USD", maximumMicros: 1, sourceId: "contract-test", observedAtMs: now - 1000, freshUntilMs: now + 120_000 }, maximumRunDurationMs: 60_000, cleanupByMs: now + 55_000, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["sqladmin.googleapis.com"] }, expiresAtMs: now + 60_000 });
    const receipt = await createAuthorizationReceipt(request);
    const generation = { config, authorization: { request, receipt, authorizationRequestSha256: request.authorizationRequestSha256 }, dependencies: { pool: application } } as unknown as ProductionGenerationRuntime;
    const open = () => new ProductionChaosCertificationService({ config, generation });
    const schedule = D122_FAULT_MATRIX.find(value => value.faultClass === "sql_serialization")!;
    const identity = { operationId: schedule.input.operationId!, sessionId: schedule.initialState.sessionId! };
    const command = { operationId: "fault-sql-original", schedule };
    const dispatched = await open().injectFault(command);
    expect(dispatched as unknown).toEqual({ ...identity, oracle: { activeWriters: 1, effects: NO_EFFECTS_ORACLE } });
    const observation = await open().observeFault(identity);
    expect(observation).toEqual({ ...identity, observed: "serialization_failure", activeWriters: 1, effects: NO_EFFECTS_ORACLE });
    const before = (await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit")).rows[0].count;
    expect(await open().injectFault(command)).toEqual(dispatched);
    expect(await open().reconcile({ operationId: command.operationId, kind: "fault.inject", payload: { schedule } })).toEqual(dispatched);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit")).rows[0].count).toBe(before);
    for (const value of D122_FAULT_MATRIX.filter(value => value !== schedule)) await expect(open().injectFault({ operationId: `fault-${value.id}`, schedule: value })).rejects.toThrow(/PRODUCTION_CHAOS_(BOUNDARY|RELAY)_REQUIRED/u);
    await expect(open().injectFault({ operationId: "replacement-command", schedule })).rejects.toThrow("OPERATION_IDENTITY_CONFLICT");
    await expect(open().observeFault({ ...identity, sessionId: "wrong-session" })).rejects.toThrow("PRODUCTION_CHAOS_ORIGINAL_REQUIRED");
    // The low-level conflict runner also refuses a second attempt after its
    // target row exists, even if a caller lost the error-code observation.
    expect(await executeSqlSerializationFault({ pool: application as unknown as PostgresSqlPool, scopeSha256: topology, operationId: "sql-low-level" })).toBe("40001");
    await expect(executeSqlSerializationFault({ pool: application as unknown as PostgresSqlPool, scopeSha256: topology, operationId: "sql-low-level" })).rejects.toThrow("ORIGINAL_ALREADY_DISPATCHED");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.funding_accounts")).rows[0].count).toBe(0);
    await admin.query("UPDATE production_real.release_operation_journal SET revision=revision+1 WHERE namespace='production-chaos-sql'");
    await expect(open().observeFault(identity)).rejects.toThrow("ORIGINAL_CHANGED");
  } finally {
    await application?.end(); await admin?.end();
    if (started) await docker("rm", "-f", container);
  }
}, 120_000);
