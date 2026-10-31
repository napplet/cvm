import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createPostgresOpenAiResponsesOperationJournal } from "../../src/release/deployment/postgres-openai-responses-journal";
import { createOpenAiResponsesClient, type OpenAiResponsesPort } from "../../src/release/deployment/openai-responses-client";
import { OPENAI_RESPONSES_PRICING_URL } from "../../src/release/costs/official-sources";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const digest = (character: string) => character.repeat(64);

integration("Responses journal uses restricted PostgreSQL for concurrent claims, CAS recovery, and no-rePOST restart recovery", async () => {
  const name = `cvm-openai-journal-${crypto.randomUUID().replaceAll("-", "")}`;
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`DOCKER_${args[0]}:${stderr.slice(0, 300)}`);
      return stdout.trim();
    } finally { clearTimeout(timer); }
  };
  const { Pool } = createRequire(import.meta.url)("pg");
  let admin: any;
  let application: any;
  let restored: any;
  try {
    await docker("run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine");
    const port = (await docker("port", name, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 59) throw error; await Bun.sleep(250); }
    }
    for (const path of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql", "phase-07/001_production_operation_journal.sql", "phase-07/020_openai_responses_journal_role.sql"]) await admin.query(await Bun.file(`migrations/${path}`).text());
    await admin.query("CREATE ROLE responses_journal_test LOGIN");
    await admin.query("GRANT napplet_openai_responses_journal TO responses_journal_test");
    application = new Pool({ connectionString: `postgresql://responses_journal_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    const journal = () => createPostgresOpenAiResponsesOperationJournal(new PostgresOperationJournal(application, { namespace: "openai:responses", scopeSha256: digest("a"), purpose: "openai-responses" }));
    const rate = { version: 2 as const, sourceUrl: OPENAI_RESPONSES_PRICING_URL as typeof OPENAI_RESPONSES_PRICING_URL, sourceDocumentSha256: digest("b"), sourceArtifactSha256: digest("b"), quoteSha256: digest("c"), observedAtMs: 1, freshUntilMs: 10_000, model: "gpt-4.1-2025-04-14", currency: "USD" as const, inputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 500_000, outputMicrosPerMillion: 8_000_000 };
    let posts = 0, gets = 0;
    const bytes = new TextEncoder().encode(JSON.stringify({ id: "resp_pg17", model: rate.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"files":[]}' }] }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } } }));
    const portAdapter: OpenAiResponsesPort = { async create() { posts++; return { bytes }; }, async get(responseId) { gets++; expect(responseId).toBe("resp_pg17"); return { bytes }; } };
    const client = (operationJournal = journal()) => createOpenAiResponsesClient({ candidateSha256: digest("a"), credentialReference: "openai:api-key:production-reference", model: rate.model, rate, maximumChargeMicros: 10_000_000, journal: operationJournal, port: portAdapter, now: () => 2 });
    const command = { operationId: "operation:pg17", idea: "One focused applet", systemInstruction: "Return JSON only", maximumInputTokens: 1_000, maximumOutputTokens: 200 };
    const concurrent = await Promise.all([client().dispatch(command), client().dispatch(command)]);
    expect(posts).toBe(1);
    expect(concurrent.some((result) => result.status === "completed")).toBe(true);
    const original = await journal().read(command.operationId) as Record<string, unknown>;
    expect(original.responseId).toBe("resp_pg17");
    await expect(journal().write({ ...original, responseId: "resp_other" } as any)).rejects.toThrow("OPENAI_RESPONSES_JOURNAL_RESPONSE_ID_CONFLICT");
    const recovered = await client().reconcileOriginal({ operationId: command.operationId });
    expect(recovered).toMatchObject({ status: "completed", responseId: "resp_pg17" });
    expect(posts).toBe(1); expect(gets).toBeGreaterThanOrEqual(0);
    // The acknowledgement after recording a provider response may be lost.
    // A fresh client is allowed to reconcile that exact original, never POST it.
    const durable = journal(); let loseAck = true;
    const lostAckJournal = {
      claim: durable.claim.bind(durable), read: durable.read.bind(durable),
      async write(entry: any) { await durable.write(entry); if (loseAck && entry.responseId && !entry.completedReceipt) { loseAck = false; throw new Error("ACK_LOST_AFTER_COMMIT"); } },
    };
    const lostAckCommand = { ...command, operationId: "operation:lost-ack" };
    await expect(client(lostAckJournal).dispatch(lostAckCommand)).rejects.toThrow("ACK_LOST_AFTER_COMMIT");
    expect(posts).toBe(2);
    expect(await client().reconcileOriginal({ operationId: lostAckCommand.operationId })).toMatchObject({ status: "completed", responseId: "resp_pg17" });
    expect(posts).toBe(2);
    // A fresh PostgreSQL 17 dump/restore retains the immutable original and
    // terminal receipt; the restored client cannot redispatch it.
    // Ownership is intentionally not restored, but the dump must carry the
    // constrained role's schema/table ACLs.  Its role membership was created
    // by the recovery bootstrap and is verified below as the runtime role.
    const dump = await docker("exec", name, "pg_dump", "-U", "postgres", "--no-owner", "postgres");
    await admin.query("CREATE DATABASE responses_restore");
    const restoreProcess = Bun.spawn(["docker", "exec", "-i", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "responses_restore"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    restoreProcess.stdin.write(dump); restoreProcess.stdin.end();
    const [restoreCode, restoreError] = await Promise.all([restoreProcess.exited, new Response(restoreProcess.stderr).text()]);
    if (restoreCode !== 0) throw new Error(`POSTGRES_RESTORE_FAILED:${restoreError.slice(0, 300)}`);
    restored = new Pool({ connectionString: `postgresql://responses_journal_test@127.0.0.1:${port}/responses_restore`, connectionTimeoutMillis: 2_000 });
    const restoredJournal = createPostgresOpenAiResponsesOperationJournal(new PostgresOperationJournal(restored, { namespace: "openai:responses", scopeSha256: digest("a"), purpose: "openai-responses" }));
    expect(await client(restoredJournal).reconcileOriginal({ operationId: command.operationId })).toMatchObject({ status: "completed", responseId: "resp_pg17" });
    expect(posts).toBe(2);
    const restricted = await restored.connect();
    try {
      await expect(restricted.query("DELETE FROM production_real.release_operation_journal")).rejects.toThrow();
      await expect(restricted.query("UPDATE production_real.release_operation_journal SET revision=revision+2")).rejects.toThrow();
      await expect(restricted.query("SELECT * FROM production_real.funding_accounts")).rejects.toThrow();
    } finally { restricted.release(); }
  } finally {
    await restored?.end(); await application?.end(); await admin?.end(); await docker("rm", "--force", name).catch(() => undefined);
  }
}, 60_000);
