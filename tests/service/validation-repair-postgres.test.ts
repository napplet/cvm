import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCanonicalMigrations } from "../../src/service/migrations";
import { SourceProposalStore } from "../../src/dev/source-proposal-store";
import { DurableWorkerResultStore, WorkerValidationFailureSchema } from "../../src/dev/durable-worker-result-store";
import { WorkerValidationError } from "../../src/dev/local-napplet-worker";
import { ProviderOperationIntentSchema } from "../../src/model/model-gateway";

type Pool = { query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>; connect(): Promise<any>; end(): Promise<void> };
const { Pool: PgPool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => Pool };
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const container = `napplet-cvm-validation-repair-${crypto.randomUUID().slice(0, 8)}`;
let port = "";

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${stderr.slice(0, 300)}`);
  return stdout.trim();
}
async function database(): Promise<Pool> {
  const admin = new PgPool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
  try { await admin.query("CREATE DATABASE validation_repair"); } finally { await admin.end(); }
  return new PgPool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/validation_repair`, connectionTimeoutMillis: 2000 });
}
const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const sourceFiles = [
  { path: "src/main.ts", content: "import './styles.css'; import { runtimeHasDomain } from './domain-availability.js'; void runtimeHasDomain('storage');" },
  { path: "src/styles.css", content: "html, body, #app { height: 100%; }" },
  { path: "src/capabilities.json", content: '{"required":[],"optional":[]}' },
];
const toolchain = "b".repeat(64);

function intent(input: Readonly<{ operationId: string; actionId: string; version?: number; accountId?: string; sessionId?: string }>) {
  return ProviderOperationIntentSchema.parse({ operationId: input.operationId, providerRequestId: input.operationId, accountId: input.accountId ?? "account:owner", sessionId: input.sessionId ?? "session:owner", actionId: input.actionId, expectedVersion: input.version ?? 0, actionBudgetReference: `budget:${input.operationId}`, profileId: "profile", priceCardId: "card", requestFingerprint: digest(input.operationId), prompt: "A focused counter", maximumUnits: [{ dimension: "input_tokens", units: "100" }], selection: "unselected" });
}

beforeAll(async () => {
  if (process.env.NAPPLET_RUN_POSTGRES_ISOLATION !== "1") return;
  await docker(["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.11-alpine3.24"]);
  port = (await docker(["port", container, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)![1]!;
  const probe = new PgPool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
  try { for (let attempt = 0; ; attempt++) { try { await probe.query("SELECT 1"); break; } catch (error) { if (attempt > 120) throw error; await Bun.sleep(250); } } }
  finally { await probe.end(); }
}, 60_000);
afterAll(async () => { if (port) await docker(["rm", "--force", container]).catch(() => undefined); });

integration("canonical PostgreSQL migrations persist, replay, and scope compiler-repair context", async () => {
  const pool = await database(); const root = await mkdtemp(join(tmpdir(), "validation-repair-pg-"));
  try {
    await applyCanonicalMigrations(pool as any);
    const proposals = new SourceProposalStore(pool as any);
    const original = intent({ operationId: "operation:origin", actionId: "action:origin" });
    const stored = await proposals.persist({ intent: original, provider: "fixture", model: "fixture", proposal: { files: sourceFiles } });
    const request = { sessionId: original.sessionId, actionId: original.actionId, expectedVersion: original.expectedVersion, policyVersion: "policy", capabilityGrant: "grant", workspaceId: "workspace", sourceProposalReference: stored.proposal.reference, sourceProposalSha256: stored.proposal.sha256, sourceProposalFiles: stored.proposal.files };
    const diagnostic = { file: "src/main.ts" as const, line: 218, column: 120, code: "TS18046" };
    const results = new DurableWorkerResultStore({ pool: pool as any, root, toolchainSha256: toolchain });
    await expect(results.materialize(request, async () => { throw new WorkerValidationError(diagnostic); })).rejects.toThrow("WORKER_VALIDATION_FAILED");
    const failed = (await pool.query<{ state: string; failure_json: unknown }>("SELECT state,failure_json FROM development_worker_results WHERE operation_id=$1", [original.operationId])).rows[0]!;
    const report = WorkerValidationFailureSchema.parse(failed.failure_json);
    expect(failed.state).toBe("failed");
    expect(report).toMatchObject({ operationId: original.operationId, accountId: original.accountId, sessionId: original.sessionId, actionId: original.actionId, expectedVersion: 0, proposalSha256: stored.proposal.sha256, toolchainSha256: toolchain, diagnostic });
    const reportBeforeReplay = JSON.stringify(failed.failure_json);
    let rerun = false;
    await expect(new DurableWorkerResultStore({ pool: pool as any, root, toolchainSha256: toolchain }).materialize(request, async () => { rerun = true; throw new Error("MUST_NOT_RUN"); })).rejects.toThrow("WORKER_VALIDATION_FAILED");
    expect(rerun).toBe(false);
    expect(JSON.stringify((await pool.query<{ failure_json: unknown }>("SELECT failure_json FROM development_worker_results WHERE operation_id=$1", [original.operationId])).rows[0]!.failure_json)).toBe(reportBeforeReplay);

    // Fetch the canonical reference from the durable replay path rather than
    // rebuilding it from database JSON serialization details.
    let reference = "";
    try { await new DurableWorkerResultStore({ pool: pool as any, root, toolchainSha256: toolchain }).materialize(request, async () => { throw new Error("MUST_NOT_RUN"); }); }
    catch (error) { reference = (error as { reportReference?: string }).reportReference ?? ""; }
    expect(reference).toMatch(/^validation:sha256:[a-f0-9]{64}$/u);
    const repair = ProviderOperationIntentSchema.parse({ ...intent({ operationId: "operation:repair", actionId: "action:repair" }), validationRepair: { originOperationId: original.operationId, sourceReference: stored.proposal.reference, reportReference: reference } });
    await expect(proposals.repairContext(repair)).resolves.toMatchObject({ source: stored.proposal, diagnostic });
    for (const rejected of [
      { ...repair, accountId: "account:foreign" },
      { ...repair, sessionId: "session:foreign" },
      { ...repair, expectedVersion: 1 },
      { ...repair, validationRepair: { ...repair.validationRepair!, sourceReference: `proposal:sha256:${"c".repeat(64)}` } },
      { ...repair, validationRepair: { ...repair.validationRepair!, reportReference: `validation:sha256:${"d".repeat(64)}` } },
    ]) await expect(proposals.repairContext(rejected)).rejects.toThrow();

    const generic = intent({ operationId: "operation:generic", actionId: "action:generic" });
    const genericSource = await proposals.persist({ intent: generic, provider: "fixture", model: "fixture", proposal: { files: sourceFiles } });
    const genericRequest = { ...request, actionId: generic.actionId, sourceProposalReference: genericSource.proposal.reference, sourceProposalSha256: genericSource.proposal.sha256, sourceProposalFiles: genericSource.proposal.files };
    await expect(new DurableWorkerResultStore({ pool: pool as any, root, toolchainSha256: toolchain }).materialize(genericRequest, async () => { throw new Error("WORKER_INFRA_FAILURE"); })).rejects.toThrow("WORKER_INFRA_FAILURE");
    expect((await pool.query<{ state: string; failure_json: unknown }>("SELECT state,failure_json FROM development_worker_results WHERE operation_id=$1", [generic.operationId])).rows[0]).toEqual({ state: "failed", failure_json: null });
    await expect(proposals.repairContext(ProviderOperationIntentSchema.parse({ ...intent({ operationId: "operation:generic-repair", actionId: "action:generic-repair" }), validationRepair: { originOperationId: generic.operationId, sourceReference: genericSource.proposal.reference, reportReference: reference } }))).rejects.toThrow();
  } finally { await pool.end(); await rm(root, { recursive: true, force: true }); }
}, 90_000);
