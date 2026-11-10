import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import { deriveServiceIdentity, loadServiceConfig, ServiceSecrets } from "../src/service/config";
import { assertCanonicalSchema, assertServiceRealm } from "../src/service/migrations";
import { createServicePool } from "../src/service/server";
import { LocalArtifactRepository } from "../src/dev/local-artifact-repository";

/**
 * Verifies a restored instance against its backup manifest, using the same
 * mounted config and secrets as the service:
 *  - canonical schema and realm marker
 *  - service identity (pubkey derived from the restored seed)
 *  - per-table row counts equal the counts captured with the dump
 *  - every sealed artifact and every file re-reads with a verified digest
 *  - ledger entries reproduce every account's balance projection
 *
 *   bun scripts/verify-restore.ts --counts /backup/counts.tsv --manifest /backup/manifest.json
 */
const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const config = await loadServiceConfig();
const secrets = new ServiceSecrets();
const pool = createServicePool(await secrets.text("database_url"), config);
const failures: string[] = [];
const report: Record<string, unknown> = {};
try {
  await assertCanonicalSchema(pool);
  await assertServiceRealm(pool, config.realm);
  const identity = deriveServiceIdentity(await secrets.text("service_seed"));
  const servicePubkey = getPublicKey(Uint8Array.from(Buffer.from(identity.signerPrivateKey, "hex")));
  const manifest = JSON.parse(await readFile(arg("manifest") ?? "", "utf8")) as { servicePubkey: string; realm: string; revision: string };
  if (manifest.servicePubkey !== servicePubkey) failures.push("SERVICE_IDENTITY_CHANGED");
  if (manifest.realm !== config.realm) failures.push("REALM_CHANGED");
  report.identity = { servicePubkey, realm: config.realm, backupRevision: manifest.revision };

  const expected = new Map((await readFile(arg("counts") ?? "", "utf8")).trim().split("\n").filter(Boolean).map((line) => { const [table, count] = line.split("|"); return [table!, count!]; }));
  const actual = new Map((await pool.query<{ table_name: string; count: string }>(`
    SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text AS count
    FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).rows.map((row) => [row.table_name, row.count]));
  for (const [table, count] of expected) if (actual.get(table) !== count) failures.push(`ROW_COUNT_MISMATCH:${table}:${count}->${actual.get(table) ?? "missing"}`);
  report.tables = expected.size;
  report.rows = [...expected.values()].reduce((sum, value) => sum + Number(value), 0);

  const repository = new LocalArtifactRepository({ objectRoot: resolve(config.storage.root, "artifacts"), pool });
  const artifacts = (await pool.query<{ artifact_id: string }>("SELECT artifact_id FROM development_artifacts ORDER BY artifact_id")).rows;
  let files = 0;
  for (const { artifact_id } of artifacts) {
    try {
      const artifact = await repository.get(artifact_id);
      if (!artifact) { failures.push(`ARTIFACT_MISSING:${artifact_id}`); continue; }
      for (const file of artifact.files) { const read = await repository.read({ artifactId: artifact_id, path: file.path }); if (!read) failures.push(`ARTIFACT_FILE_MISSING:${artifact_id}:${file.path}`); else files++; }
    } catch (error) { failures.push(`ARTIFACT_INVALID:${artifact_id}:${error instanceof Error ? error.message.slice(0, 80) : "unknown"}`); }
  }
  report.artifacts = { sealed: artifacts.length, filesVerified: files };

  // `settled_available` is the account's settled total (held funds included):
  // it must equal credits minus debits, and holds can never exceed it.
  const ledger = (await pool.query<{ account_id: string; ledger: string; settled: string; held: string }>(`
    SELECT p.account_id, coalesce(sum(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END), 0)::text AS ledger, p.settled_available::text AS settled, p.held::text AS held
    FROM account_balance_projection p LEFT JOIN ledger_entries e ON e.account_id = p.account_id GROUP BY p.account_id, p.settled_available, p.held`)).rows;
  const unbalanced = ledger.filter((row) => row.ledger !== row.settled || BigInt(row.held) > BigInt(row.settled));
  report.ledger = { accounts: ledger.length, settledSat: ledger.reduce((sum, row) => sum + BigInt(row.settled), 0n).toString(), heldSat: ledger.reduce((sum, row) => sum + BigInt(row.held), 0n).toString(), unbalanced: unbalanced.length };
  for (const row of unbalanced) failures.push(`LEDGER_PROJECTION_MISMATCH:${row.account_id}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : "VERIFY_RESTORE_FAILED");
} finally { await pool.end(); }
report.failures = failures;
report.status = failures.length ? "failed" : "passed";
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
