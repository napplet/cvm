import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import { accountIdForPrincipal } from "../../src/domain/account-command";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
integration("signed WSS admissions use real SQL original-operation claims without starting generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cvm-certification-transport-"));
  const name = `cvm-certification-${crypto.randomUUID().replaceAll("-", "")}`;
  const run = async (argv: string[], timeoutMs = 15000, env = process.env) => {
    const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${out.slice(-2000)} ${err.slice(-2000)}`);
      return out.trim();
    } finally { clearTimeout(timer); }
  };
  const { Pool } = createRequire(import.meta.url)("pg");
  let admin: any;
  try {
    await run(["docker", "run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await run(["docker", "port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("LOCAL_POSTGRES_PORT_REQUIRED");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 60; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 59) throw error; await Bun.sleep(250); } }
    for (const path of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${path}`).text());
    await admin.query("CREATE ROLE certification_test LOGIN"); await admin.query("GRANT napplet_production_real TO certification_test");
    // Local fixture-only seed; no production funding authority or rail invoked.
    const owner = getPublicKey(new Uint8Array(32).fill(0x11)); const accountId = await accountIdForPrincipal({ pubkey: owner });
    await admin.query("INSERT INTO production_real.funding_accounts(account_id,nostr_pubkey,unit) VALUES($1,$2,'sat')", [accountId, owner]);
    await admin.query("INSERT INTO production_real.account_balance_projection(account_id,unit,settled_available,held) VALUES($1,'sat',10,0)", [accountId]);
    const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
    await run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"]);
    const output = await run([process.execPath, "tests/release/helpers/contextvm-certification-fixture.ts", `postgresql://certification_test@127.0.0.1:${port}/postgres`, cert, key], 45000, { ...process.env, NODE_EXTRA_CA_CERTS: cert, NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" });
    const result = JSON.parse(output.split("\n").find(line => line.startsWith('{"passed":'))!);
    expect(result).toEqual({ passed: true, signedAdmissionCalls: 3, signedGenerationCalls: 0, lostResponseRedispatches: 0 });
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace='contextvm-client-test'")).rows[0].count).toBe(7);
  } finally { await admin?.end(); await run(["docker", "rm", "-f", name]).catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
}, 60000);
