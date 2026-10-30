import { ProductionCertificationCoreServices } from "../../src/production/certification-services";
import { createPostgresWorkerOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { PRODUCTION_WORKER_POLICY } from "../../src/worker-adapters/production-worker-policy";
import { createRequire } from "node:module";
import { expect, test } from "bun:test";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../src/release/authorization";
import { createProductionReadyCapacity } from "../../src/production/worker-capacity";
import { createProductionWorkerLifecycle } from "../../src/production/worker-lifecycle";
import { createMountedReleaseCleanup } from "../../src/production/release-cleanup";
import { proveFlyMissingIdCleanup, proveModalMissingIdCleanup } from "../fixtures/worker-missing-id-cleanup";
import { proveMissingIdReadiness } from "../fixtures/worker-missing-id-readiness";
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

    let now = 1000, creates = 0, deletes = 0, wrongResource = false;
    const request = await createAuthorizationRequest({ candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64), effectPlanSha256: "c".repeat(64), controllerStateSha256: "d".repeat(64), providerCapabilitiesSha256: "e".repeat(64), orderedEffects: ["modal", "fly"].map(provider => ({ id: `${provider}-benchmark`, provider: provider as "modal" | "fly", operation: "benchmark" as const, estimatedCostMicros: 1 })), providerScopes: ["modal", "fly"].map(provider => ({ provider: provider as "modal" | "fly", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) })), estimate: { currency: "USD", maximumMicros: 2, sourceId: "fixture", observedAtMs: 1, freshUntilMs: 10000 }, maximumRunDurationMs: 1000, cleanupByMs: 8000, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: 9000 });
    const receipt = await createAuthorizationReceipt(request);
    const authorization = { request, receipt, authorizationRequestSha256: request.authorizationRequestSha256, authorizationReceiptSha256: receipt.authorizationReceiptSha256 };
    const journal = () => new PostgresOperationJournal(application as never, { namespace: "worker-lifecycle-recovery", scopeSha256: "a".repeat(64) });
    const resources = new Map<string, boolean>();
    const workerJournal = new PostgresOperationJournal(application as never, { namespace: "capacity-provider-originals", scopeSha256: "a".repeat(64) });
    const providerJournal = createPostgresWorkerOperationJournal(workerJournal);
    const workers = Object.fromEntries((["modal", "fly"] as const).map(provider => [provider, {
      async create(value: { operationId: string; sessionLeaseSha256: string; toolchainSha256: string; providerDeadlineEpochMs: number; region?: string }) {
        creates++; resources.set(value.operationId, false);
        await providerJournal.claim({ ...value, provider, resourceName: value.operationId, requestSha256: "c".repeat(64), image: `registry.example/worker@sha256:${"a".repeat(64)}`, policyVersion: PRODUCTION_WORKER_POLICY.version, createdAtMs: now });
        await providerJournal.update({ operationId: value.operationId, requestSha256: "c".repeat(64), state: "unknown", resourceId: value.operationId });
        return { status: "unknown" };
      },
      async observe(value: { operationId: string }) { return resources.has(value.operationId) && !resources.get(value.operationId) ? { status: "completed", resourceId: wrongResource ? "replaced-resource" : value.operationId, readiness: { readyMonotonicMs: 1000, readinessProbeDigest: `sha256:${"9".repeat(64)}` } } : { status: "missing" }; },
      async observeTermination(value: { operationId: string }) { return { status: resources.get(value.operationId) ? "terminated" : "pending" }; },
      async terminate(value: { operationId: string }) { deletes++; resources.set(value.operationId, true); throw new Error("TERMINATION_ACK_LOST"); },
    }])) as never;
    for (const provider of ["modal", "fly"] as const) {
      now = 1000;
      const capacity = createProductionReadyCapacity({ provider, workers, journal: journal(), workerJournal, image: `registry.example/worker@sha256:${"a".repeat(64)}`, toolchainSha256: "b".repeat(64), flyRegion: "ams", now: () => now });
      const open = () => createProductionWorkerLifecycle({ provider, capacity, journal: journal(), authorization, estimatedCostMicros: 1, now: () => now });
      const plan = { operationId: "worker-original", effectId: `${provider}-benchmark`, region: "ams", desiredDigest: "a".repeat(64) };
      const before = { creates, deletes };
      await open().plan(plan);
      const created = await open().apply(plan);
      expect(created.status).toBe("applied");
      expect(await open().observeCleanup({ operationId: plan.operationId, resourceIdentitySha256: created.resourceIdentitySha256 })).toEqual({ status: "pending" });
      expect(creates).toBe(before.creates + 1);
      const rows = await database.query("SELECT operation_id,value_json FROM production_real.release_operation_journal WHERE namespace='worker-lifecycle-recovery' AND value_json ->> 'provider'=$1 AND operation_id LIKE 'capacity-intent:%'", [provider]);
      expect(rows.rows.length).toBe(1);
      const retained = rows.rows[0]!.value_json as { intentReference: string; expectedSessionBindingDigest: string; reference: string; execution: unknown };
      const changed = createProductionReadyCapacity({ provider, workers, journal: journal(), workerJournal, image: `registry.example/worker@sha256:${"d".repeat(64)}`, toolchainSha256: "e".repeat(64), flyRegion: "ams", now: () => now });
      for (const pin of [
        { image: `registry.example/worker@sha256:${"d".repeat(64)}`, toolchainSha256: "b".repeat(64), flyRegion: "ams" },
        { image: `registry.example/worker@sha256:${"a".repeat(64)}`, toolchainSha256: "e".repeat(64), flyRegion: "ams" },
        ...(provider === "fly" ? [{ image: `registry.example/worker@sha256:${"a".repeat(64)}`, toolchainSha256: "b".repeat(64), flyRegion: "iad" }] : []),
      ]) {
        const incompatible = createProductionReadyCapacity({ provider, workers, journal: journal(), workerJournal, ...pin, now: () => now });
        await expect(incompatible.reserveNow(retained)).rejects.toThrow("PRODUCTION_CAPACITY_ORIGINAL_PROFILE_REQUIRED");
      }
      const makeCapacity = (name: "modal" | "fly") => createProductionReadyCapacity({ provider: name, workers, journal: journal(), workerJournal, image: `registry.example/worker@sha256:${"a".repeat(64)}`, toolchainSha256: "b".repeat(64), flyRegion: "ams", now: () => now });
      const router = new ProductionCertificationCoreServices({ candidates: { modal: "a".repeat(64), fly: "a".repeat(64) }, certificationOwnerPubkey: "b".repeat(64), requestedCap: "1", authorizationRequestSha256: request.authorizationRequestSha256, capacities: { modal: makeCapacity("modal"), fly: makeCapacity("fly") }, selectedProvider: provider === "modal" ? "fly" : "modal", journal: new PostgresOperationJournal(application as never, { namespace: "changed-cert-topology", scopeSha256: "f".repeat(64) }), pool: application as never }).capacityRouter();
      expect((await router.observe(retained)).status).toBe("available");
      const originalReady = await changed.observe(retained);
      expect(originalReady.status).toBe("available");
      if (originalReady.status === "available") expect(originalReady.ready.imageDigest).toBe(`sha256:${"a".repeat(64)}`);
      await expect(changed.reserveNow(retained)).rejects.toThrow("PRODUCTION_CAPACITY_ORIGINAL_PROFILE_REQUIRED");
      // Upgrade readers retain old rows byte-for-byte. Their provider original,
      // rather than the new default, supplies the image identity.
      await database.query("UPDATE production_real.release_operation_journal SET value_json=value_json-'execution',revision=revision+1 WHERE namespace='worker-lifecycle-recovery' AND operation_id=$1", [rows.rows[0]!.operation_id]);
      const legacyReady = await changed.observe(retained);
      expect(legacyReady.status).toBe("available");
      if (legacyReady.status === "available") expect(legacyReady.ready.imageDigest).toBe(`sha256:${"a".repeat(64)}`);
      await expect(changed.reserveNow(retained)).rejects.toThrow("PRODUCTION_CAPACITY_ORIGINAL_PROFILE_REQUIRED");
      const legacyBefore = await capacity.inspect(retained);
      expect((await capacity.reserveNow(retained)).status).toBe("available");
      expect(await capacity.inspect(retained)).toEqual(legacyBefore);
      wrongResource = true;
      expect((await capacity.observe(retained)).status).toBe("unknown");
      wrongResource = false;
      expect(creates).toBe(before.creates + 1);
      expect(await open().apply(plan)).toEqual(created);
      await expect(open().apply({ ...plan, desiredDigest: "b".repeat(64) })).rejects.toThrow("WORKER_LIFECYCLE_ORIGINAL_REQUIRED");
      await expect(open().cleanup({ operationId: plan.operationId, resourceIdentitySha256: "f".repeat(64) })).rejects.toThrow("WORKER_LIFECYCLE_RESOURCE_CHANGED");
      const originalCapacity = await capacity.inspect(retained);
      if (!originalCapacity) throw new Error("CAPACITY_ORIGINAL_MISSING");
      await providerJournal.update({ operationId: originalCapacity.workerOperationId, requestSha256: "c".repeat(64), state: "terminating" });
      expect((await capacity.observe(retained)).status).toBe("unknown");
      await expect(open().cleanup({ operationId: plan.operationId, resourceIdentitySha256: created.resourceIdentitySha256 })).rejects.toThrow("TERMINATION_ACK_LOST");
      now = 10000;
      const finalizer = createMountedReleaseCleanup({ effects: [{ provider, providerOperationId: plan.operationId, resourceIdentitySha256: created.resourceIdentitySha256! }], providers: { [provider]: { port: { async observe() { throw new Error("GENERIC_OBSERVATION_MUST_NOT_BE_USED"); } } } } as never, workers: { modal: open(), fly: open() } });
      expect(await finalizer.observe!({ operationId: "finalize-original", providerOperationId: plan.operationId, resourceIdentitySha256: created.resourceIdentitySha256! })).toBe("cleaned");
      expect(await open().cleanup({ operationId: plan.operationId, resourceIdentitySha256: created.resourceIdentitySha256 })).toEqual({ status: "cleaned" });
      expect(creates).toBe(before.creates + 1); expect(deletes).toBe(before.deletes + 1);
      await expect(open().apply({ ...plan, operationId: "new-after-expiry" })).rejects.toThrow("WORKER_LIFECYCLE_ORIGINAL_REQUIRED");
    }
    expect({ creates, deletes }).toEqual({ creates: 2, deletes: 2 });
    await proveModalMissingIdCleanup(() => createPostgresWorkerOperationJournal(journal()));
    await proveFlyMissingIdCleanup(() => createPostgresWorkerOperationJournal(journal()));
    for (const provider of ["modal", "fly"] as const) {
      await proveMissingIdReadiness(provider, { journal: () => createPostgresWorkerOperationJournal(workerJournal),
        capacity: { journal, workerJournal } });
    }
  } finally {
    await application?.end();
    await admin?.end();
    await docker(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
