import { expect, test } from "bun:test";
import { Pool } from "pg";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { ProductionResumePricingQuotes } from "../../src/production/resume-pricing-quotes";
import { prepareResumePricingQuote } from "../../src/continuity/resume-pricing";
import { resumePricingContext, resumePricingMaterial } from "../fixtures/resume-pricing";
import { canonicalJson } from "../../src/promotion/schema";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
async function docker(args: string[]): Promise<string> {
  const process = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
function sqlPool(native: Pool, loseCommit?: () => boolean): PostgresSqlPool {
  return { async connect() { const client = await native.connect(); return {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await client.query<Row>(text, values ? [...values] : undefined);
      if (text === "COMMIT" && loseCommit?.()) throw new Error("COMMIT_ACK_LOST");
      return { rows: result.rows };
    }, release() { client.release(); },
  }; } };
}

integration("restricted SQL retains immutable owned resume quotes across concurrent writes and lost COMMIT responses", async () => {
  const name = `cvm-resume-quotes-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql"])
      await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE resume_quote_runtime LOGIN");
    await admin.query("GRANT napplet_production_real TO resume_quote_runtime");
    native = new Pool({ connectionString: `postgresql://resume_quote_runtime@127.0.0.1:${port}/postgres` });
    const store = new ProductionResumePricingQuotes(sqlPool(native));
    await expect(store.assertReady()).rejects.toThrow();
    const migration = await Bun.file("migrations/phase-07/009_production_resume_pricing_quotes.sql").text();
    await admin.query(migration); await admin.query(migration);
    await store.assertReady();
    await admin.query("GRANT UPDATE ON production_real.resume_pricing_quotes TO napplet_production_real");
    await expect(store.assertReady()).rejects.toThrow("PRODUCTION_RESUME_QUOTE_SCHEMA_REQUIRED");
    await admin.query("REVOKE UPDATE ON production_real.resume_pricing_quotes FROM napplet_production_real");
    await store.assertReady();
    await admin.query("ALTER TABLE production_real.resume_pricing_quotes DISABLE TRIGGER immutable_resume_pricing_quote");
    await expect(store.assertReady()).rejects.toThrow("PRODUCTION_RESUME_QUOTE_SCHEMA_REQUIRED");
    await admin.query("ALTER TABLE production_real.resume_pricing_quotes ENABLE TRIGGER immutable_resume_pricing_quote");
    await store.assertReady();

    const now = Date.now(), retention = now + 2_592_000_000;
    const context = { ...resumePricingContext(now), retentionUntilMs: retention };
    // Explicit metadata fixtures; no funds, reservation, provider or worker.
    await admin.query("INSERT INTO production_real.funding_accounts(account_id,unit) VALUES($1,'sat'),('account:foreign','sat')", [context.accountId]);
    await admin.query("INSERT INTO production_real.admissions(admission_id,account_id,reference,capacity_reference,state) VALUES('admission:one',$1,'admission:one','capacity:fixture','accepted')", [context.accountId]);
    await admin.query("INSERT INTO production_real.model_profile_versions VALUES('profile:fixture',$1,'fixture','fixture','{}')", ["1".repeat(64)]);
    await admin.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES('card:fixture',$1,'profile:fixture','sat','{}')", ["2".repeat(64)]);
    await admin.query("INSERT INTO production_real.metered_sessions(id,account_id,admission_reference,profile_id,price_card_id,version,state) VALUES($1,$2,'admission:one','profile:fixture','card:fixture',1,'needs_top_up')", [context.sessionId, context.accountId]);
    const intent = { accountId: context.accountId, sessionId: context.sessionId, idempotencyKey: "pending:one", fingerprint: context.pendingAction.fingerprint, reference: context.pendingAction.reference,
      actionKind: "revise_session", boundedPayloadHash: "f".repeat(64), expectedSessionVersion: 1, expectedArtifactVersion: 1, policyVersion: context.policyVersion,
      priceCardId: "card:fixture", profileId: "profile:fixture", toolchainId: context.toolchainId, actionMaximum: "1", admissionReference: "admission:one" };
    await admin.query(`INSERT INTO production_real.continuation_pauses(pause_id,account_id,session_id,admission_reference,idempotency_key,fingerprint_sha256,pending_fingerprint_sha256,pause_generation,expected_session_version,intent_json,grace_deadline_ms,state,result_json)
      VALUES('pause:one',$1,$2,'admission:one','pending:one',$3,$3,1,1,$4::jsonb,$5,'resume_required','{}')`, [context.accountId, context.sessionId, context.pendingAction.fingerprint, canonicalJson(intent), now]);
    await admin.query(`INSERT INTO production_real.continuation_checkpoints(checkpoint_id,account_id,session_id,pause_generation,expected_session_version,expected_artifact_version,manifest_reference,object_key,object_generation,object_checksum,key_reference,compatibility_identity,checkpoint_committed_at_ms,retention_deadline_ms,state)
      VALUES($1,$2,$3,1,1,1,'manifest:fixture','object:fixture','1',$4,'key:fixture','compatibility:fixture',$5,$6,'resume_required')`, [context.checkpointId, context.accountId, context.sessionId, "a".repeat(64), now, retention]);
    const pricing = await resumePricingMaterial(now);
    const first = await prepareResumePricingQuote({ context, pricing, preparationKey: "prepare:one", nowMs: now, lifetimeMs: 30_000 });
    const later = await prepareResumePricingQuote({ context, pricing, preparationKey: "prepare:one", nowMs: now + 1, lifetimeMs: 30_000 });
    const outcomes = await Promise.all([store.save(first), store.save(later), store.save(first)]);
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(await store.findReference("account:foreign", first.quoteReference)).toBeUndefined();
    expect(await store.findPreparation("account:foreign", first.preparationKey)).toBeUndefined();
    const original = outcomes[0]!;
    expect(await store.findReference(context.accountId, original.quoteReference)).toEqual(original);
    expect(await new ProductionResumePricingQuotes(sqlPool(native)).findPreparation(context.accountId, first.preparationKey)).toEqual(original);
    const changedContext = await prepareResumePricingQuote({ context: { ...context, originalCommandMaximum: "51" }, pricing, preparationKey: first.preparationKey, nowMs: now, lifetimeMs: 30_000 });
    await expect(store.save(changedContext)).rejects.toThrow("RESUME_QUOTE_PREPARATION_CONFLICT");
    let lose = true;
    const uncertain = new ProductionResumePricingQuotes(sqlPool(native, () => { const value = lose; lose = false; return value; }));
    const second = await prepareResumePricingQuote({ context, pricing, preparationKey: "prepare:two", nowMs: now, lifetimeMs: 30_000 });
    await expect(uncertain.save(second)).rejects.toThrow("COMMIT_ACK_LOST");
    expect(await store.save(second)).toEqual(second);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.resume_pricing_quotes")).rows[0].count).toBe(2);
    await expect(native.query("UPDATE production_real.resume_pricing_quotes SET quote_json='{}' WHERE quote_reference=$1", [first.quoteReference])).rejects.toThrow();
    await expect(native.query("DELETE FROM production_real.resume_pricing_quotes")).rejects.toThrow();
    await expect(native.query("TRUNCATE production_real.resume_pricing_quotes")).rejects.toThrow();
    await expect(admin.query("UPDATE production_real.resume_pricing_quotes SET quote_json='{}'")).rejects.toThrow("RESUME_PRICING_QUOTE_IMMUTABLE");
    const foreign = await prepareResumePricingQuote({ context: { ...context, accountId: "account:foreign" }, pricing, preparationKey: "prepare:foreign", nowMs: now, lifetimeMs: 30_000 });
    await expect(store.save(foreign)).rejects.toThrow("RESUME_PRICING_QUOTE_OWNER_BINDING_DENIED");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.action_budget_reservations")).rows[0].count).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.provider_operations")).rows[0].count).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.ledger_entries")).rows[0].count).toBe(0);
  } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
