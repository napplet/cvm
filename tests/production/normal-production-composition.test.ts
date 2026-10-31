import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { mountedBillingRecoveryFixture } from "../release/helpers/mounted-billing-recovery-fixture";
import { MountedProductionSecretMaterial } from "../../src/production/secret-material";
import { openProductionPostgresPool } from "../../src/production/postgres";

const postgres = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;

test("denied-effects postgres construction transport is rejected before mounted credential or network access", async () => {
  const fixtureRoot = resolve(import.meta.dir, "../../.runtime/release-certification/native-discovery-v1");
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(fixtureRoot, "postgres-construction-guard-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "states"), { recursive: true, mode: 0o700 });
  const prior = process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
  try {
    const fixture = await mountedBillingRecoveryFixture(workspace, Date.now());
    const secrets = new MountedProductionSecretMaterial(fixture.config, { root: join(workspace, "fixture-mount") });
    let opened = 0;
    delete process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
    await expect(openProductionPostgresPool(fixture.config, secrets, Object.freeze({
      async open() { opened++; throw new Error("POSTGRES_CONSTRUCTION_TRANSPORT_MUST_NOT_OPEN"); },
    }))).rejects.toThrow("PRODUCTION_POSTGRES_CONSTRUCTION_TRANSPORT_DENIED");
    expect(opened).toBe(0);
  } finally {
    if (prior === undefined) delete process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS;
    else process.env.NAPPLET_CVM_TEST_EXTERNAL_EFFECTS = prior;
    await rm(root, { recursive: true, force: true });
  }
});

postgres("normal mounted composition constructs the real sixteen-provider/eight-suite graph before an unapproved attempt dispatches nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cvm-normal-composition-cert-"));
  const name = `cvm-normal-composition-${crypto.randomUUID().replaceAll("-", "")}`;
  const run = async (argv: string[], timeoutMs = 60_000, env = process.env) => {
    const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stdout.slice(-3000)} ${stderr.slice(-3000)}`);
      return stdout.trim();
    } finally { clearTimeout(timer); }
  };
  const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new(input: Record<string, unknown>) => { query(sql: string): Promise<unknown>; end(): Promise<void> } };
  let admin: { query(sql: string): Promise<unknown>; end(): Promise<void> } | undefined;
  try {
    await run(["docker", "run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await run(["docker", "port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("NORMAL_COMPOSITION_POSTGRES_PORT_REQUIRED");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const path of [
      "phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql",
      "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql",
      "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql", "phase-07/003_production_checkpoints.sql", "phase-07/004_production_source_proposals.sql", "phase-07/005_production_session_caps.sql", "phase-07/006_production_pending_checkpoints.sql", "phase-07/007_production_generation_recovery.sql", "phase-07/008_production_account_owners.sql", "phase-07/009_production_resume_pricing_quotes.sql", "phase-07/010_production_priced_continuations.sql", "phase-07/011_production_priced_continuation_workers.sql", "phase-07/012_production_priced_continuation_restores.sql", "phase-07/013_production_priced_continuation_finalizations.sql", "phase-07/014_production_durability_subjects.sql", "phase-07/015_production_publication_signed_events.sql", "phase-07/016_production_authoritative_usage_reports.sql", "phase-07/017_production_resume_pricing_quote_v2.sql", "phase-07/018_production_priced_continuation_cleanup_proofs.sql",
    ]) await admin.query(await Bun.file(`migrations/${path}`).text());
    await admin.query("CREATE ROLE napplet_cvm_runtime LOGIN");
    await admin.query("GRANT napplet_production_real TO napplet_cvm_runtime");
    const output = await run([process.execPath, "tests/production/helpers/normal-production-composition-fixture.ts"], 120_000, { ...process.env, NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny", NAPPLET_NORMAL_COMPOSITION_DATABASE: `postgresql://napplet_cvm_runtime@127.0.0.1:${port}/postgres` });
    const result = JSON.parse(output.split("\n").find(line => line.startsWith('{"passed":'))!);
    expect(result).toEqual({ passed: true, stages: ["controller-request", "mounted-producer", "provenance-sealer", "contextvm-handshake", "sixteen-providers-eight-suites", "unapproved-zero-dispatch"], providers: 16, suites: 8, effects: { discoverCapabilities: 0, discoverAuthentication: 0, plan: 0, apply: 0, observe: 0, cleanup: 0, suites: 0 } });
  } finally { await admin?.end(); await run(["docker", "rm", "--force", name]).catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
}, 150_000);
