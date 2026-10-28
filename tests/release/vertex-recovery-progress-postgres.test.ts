import { expect, test } from "bun:test";
import { z } from "zod";
import { Pool } from "pg";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createPostgresVertexOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort } from "../../src/release/deployment/vertex-client";
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
type Faults = { progressCommit?: "before" | "after" };
function restrictedPool(native: Pool, faults: Faults = {}): PostgresSqlPool {
  return { async connect() {
    const client = await native.connect(); let progress = false;
    return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      if (sql.startsWith("UPDATE production_real.release_operation_journal") && typeof values?.[2] === "string" && values[2].startsWith("vertex-recovery:")) progress = true;
      const fault = sql === "COMMIT" && progress ? faults.progressCommit : undefined;
      if (fault) delete faults.progressCommit;
      if (fault === "before") throw new Error("FIXTURE_CRASH_BEFORE_PROGRESS_COMMIT");
      const result = await client.query<Row>(sql, values ? [...values] : undefined);
      if (fault === "after") throw new Error("FIXTURE_LOST_PROGRESS_COMMIT_ACK");
      return { rows: result.rows };
    }, release() { client.release(); } };
  } };
}

integration("actual SQL recovery advances beyond32 across fresh controllers without changing the original or repeating POST", async () => {
  const name = `cvm-vertex-progress-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); } }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE vertex_progress_test LOGIN"); await admin.query("GRANT napplet_production_real TO vertex_progress_test");
    native = new Pool({ connectionString: `postgresql://vertex_progress_test@127.0.0.1:${port}/postgres` });
    const faults: Faults = {};
    const pool = restrictedPool(native, faults), price = { sourceUrl: "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", sourceDocumentSha256: "a".repeat(64), quoteSha256: "b".repeat(64), observedAtMs: 1000, freshUntilMs: 2000, effectiveFromMs: 900, effectiveUntilMs: 3000, currency: "USD", inputMicrosPerMillion: 4000000, cachedInputMicrosPerMillion: 200000, outputAndThoughtMicrosPerMillion: 20000000 };
    const Texts = z.array(z.object({ type: z.literal("text"), text: z.string() }));
    type Page = { ids: string[]; next?: string; invalid?: boolean; expired?: boolean };
    let pages = new Map<string, Page>([["", { ids: Array.from({ length: 65 }, (_, i) => `i${i}`) }]]), matches = new Set(["i40"]), malformed = new Set<string>();
    let input: z.infer<typeof Texts> = [], posts = 0, lists = 0, gets = 0, missingUsage = false, clock = 0, jumpClock = false;
    let readLog: string[] = [];
    let barrier: { hits: number; promise: Promise<void>; release(): void } | undefined;
    const interactions = createVertexInteractionsHttpPort({ accessToken: async () => "a".repeat(32), fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") { posts++; input = Texts.parse(JSON.parse(String(init.body)).input); throw new Error("FIXTURE_LOST_ACK"); }
      if (String(url).includes("page_size=")) {
        lists++; const token = new URL(String(url)).searchParams.get("page_token") ?? "", page = pages.get(token);
        if (!page) throw new Error("FIXTURE_PAGE_NOT_DEFINED");
        if (page.expired) return Response.json({ error: "expired token" }, { status: 400 });
        if (page.invalid) return Response.json({ interaction_metadatas: "malformed" });
        return Response.json({ interaction_metadatas: page.ids.map(id => ({ id })), ...(page.next ? { next_page_token: page.next } : {}) });
      }
      gets++; const id = String(url).split("/").at(-1)!; readLog.push(id);
      if (jumpClock) { clock += 26_000; jumpClock = false; }
      if (barrier && id === "i0") { barrier.hits++; if (barrier.hits === 2) barrier.release(); await barrier.promise; }
      return Response.json({ id: malformed.has(id) ? "wrong-resource" : id, model: "gemini-4-argon", status: "completed", created: new Date(1500).toISOString(), steps: [{ type: "user_input", content: matches.has(id) ? input : [{ type: "text", text: "unrelated original" }] }, { type: "model_output", content: [{ type: "text", text: '{"files":[]}' }] }], usage: { total_input_tokens: 1000, total_cached_tokens: missingUsage ? undefined : 200, total_output_tokens: 100, total_thought_tokens: 10, total_tool_use_tokens: 0, total_tokens: 1110 } });
    }, { preconnect() {} }) });
    const journal = () => new PostgresOperationJournal(pool, { namespace: "vertex-progress", scopeSha256: "a".repeat(64) });
    const open = () => createVertexDeploymentClient({ candidateSha256: "c".repeat(64), projectId: "napplet-cvm-test", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:test", price, journal: createPostgresVertexOperationJournal(journal()), interactions, now: () => 1500, recoveryClock: () => clock });
    const command = { operationId: "operation:progress", idea: "One synthetic counter", systemInstruction: "JSON only", maximumInputTokens: 2000, maximumOutputTokens: 200 };
    expect(await open().dispatch(command)).toMatchObject({ status: "unknown" });
    const original = await journal().read(command.operationId);
    const perCall: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) { const before = gets; expect(await open().reconcileOriginal({ operationId: command.operationId })).toMatchObject({ status: "unknown" }); perCall.push(gets - before); }
    expect(await journal().read(command.operationId)).toEqual(original);
    const before = gets;
    const receipt = await open().reconcileOriginal({ operationId: command.operationId });
    perCall.push(gets - before);
    expect(receipt).toMatchObject({ status: "completed", interactionId: "i40", cost: { micros: 5440 } });
    expect(perCall.every(count => count <= 32)).toBe(true);
    expect(perCall).toEqual([32, 32, 2]);
    expect({ posts, lists, gets }).toEqual({ posts: 1, lists: 1, gets: 66 });
    expect(await open().reconcileOriginal({ operationId: command.operationId })).toEqual(receipt);
    expect({ posts, lists, gets }).toEqual({ posts: 1, lists: 1, gets: 66 });

    const reset = () => { pages = new Map([["", { ids: Array.from({ length: 65 }, (_, i) => `i${i}`) }]]); matches = new Set(["i40"]); malformed.clear(); input = []; posts = 0; lists = 0; gets = 0; readLog = []; missingUsage = false; clock = 0; jumpClock = false; barrier = undefined; };
    const commandFor = (id: string) => ({ ...command, operationId: `operation:${id}` });
    const begin = async (id: string) => { const cmd = commandFor(id); expect(await open().dispatch(cmd)).toMatchObject({ status: "unknown" }); return cmd; };
    const finish = async (cmd: ReturnType<typeof commandFor>) => {
      for (let i = 0; i < 12; i++) { const priorReads = gets, priorLists = lists; const result = await open().reconcileOriginal({ operationId: cmd.operationId }); expect(gets - priorReads).toBeLessThanOrEqual(32); expect(lists - priorLists).toBeLessThanOrEqual(3); if (result.status === "completed") return result; }
      throw new Error("FIXTURE_ORIGINAL_NOT_RECOVERED");
    };

    // Continue an opaque second page across controllers without refetching it.
    reset(); const token = "opaque/+?=&token";
    pages = new Map([["", { ids: Array.from({ length: 20 }, (_, i) => `i${i}`), next: token }], [token, { ids: Array.from({ length: 45 }, (_, i) => `i${i + 20}`) }]]);
    expect(await finish(await begin("second-page"))).toMatchObject({ status: "completed", interactionId: "i40" });
    expect({ posts, lists, gets }).toEqual({ posts: 1, lists: 2, gets: 66 });

    // Empty pages cannot bypass the unchanged three-list-page window limit.
    reset(); pages = new Map([["", { ids: [], next: "p1" }], ["p1", { ids: [], next: "p2" }], ["p2", { ids: [], next: "p3" }], ["p3", { ids: ["i40"] }]]);
    const empty = await begin("empty-pages");
    expect(await open().reconcileOriginal({ operationId: empty.operationId })).toMatchObject({ status: "unknown" });
    expect({ lists, gets }).toEqual({ lists: 3, gets: 0 });
    expect(await finish(empty)).toMatchObject({ status: "completed" }); expect(posts).toBe(1);

    // A no-match pass is not zero usage; a later stored original can appear.
    reset(); pages = new Map([["", { ids: [] }]]); const late = await begin("late-visible");
    expect(await open().reconcileOriginal({ operationId: late.operationId })).toMatchObject({ status: "unknown" });
    pages = new Map([["", { ids: ["i40"] }]]); expect(await finish(late)).toMatchObject({ status: "completed" }); expect(posts).toBe(1);

    // Distinct matching native resources are sticky ambiguity; repeated metadata
    // for the same resource is not evidence of a second paid original.
    reset(); matches.add("i60"); const duplicate = await begin("ambiguous");
    expect(await open().reconcileOriginal({ operationId: duplicate.operationId })).toMatchObject({ status: "unknown" });
    expect(await open().reconcileOriginal({ operationId: duplicate.operationId })).toMatchObject({ status: "unknown" });
    const readCount = gets; expect(await open().reconcileOriginal({ operationId: duplicate.operationId })).toMatchObject({ status: "unknown" }); expect(gets).toBe(readCount); expect(posts).toBe(1);
    expect((await journal().read<{ interactionId?: string }>(duplicate.operationId))?.value.interactionId).toBeUndefined();
    reset(); pages = new Map([["", { ids: ["i40", "i40"] }]]); expect(await finish(await begin("same-resource"))).toMatchObject({ status: "completed" }); expect(posts).toBe(1);

    // An unproven resource invalidates uniqueness for that pass. A corrected
    // future pass may recover, with no replacement paid request.
    reset(); pages = new Map([["", { ids: ["bad", "i40"] }]]); malformed.add("bad"); const bad = await begin("bad-resource");
    expect(await open().reconcileOriginal({ operationId: bad.operationId })).toMatchObject({ status: "unknown" });
    malformed.clear(); expect(await finish(bad)).toMatchObject({ status: "completed" }); expect(posts).toBe(1);

    // A unique input can retain the native ID before incomplete usage becomes
    // debit-eligible. The next controller uses direct GET, never another list.
    reset(); pages = new Map([["", { ids: ["i40"] }]]); missingUsage = true; const partial = await begin("partial-usage");
    expect(await open().reconcileOriginal({ operationId: partial.operationId })).toMatchObject({ status: "unknown" });
    expect((await journal().read<{ interactionId?: string }>(partial.operationId))?.value.interactionId).toBe("i40");
    missingUsage = false; expect(await finish(partial)).toMatchObject({ status: "completed" }); expect({ posts, lists, gets }).toEqual({ posts: 1, lists: 1, gets: 3 });

    // Token cycles/invalid pages stay bounded and unknown; token expiry starts
    // a new observation pass without erasing or reissuing the paid original.
    reset(); pages = new Map([["", { ids: [], next: "a" }], ["a", { ids: [], next: "b" }], ["b", { ids: [], next: "a" }]]); const cycle = await begin("token-cycle");
    expect(await open().reconcileOriginal({ operationId: cycle.operationId })).toMatchObject({ status: "unknown" });
    expect(await open().reconcileOriginal({ operationId: cycle.operationId })).toMatchObject({ status: "unknown" }); expect({ posts, lists, gets }).toEqual({ posts: 1, lists: 3, gets: 0 });
    reset(); pages = new Map([["", { ids: [], invalid: true }]]); const invalid = await begin("invalid-page");
    expect(await open().reconcileOriginal({ operationId: invalid.operationId })).toMatchObject({ status: "unknown" }); pages = new Map([["", { ids: ["i40"] }]]); expect(await finish(invalid)).toMatchObject({ status: "completed" });
    reset(); pages = new Map([["", { ids: Array.from({ length: 32 }, (_, i) => `i${i}`), next: "expired" }], ["expired", { ids: [], expired: true }]]); const expired = await begin("token-expired");
    expect(await open().reconcileOriginal({ operationId: expired.operationId })).toMatchObject({ status: "unknown" }); expect(await open().reconcileOriginal({ operationId: expired.operationId })).toMatchObject({ status: "unknown" }); pages = new Map([["", { ids: ["i40"] }]]); expect(await finish(expired)).toMatchObject({ status: "completed" }); expect(posts).toBe(1);

    // Artificial observation clock exercises the actual client's wall-window
    // guard without treating simulated time as real elapsed-duration evidence.
    reset(); jumpClock = true; const timed = await begin("time-bound");
    expect(await open().reconcileOriginal({ operationId: timed.operationId })).toMatchObject({ status: "unknown" }); expect(gets).toBe(1);
    expect(await finish(timed)).toMatchObject({ status: "completed" }); expect(posts).toBe(1);

    // The native SQL transaction really rolls back or commits before the
    // injected process/ACK loss. Recovery observes the same original afterward.
    for (const fault of ["before", "after"] as const) {
      reset(); const crashed = await begin(`commit-${fault}`); faults.progressCommit = fault;
      await expect(open().reconcileOriginal({ operationId: crashed.operationId })).rejects.toThrow(fault === "before" ? "FIXTURE_CRASH_BEFORE_PROGRESS_COMMIT" : "FIXTURE_LOST_PROGRESS_COMMIT_ACK");
      expect(await finish(crashed)).toMatchObject({ status: "completed" }); expect(posts).toBe(1); expect(gets).toBe(fault === "before" ? 98 : 66);
    }

    // Two controllers observe one revision concurrently. A stale CAS cannot
    // rewind the winner's offset or replace the original receipt/native ID.
    reset(); const concurrent = await begin("concurrent"); let release!: () => void; const entered = new Promise<void>(resolve => { release = resolve; }); barrier = { hits: 0, promise: entered, release };
    expect(await Promise.all([open().reconcileOriginal({ operationId: concurrent.operationId }), open().reconcileOriginal({ operationId: concurrent.operationId })])).toMatchObject([{ status: "unknown" }, { status: "unknown" }]);
    expect(gets).toBe(64); barrier = undefined;
    expect(await finish(concurrent)).toMatchObject({ status: "completed" }); expect(readLog[64]).toBe("i32"); expect({ posts, gets }).toEqual({ posts: 1, gets: 98 });

    const adapter = createPostgresVertexOperationJournal(journal());
    if (!adapter.recovery) throw new Error("PRODUCTION_CURSOR_REQUIRED");
    await expect(adapter.recovery.load({ operationId: concurrent.operationId, requestSha256: "0".repeat(64) })).rejects.toThrow("VERTEX_RECOVERY_ORIGINAL_REQUIRED");
    await expect(adapter.recovery.load({ operationId: "operation:foreign", requestSha256: "0".repeat(64) })).rejects.toThrow("VERTEX_RECOVERY_ORIGINAL_REQUIRED");
  } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
