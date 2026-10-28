import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import { assertProductionSessionCapSchema } from "../../src/production/session-cap-schema";
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { FundingService } from "../../src/funding/funding-service";
import { SessionCapApprovalService } from "../../src/funding/session-cap";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import type { MeteredFundingTransaction } from "../../src/persistence/funding-store";
import { ModelProfileSchema, PriceCardSchema, PHASE_04_DETERMINISTIC_PRICE_CARD, maximumOperationCharge } from "../../src/model/price-card";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
async function docker(args: string[], input?: string) {
  const child = Bun.spawn(["docker", ...args], { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
function sqlPool(native: Pool): PostgresSqlPool {
  return { async connect() { const client = await native.connect(); return {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) { return { rows: (await client.query<Row>(sql, values ? [...values] : undefined)).rows }; },
    release() { client.release(); },
  }; } };
}

integration("cap consent preserves partial funding history and atomically reserves only the funded increase", async () => {
  const name = `cvm-session-cap-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined, restored: Pool | undefined, restoredAdmin: Pool | undefined;
  let directory: string | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    const card = PriceCardSchema.parse({ ...PHASE_04_DETERMINISTIC_PRICE_CARD, id: "cap-card", version: "cap-card" });
    const profile = ModelProfileSchema.parse({ id: "cap-profile", provider: "deterministic_fixture", model: "phase-04-fixture-model", priceCardId: card.id, selection: "unselected", deadlineMs: 30000, maximumUnits: [{ dimension: "input_tokens", units: "2" }, { dimension: "output_tokens", units: "1" }, { dimension: "cached_tokens", units: "2" }, { dimension: "reasoning_tokens", units: "3" }] });
    expect(maximumOperationCharge({ card, profile })).toBe("10");
    await admin.query("INSERT INTO production_real.model_profile_versions(id,profile_hash,provider,model,normalized_profile) VALUES($1,$2,$3,$4,$5::jsonb)", [profile.id, "c".repeat(64), profile.provider, profile.model, JSON.stringify(profile)]);
    await admin.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES($1,$2,$3,'sat',$4::jsonb)", [card.id, "d".repeat(64), profile.id, JSON.stringify(card)]);
    await admin.query("CREATE ROLE session_cap_test LOGIN"); await admin.query("GRANT napplet_production_real TO session_cap_test");
    native = new Pool({ connectionString: `postgresql://session_cap_test@127.0.0.1:${port}/postgres` });
    const pool = sqlPool(native), database = new PostgresFundingDatabase(pool, { realm: "production-real" }), store = database.funding;
    const funding = new FundingService(store), caps = new SessionCapApprovalService(store), principal = { pubkey: getPublicKey(new Uint8Array(32).fill(0x11)) };
    // Explicit protocol credits and pricing, not real rail/model/provider proof.
    const credit = (key: string, amount: string) => funding.execute({ principal, kind: "credit_settlement", idempotencyKey: key, policyVersion: "fixture", protocolVersion: "fixture", payload: { settlement: { topUpId: key, rail: "lightning", unit: "sat", amount, externalReference: `external:${key}`, settlementReference: `settlement:${key}`, verifiedAt: new Date().toISOString() } } });
    const accountId = (await credit("initial", "8")).accountId;
    const admission = await funding.execute({ principal, kind: "funded_admission", idempotencyKey: "admit", policyVersion: "fixture", protocolVersion: "fixture", payload: { requestedCap: "10", unit: "sat", capacity: { usable: true, reference: "admission:cap" } } });
    if (admission.status !== "accepted") throw new Error("FIXTURE_ADMISSION_REQUIRED");
    expect(admission).toMatchObject({ approvedCap: "8", heldAmount: "8" });
    const sessionId = "session:cap", admissionReference = admission.reference;
    const pause = await new ContinuationService({ store, includeAdmissionHold: true }).pauseForFunding({ intent: { accountId, sessionId, idempotencyKey: "pause", fingerprint: "a".repeat(64), reference: "pending:cap", actionKind: "start_session", boundedPayloadHash: "b".repeat(64), expectedSessionVersion: 0, expectedArtifactVersion: 0, policyVersion: "fixture", priceCardId: card.id, profileId: profile.id, toolchainId: "cap-toolchain", actionMaximum: "10", admissionReference } });
    expect(pause).toMatchObject({ requiredAdditionalFunding: "2", requiredCapApproval: "2" });
    const originalCommands = (await admin.query("SELECT * FROM production_real.funding_commands ORDER BY idempotency_key")).rows;
    await expect(assertProductionSessionCapSchema(pool)).rejects.toThrow("PRODUCTION_SESSION_CAP_SCHEMA_REQUIRED");
    const migration = await Bun.file("migrations/phase-07/005_production_session_caps.sql").text();
    await admin.query(migration); await admin.query(migration);
    await assertProductionSessionCapSchema(pool);
    await admin.query("ALTER TABLE production_real.session_cap_holds DISABLE TRIGGER session_cap_approval");
    await expect(assertProductionSessionCapSchema(pool)).rejects.toThrow("PRODUCTION_SESSION_CAP_SCHEMA_REQUIRED");
    await admin.query("ALTER TABLE production_real.session_cap_holds ENABLE TRIGGER session_cap_approval");
    expect((await admin.query("SELECT * FROM production_real.funding_commands ORDER BY idempotency_key")).rows).toEqual(originalCommands);
    expect((await admin.query("SELECT requested_cap,approved_cap,held_amount FROM production_real.session_cap_holds WHERE reference=$1", [admissionReference])).rows[0]).toEqual({ requested_cap: "10", approved_cap: "8", held_amount: "8" });
    const command = { principal, sessionId, admissionReference, idempotencyKey: "approve:one", expectedApprovedCap: "8", maximum: "10", unit: "sat", policyVersion: "fixture", protocolVersion: "fixture" };
    const consent = { consentReference: `nostr:${"e".repeat(64)}` };
    await expect(caps.approve(command, consent)).rejects.toThrow("SESSION_CAP_INSUFFICIENT_BALANCE");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.session_cap_approvals")).rows[0].count).toBe(0);
    await credit("increase", "2");
    const first = await caps.approve(command, consent);
    expect(first).toMatchObject({ status: "approved", previousApprovedCap: "8", approvedCap: "10", heldAmount: "10" });
    expect(await new SessionCapApprovalService(store).approve(command, { consentReference: `nostr:${"f".repeat(64)}` })).toEqual(first);
    expect(await funding.status(principal)).toMatchObject({ available: "0", held: "10", admissions: [{ reference: admissionReference, approvedCap: "10", heldAmount: "10" }] });
    await expect(caps.approve({ ...command, maximum: "11" }, consent)).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    await expect(caps.approve({ ...command, principal: { pubkey: "9".repeat(64) } }, consent)).rejects.toThrow("SESSION_CAP_NOT_FOUND_OR_DENIED");
    expect((await admin.query("SELECT consent_reference FROM production_real.session_cap_approvals")).rows[0].consent_reference).toBe(consent.consentReference);
    await credit("other-hold", "10");
    await funding.execute({ principal, kind: "funded_admission", idempotencyKey: "admit:other", policyVersion: "fixture", protocolVersion: "fixture", payload: { requestedCap: "6", unit: "sat", capacity: { usable: true, reference: "admission:other" } } });
    await expect(caps.approve({ ...command, idempotencyKey: "cannot-use-other", expectedApprovedCap: "10", maximum: "15" }, consent)).rejects.toThrow("SESSION_CAP_INSUFFICIENT_BALANCE");
    const raced = await Promise.allSettled([caps.approve({ ...command, idempotencyKey: "race:a", expectedApprovedCap: "10", maximum: "12" }, consent), caps.approve({ ...command, idempotencyKey: "race:b", expectedApprovedCap: "10", maximum: "13" }, consent)]);
    expect(raced.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter(value => value.status === "rejected")).toHaveLength(1);
    const winner = raced.find(value => value.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("FIXTURE_WINNER_REQUIRED");
    expect((await admin.query("SELECT held_amount FROM production_real.session_cap_holds WHERE reference='admission:other'")).rows[0].held_amount).toBe("6");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.session_cap_approvals")).rows[0].count).toBe(2);
    // Lose the local acknowledgement after the final outbox INSERT. Every
    // approval, hold and billing row must roll back, then one retry may commit.
    const next = { ...command, idempotencyKey: "rollback", expectedApprovedCap: winner.value.approvedCap, maximum: String(BigInt(winner.value.approvedCap) + 1n) };
    const before = (await admin.query("SELECT settled_available,held FROM production_real.account_balance_projection WHERE account_id=$1", [accountId])).rows;
    const failedPool: PostgresSqlPool = { async connect() { const client = await pool.connect(); return {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) { const result = await client.query<Row>(sql, values); if (sql.startsWith("INSERT INTO funding_outbox") && values?.[2] === "session_cap_approved") throw new Error("CAP_OUTBOX_INTERRUPTED"); return result; }, release() { client.release(); },
    }; } };
    await expect(new SessionCapApprovalService(new PostgresFundingDatabase(failedPool, { realm: "production-real" }).funding).approve(next, consent)).rejects.toThrow("CAP_OUTBOX_INTERRUPTED");
    expect((await admin.query("SELECT settled_available,held FROM production_real.account_balance_projection WHERE account_id=$1", [accountId])).rows).toEqual(before);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.session_cap_approvals")).rows[0].count).toBe(2);
    expect(await caps.approve(next, consent)).toMatchObject({ status: "approved", approvedCap: next.maximum });
    await expect(native.query("UPDATE production_real.session_cap_holds SET approved_cap=approved_cap+1 WHERE reference=$1", [admissionReference])).rejects.toThrow("SESSION_CAP_APPROVAL_REQUIRED");
    await expect(admin.query("DELETE FROM production_real.session_cap_approvals")).rejects.toThrow("SESSION_CAP_APPROVAL_IMMUTABLE");
    expect((await admin.query("SELECT result_json FROM production_real.funding_commands WHERE idempotency_key='admit'")).rows[0].result_json).toEqual(admission);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.funding_outbox WHERE event_kind='session_cap_approved'")).rows[0].count).toBe(3);
    // A fully spent admission keeps its original approved total. Zero held
    // funds are a valid status, and explicit approval can fund its next action.
    await credit("zero-fixture", "20");
    const zeroAdmission = await funding.execute({ principal, kind: "funded_admission", idempotencyKey: "admit:zero", policyVersion: "fixture", protocolVersion: "fixture", payload: { requestedCap: "20", unit: "sat", capacity: { usable: true, reference: "admission:zero" } } });
    if (zeroAdmission.status !== "accepted") throw new Error("FIXTURE_ZERO_ADMISSION_REQUIRED");
    for (const number of [1, 2]) await store.transact(accountId, async (tx: MeteredFundingTransaction) => {
      const actionKey = `spend:zero:${number}`, operationId = `operation:zero:${number}`, fingerprint = String(number).repeat(64);
      const budget = await tx.reserveActionBudget({ accountId, admissionReference: zeroAdmission.reference, idempotencyKey: actionKey, fingerprint, reference: `budget:zero:${number}`, amount: 10n });
      await tx.prepareMeteredAction({ accountId, sessionId: "session:zero", actionId: `action:zero:${number}`, idempotencyKey: actionKey, fingerprint, expectedVersion: 0, admissionReference: zeroAdmission.reference, actionBudgetReference: budget.reference, maximum: 10n, operationId, profileId: profile.id, priceCardId: card.id });
      await tx.claimProviderOperation(operationId);
      await tx.finalizeMeteredAction({ idempotencyKey: actionKey, operationId, receiptCharge: "10", providerReceiptReference: `fixture:maximum-usage:${number}`, status: "failed", result: { status: "failed", confirmedSpend: "10", remainingCap: "0", remainingBalance: "0" }, sessionVersion: 0, artifactVersion: 0 });
    });
    expect((await funding.status(principal)).admissions.find(value => value.reference === zeroAdmission.reference)).toEqual({ reference: zeroAdmission.reference, approvedCap: "20", heldAmount: "0", unit: "sat" });
    expect(await caps.approve({ ...command, sessionId: "session:zero", admissionReference: zeroAdmission.reference, idempotencyKey: "approve:zero", expectedApprovedCap: "20", maximum: "21" }, consent)).toMatchObject({ approvedCap: "21", heldAmount: "1" });
    await credit("wire-fixture", "2");
    directory = await mkdtemp(join(tmpdir(), "cvm-cap-wire-"));
    const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
    const run = async (argv: string[], env = process.env) => {
      const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 45000);
      try {
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (code) throw new Error(`CAP_WIRE_FAILED:${out.slice(-2000)}:${err.slice(-2000)}`);
        return out;
      } finally { clearTimeout(timer); }
    };
    await run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"]);
    const wire = await run([process.execPath, "tests/production/helpers/session-cap-wire-fixture.ts", `postgresql://session_cap_test@127.0.0.1:${port}/postgres`, cert, key, sessionId, admissionReference, next.maximum], { ...process.env, NODE_EXTRA_CA_CERTS: cert, NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" });
    const line = wire.split("\n").find(value => value.startsWith('{"passed":'));
    expect(line ? JSON.parse(line) : undefined).toEqual({ passed: true, signedCapCalls: 2, deniedCalls: 4 });
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.session_cap_approvals WHERE idempotency_key='cap:wss'")).rows[0].count).toBe(1);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.session_cap_approvals WHERE idempotency_key='cap:foreign'")).rows[0].count).toBe(0);
    // Restore into a new database, retaining the original authority and audit.
    // This proves SQL archive recovery locally, not a live managed backup drill.
    const snapshot = await admin.query("SELECT approval_reference,result_json,consent_reference FROM production_real.session_cap_approvals ORDER BY approval_reference");
    const dump = await docker(["exec", name, "pg_dump", "-U", "postgres", "--schema=production_real", "--no-owner", "postgres"]);
    await admin.query("CREATE DATABASE recovered_caps");
    await docker(["exec", "-i", name, "psql", "-U", "postgres", "--set", "ON_ERROR_STOP=1", "--dbname", "recovered_caps"], `${dump}\n`);
    restoredAdmin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/recovered_caps` });
    await restoredAdmin.query(migration);
    restored = new Pool({ connectionString: `postgresql://session_cap_test@127.0.0.1:${port}/recovered_caps` });
    const restoredPool = sqlPool(restored);
    await assertProductionSessionCapSchema(restoredPool);
    const recovered = new SessionCapApprovalService(new PostgresFundingDatabase(restoredPool, { realm: "production-real" }).funding);
    expect(await recovered.approve(command, consent)).toEqual(first);
    expect((await restored.query("SELECT approval_reference,result_json,consent_reference FROM production_real.session_cap_approvals ORDER BY approval_reference")).rows).toEqual(snapshot.rows);
    expect((await restored.query("SELECT result_json FROM production_real.funding_commands WHERE idempotency_key='admit'")).rows[0].result_json).toEqual(admission);
    expect(await recovered.approve({ ...command, idempotencyKey: "recovered:increase", expectedApprovedCap: String(BigInt(next.maximum) + 1n), maximum: String(BigInt(next.maximum) + 2n) }, consent)).toMatchObject({ approvedCap: String(BigInt(next.maximum) + 2n) });
  } finally { await restored?.end(); await restoredAdmin?.end(); await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); if (directory) await rm(directory, { recursive: true, force: true }); }
}, 120_000);
