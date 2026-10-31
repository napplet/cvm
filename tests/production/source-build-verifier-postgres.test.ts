import { createRequire } from "node:module";
import { expect, test } from "bun:test";
import { assertMountedProductionSourceBuildVerifier } from "../../src/production/source-build-verifier";

test("mounted source-build verifier rejects structural callbacks and proxies", () => {
  const lookalike = Object.freeze({ authority: "production-real" as const, async verify() { return {}; } });
  expect(() => assertMountedProductionSourceBuildVerifier(lookalike)).toThrow("PRODUCTION_SOURCE_BUILD_VERIFIER_REQUIRED");
  expect(() => assertMountedProductionSourceBuildVerifier(new Proxy(lookalike, {}))).toThrow("PRODUCTION_SOURCE_BUILD_VERIFIER_REQUIRED");
});

import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import {
  persistMountedSourceBuildEvidence,
  releaseMountedSourceBuildCapacity,
  observeMountedSourceBuildCapacityCleanup,
  resumeMountedSourceBuildEvidence,
  readMountedSourceBuildEvidence,
  type MountedSourceBuildResult,
} from "../../src/production/source-build-verifier";
import { DeterministicObjectStore, type ObjectStorePort } from "../../src/continuity/object-store";
import { canonicalJson } from "../../src/promotion/schema";
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
    const payload = new TextEncoder().encode("<!doctype html><main>Fixture source</main>");
    const files = [{ path: "index.html", sha256: digest(payload), size: payload.byteLength, bytesBase64: Buffer.from(payload).toString("base64") }];
    const aggregate = digest(`${files[0]!.sha256} /index.html\n`);
    const manifest = { files: [{ path: "/index.html", sha256: files[0]!.sha256 }], aggregateHash: aggregate };
    const capabilities = '{"required":[],"optional":[]}';
    const result: MountedSourceBuildResult = {
      candidateId: plan.candidateSha256, sealedArtifactSha256: digest(JSON.stringify(files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.size })))), manifestSha256: digest(canonicalJson(manifest)), capabilitiesSha256: digest(capabilities), aggregateSha256: aggregate,
      jobId: "2".repeat(64), workerOperationId: run.workerOperationId, capacityReference: `capacity:${"3".repeat(64)}`,
    };
    const evidence = { version: 1 as const, artifact: { sealedObjectSha256: result.sealedArtifactSha256, aggregateSha256: aggregate, files }, receipts: { manifest, manifestSha256: result.manifestSha256, capabilities: { content: capabilities, capabilitiesSha256: result.capabilitiesSha256 }, workerArtifactSha256: "5".repeat(64), commandEvidenceSha256: "6".repeat(64) }, operation: { operationId: run.operationId, planJobId: plan.jobId, authorizationRequestSha256: run.authorizationRequestSha256, topologySha256: plan.topologySha256, ...result } };
    const bytes = new TextEncoder().encode(canonicalJson(evidence));
    const value = { key: `certification/source-build/${plan.candidateSha256}/${run.jobId}/evidence.json`, checksum: digest(bytes), result };
    let uploads = 0;
    const object = { key: value.key, generation: 1, checksum: value.checksum };
    let persisted = false;
    let returnedBytes = bytes;
    const store: ObjectStorePort = {
      async scheduleExactDeletion() { throw new Error("UNEXPECTED_DELETION"); },
      async readExact() { return returnedBytes; },
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
    await expect(persistMountedSourceBuildEvidence({ journal: journal(), artifactStore: store, run, value, bytes })).resolves.toEqual(object);
    const restored = await resumeMountedSourceBuildEvidence({ journal: journal(), artifactStore: store, candidateSha256: plan.candidateSha256, run });
    expect(restored).toMatchObject({ status: "passed", ...result });
    expect(uploads).toBe(1);
    expect(await readMountedSourceBuildEvidence({ journal: journal(), artifactStore: store, candidateSha256: plan.candidateSha256, run })).toEqual({ result, evidenceObject: object, evidence });
    returnedBytes = new TextEncoder().encode("corrupt immutable response");
    await expect(readMountedSourceBuildEvidence({ journal: journal(), artifactStore: store, candidateSha256: plan.candidateSha256, run })).rejects.toThrow("PRODUCTION_SOURCE_BUILD_EVIDENCE_BYTES_REQUIRED");
    returnedBytes = bytes;
    await expect(readMountedSourceBuildEvidence({ journal: journal(), artifactStore: store, candidateSha256: plan.candidateSha256, run: { ...run, topologySha256: "9".repeat(64) } })).rejects.toThrow("PRODUCTION_SOURCE_BUILD_EVIDENCE_BINDING_REQUIRED");
    expect(uploads).toBe(1);

    for (const [index, fault] of ["file-bytes", "manifest-digest", "aggregate", "traversal"].entries()) {
      const otherRun = bindMountedSourceBuildExecution(plan, { authorizationRequestSha256: digest(`read-fault:${index}`) });
      const otherResult = { ...result, workerOperationId: otherRun.workerOperationId };
      const changed = structuredClone(evidence);
      changed.operation = { ...changed.operation, operationId: otherRun.operationId, authorizationRequestSha256: otherRun.authorizationRequestSha256, ...otherResult };
      if (fault === "file-bytes") changed.artifact.files[0]!.bytesBase64 = Buffer.from("changed").toString("base64");
      if (fault === "manifest-digest") changed.receipts.manifestSha256 = "9".repeat(64);
      if (fault === "aggregate") changed.artifact.aggregateSha256 = "9".repeat(64);
      if (fault === "traversal") changed.artifact.files[0]!.path = "../index.html";
      const changedBytes = new TextEncoder().encode(canonicalJson(changed));
      const fixtureStore = new DeterministicObjectStore();
      await persistMountedSourceBuildEvidence({ journal: journal(), artifactStore: fixtureStore, run: otherRun, value: { key: `certification/source-build/${plan.candidateSha256}/${otherRun.jobId}/evidence.json`, checksum: digest(changedBytes), result: otherResult }, bytes: changedBytes });
      await expect(readMountedSourceBuildEvidence({ journal: journal(), artifactStore: fixtureStore, candidateSha256: plan.candidateSha256, run: otherRun })).rejects.toThrow();
    }

    let releases = 0, observations = 0;
    const capacity = {
      async release() { releases += 1; throw new Error("lost cleanup acknowledgement"); },
      async observeRelease() { observations += 1; return { status: "terminated" as const }; },
    };
    const record = { intentReference: run.capacityIntentReference, reference: result.capacityReference, workerOperationId: run.workerOperationId };
    await expect(releaseMountedSourceBuildCapacity({ journal: journal(), capacity, run, record })).rejects.toThrow("lost cleanup acknowledgement");
    await expect(observeMountedSourceBuildCapacityCleanup({ journal: journal(), capacity, run, record })).resolves.toBeUndefined();
    expect({ uploads, releases, observations }).toEqual({ uploads: 1, releases: 1, observations: 1 });
    expect((await database.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace='source-build-recovery'")).rows[0]).toEqual({ count: 6 });
  } finally {
    await application?.end();
    await admin?.end();
    await docker(["rm", "--force", name]).catch(() => undefined);
  }
}, 120_000);
