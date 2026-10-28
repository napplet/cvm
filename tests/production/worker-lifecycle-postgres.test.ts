import { createRequire } from "node:module";
import { expect, test } from "bun:test";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../src/release/authorization";
import { createProductionReadyCapacity } from "../../src/production/worker-capacity";
import { createProductionWorkerLifecycle } from "../../src/production/worker-lifecycle";
const postgresIsolation = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${stderr.slice(0, 300)}`);
  return stdout.trim();
}

postgresIsolation("worker lifecycle retains originals across allocation ambiguity, process recovery and expired cleanup observation", async () => {
  const name = `napplet-cvm-worker-lifecycle-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: { query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> } | undefined;
  let application: { connect(): Promise<unknown>; end(): Promise<void> } | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--network", "bridge", "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_UNAVAILABLE");
    const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => typeof admin };
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    const database = admin;
    if (!database) throw new Error("POSTGRES_POOL_UNAVAILABLE");
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try { await database.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); }
    }
    for (const migration of ["migrations/phase-03/001_funding.sql", "migrations/phase-04/001_metered_generation.sql", "migrations/phase-04/002_action_budget_lifecycle.sql", "migrations/phase-03/002_production_accounting.sql", "migrations/phase-07/001_production_operation_journal.sql"]) await database.query(await Bun.file(migration).text());
    await database.query("CREATE ROLE napplet_production_source_build_test LOGIN");
    await database.query("GRANT napplet_production_real TO napplet_production_source_build_test");
    application = new Pool({ connectionString: `postgresql://napplet_production_source_build_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 }) as never;

    let now = 1000, creates = 0, deletes = 0;
    const request = await createAuthorizationRequest({ candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64), effectPlanSha256: "c".repeat(64), controllerStateSha256: "d".repeat(64), providerCapabilitiesSha256: "e".repeat(64), orderedEffects: ["modal", "fly"].map(provider => ({ id: `${provider}-benchmark`, provider: provider as "modal" | "fly", operation: "benchmark" as const, estimatedCostMicros: 1 })), providerScopes: ["modal", "fly"].map(provider => ({ provider: provider as "modal" | "fly", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) })), estimate: { currency: "USD", maximumMicros: 2, sourceId: "fixture", observedAtMs: 1, freshUntilMs: 10000 }, maximumRunDurationMs: 1000, cleanupByMs: 8000, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: 9000 });
    const receipt = await createAuthorizationReceipt(request);
    const authorization = { request, receipt, authorizationRequestSha256: request.authorizationRequestSha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256 };
    const journal = () => new PostgresOperationJournal(application as never, { namespace: "worker-lifecycle-recovery", scopeSha256: "a".repeat(64) });
    const resources = new Map<string, boolean>();
    const workers = Object.fromEntries((["modal", "fly"] as const).map(provider => [provider, {
      async create(value: { operationId: string }) { creates++; resources.set(value.operationId, false); return { status: "unknown" }; },
      async observe(value: { operationId: string }) { return resources.has(value.operationId) && !resources.get(value.operationId) ? { status: "completed", readiness: { readyMonotonicMs: 1000, readinessProbeDigest: `sha256:${"9".repeat(64)}` } } : { status: "missing" }; },
      async observeTermination(value: { operationId: string }) { return { status: resources.get(value.operationId) ? "terminated" : "pending" }; },
      async terminate(value: { operationId: string }) { deletes++; resources.set(value.operationId, true); throw new Error("TERMINATION_ACK_LOST"); },
    }])) as never;
    for (const provider of ["modal", "fly"] as const) {
      now = 1000;
      const capacity = createProductionReadyCapacity({ provider, workers, journal: journal(), image: `registry.example/worker@sha256:${"a".repeat(64)}`, toolchainSha256: "b".repeat(64), flyRegion: "ams", now: () => now });
      const open = () => createProductionWorkerLifecycle({ provider, capacity, journal: journal(), authorization, estimatedCostMicros: 1, now: () => now });
      const plan = { operationId: "worker-original", effectId: `${provider}-benchmark`, region: "ams", desiredDigest: "a".repeat(64) };
      const before = { creates, deletes };
      await open().plan(plan);
      const created = await open().apply(plan);
      expect(created.status).toBe("applied");
      expect(creates).toBe(before.creates + 1);
      expect(await open().apply(plan)).toEqual(created);
      await expect(open().apply({ ...plan, desiredDigest: "b".repeat(64) })).rejects.toThrow("WORKER_LIFECYCLE_ORIGINAL_REQUIRED");
      await expect(open().cleanup({ operationId: plan.operationId, resourceIdentitySha256: "f".repeat(64) })).rejects.toThrow("WORKER_LIFECYCLE_RESOURCE_CHANGED");
      await expect(open().cleanup({ operationId: plan.operationId, resourceIdentitySha256: created.resourceIdentitySha256 })).rejects.toThrow("TERMINATION_ACK_LOST");
      now = 10000;
      expect(await open().cleanup({ operationId: plan.operationId, resourceIdentitySha256: created.resourceIdentitySha256 })).toEqual({ status: "cleaned" });
      expect(creates).toBe(before.creates + 1); expect(deletes).toBe(before.deletes + 1);
      await expect(open().apply({ ...plan, operationId: "new-after-expiry" })).rejects.toThrow("WORKER_LIFECYCLE_ORIGINAL_REQUIRED");
    }
    expect({ creates, deletes }).toEqual({ creates: 2, deletes: 2 });
  } finally {
    await application?.end();
    await admin?.end();
    await docker(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
