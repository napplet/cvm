import { createRequire } from "node:module";
import { expect, test } from "bun:test";

import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import {
  persistMountedSourceBuildEvidence,
  releaseMountedSourceBuildCapacity,
  observeMountedSourceBuildCapacityCleanup,
  resumeMountedSourceBuildEvidence,
  type MountedSourceBuildResult,
} from "../../src/production/source-build-verifier";
import { bindMountedSourceBuildExecution, materializeMountedSourceBuildPlan } from "../../src/production/source-build-plan";

const postgresIsolation = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const digest = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${stderr.slice(0, 300)}`);
  return stdout.trim();
}

postgresIsolation("restricted PostgreSQL recovers one source evidence upload and cleanup original after lost acknowledgements", async () => {
  const name = `napplet-cvm-source-build-${crypto.randomUUID().replaceAll("-", "")}`;
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

    const plan = materializeMountedSourceBuildPlan({ candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64), provider: "modal" });
    const run = bindMountedSourceBuildExecution(plan, { authorizationRequestSha256: "c".repeat(64) });
    const result: MountedSourceBuildResult = {
      candidateId: plan.candidateSha256, sealedArtifactSha256: "d".repeat(64), manifestSha256: "e".repeat(64), capabilitiesSha256: "f".repeat(64), aggregateSha256: "1".repeat(64),
      jobId: "2".repeat(64), workerOperationId: run.workerOperationId, capacityReference: `capacity:${"3".repeat(64)}`,
    };
    const bytes = new TextEncoder().encode("source-build immutable evidence");
    const value = { key: `certification/source-build/${plan.candidateSha256}/${run.jobId}/evidence.json`, checksum: digest(bytes), result };
    let uploads = 0;
    const object = { key: value.key, generation: 1, checksum: value.checksum };
    let persisted = false;
    const store = {
      async createImmutable(request: Readonly<{ key: string; bytes: Uint8Array }>) {
        uploads += 1;
        expect(request).toEqual({ key: value.key, bytes });
        persisted = true;
        throw new Error("lost immutable upload acknowledgement");
      },
      async observeExactByKey(request: Readonly<{ key: string; checksum: string }>) {
        return persisted && request.key === value.key && request.checksum === value.checksum ? object : undefined;
      },
    };
    const journal = () => new PostgresOperationJournal(application as never, { namespace: "source-build-recovery", scopeSha256: "4".repeat(64) });
    await expect(persistMountedSourceBuildEvidence({ journal: journal(), artifactStore: store as never, run, value, bytes })).resolves.toEqual(object);
    const restored = await resumeMountedSourceBuildEvidence({ journal: journal(), artifactStore: store as never, candidateSha256: plan.candidateSha256, run });
    expect(restored).toMatchObject({ status: "passed", ...result });
    expect(uploads).toBe(1);

    let releases = 0, observations = 0;
    const capacity = {
      async release() { releases += 1; throw new Error("lost cleanup acknowledgement"); },
      async observeRelease() { observations += 1; return { status: "terminated" as const }; },
    };
    const record = { intentReference: run.capacityIntentReference, reference: result.capacityReference, workerOperationId: run.workerOperationId };
    await expect(releaseMountedSourceBuildCapacity({ journal: journal(), capacity, run, record })).rejects.toThrow("lost cleanup acknowledgement");
    await expect(observeMountedSourceBuildCapacityCleanup({ journal: journal(), capacity, run, record })).resolves.toBeUndefined();
    expect({ uploads, releases, observations }).toEqual({ uploads: 1, releases: 1, observations: 1 });
    expect((await database.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace='source-build-recovery'")).rows[0]).toEqual({ count: 2 });
  } finally {
    await application?.end();
    await admin?.end();
    await docker(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
