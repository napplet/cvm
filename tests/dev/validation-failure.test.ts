import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableWorkerResultStore, DurableWorkerValidationError, WorkerValidationFailureSchema } from "../../src/dev/durable-worker-result-store";
import { WorkerValidationError } from "../../src/dev/local-napplet-worker";
import { SourceProposalStore } from "../../src/dev/source-proposal-store";
import { LocalProposalWorkerPort } from "../../src/dev/local-generation-adapters";
import { ProviderOperationIntentSchema } from "../../src/model/model-gateway";
import { canonicalJson } from "../../src/promotion/schema";

const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
const hash = "a".repeat(64); const toolchain = "b".repeat(64);
const proposal = { reference: `proposal:sha256:${hash}`, sha256: hash, files: [{ path: "src/main.ts", content: "const app = document.querySelector('#app');" }, { path: "src/styles.css", content: "html, body, #app { height: 100%; }" }, { path: "src/capabilities.json", content: '{"required":[],"optional":[]}' }] };
const request = { sessionId: "session", actionId: "action", expectedVersion: 0, policyVersion: "policy", capabilityGrant: "grant", workspaceId: "workspace", sourceProposalReference: proposal.reference, sourceProposalSha256: hash, sourceProposalFiles: proposal.files };
const failure = WorkerValidationFailureSchema.parse({ version: 1, operationId: "origin", accountId: "account", sessionId: "session", actionId: "action", expectedVersion: 0, proposalSha256: hash, toolchainSha256: toolchain, diagnostic: { file: "src/main.ts", line: 218, column: 120, code: "TS18046" } });
const sourceRow = { proposal_sha256: hash, operation_id: "origin", provider_request_id: "provider", account_id: "account", session_id: "session", action_id: "action", expected_version: 0, request_fingerprint_sha256: "c".repeat(64), prior_artifact_reference: null, provider: "fixture", model: "fixture", profile_id: "profile", price_card_id: "card", proposal_json: proposal };

test("compiler validation failure is durably replayed without another worker invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "validation-failure-"));
  const requestSha256 = digest({ request, accountId: "account", operationId: "origin", toolchainSha256: toolchain });
  const row: any = { request_sha256: requestSha256, ...sourceRow, toolchain_sha256: toolchain, claim_token: "claim", state: "claimed", manifest_sha256: null, failure_json: null };
  let inserted = false;
  const pool: any = { async query(sql: string, values: unknown[]) {
    if (sql.startsWith("SELECT operation_id,account_id,proposal_json")) return { rows: [{ operation_id: "origin", account_id: "account", proposal_json: proposal }] };
    if (sql.startsWith("INSERT INTO development_worker_results")) { if (inserted) return { rows: [] }; inserted = true; return { rows: [row] }; }
    if (sql.startsWith("UPDATE development_worker_results SET state='failed'")) { row.state = "failed"; row.failure_json = values[2]; return { rows: [{ request_sha256: requestSha256 }] }; }
    if (sql.startsWith("SELECT * FROM development_worker_results")) return { rows: [row] };
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  try {
    const store = new DurableWorkerResultStore({ pool, root, toolchainSha256: toolchain });
    await expect(store.materialize(request, async () => { throw new WorkerValidationError(failure.diagnostic); })).rejects.toMatchObject({ name: "DurableWorkerValidationError", reportReference: `validation:sha256:${digest(failure)}` });
    let rerun = false;
    await expect(store.materialize(request, async () => { rerun = true; throw new Error("must not run"); })).rejects.toBeInstanceOf(DurableWorkerValidationError);
    expect(rerun).toBe(false);
    expect(row.failure_json).toEqual(failure);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker port exposes only bound repair references, never compiler output", async () => {
  const report = new DurableWorkerValidationError(failure);
  const port = new LocalProposalWorkerPort({ async materialize() { throw report; } } as any, { results: { async materialize() { throw report; } } as any });
  await expect(port.run(request, new AbortController().signal)).resolves.toEqual({ status: "validation_failed", code: "WORKER_VALIDATION_FAILED", failedArtifactId: proposal.reference, validationReportReference: report.reportReference });
});

test("repair context refuses mismatched owner, report, and toolchain bindings", async () => {
  const intent = ProviderOperationIntentSchema.parse({ operationId: "repair", providerRequestId: "repair", accountId: "account", sessionId: "session", actionId: "repair-action", expectedVersion: 0, actionBudgetReference: "budget", profileId: "profile", priceCardId: "card", requestFingerprint: "d".repeat(64), prompt: "repair", maximumUnits: [{ dimension: "input_tokens", units: "1" }], selection: "unselected", validationRepair: { originOperationId: "origin", sourceReference: proposal.reference, reportReference: `validation:sha256:${digest(failure)}` } });
  const context = (row: Record<string, unknown>) => new SourceProposalStore({ async connect() { return { async query() { return { rows: [row] }; }, release() {} }; } } as any);
  const valid = { ...sourceRow, failure_json: failure, toolchain_sha256: toolchain, state: "failed" };
  await expect(context(valid).repairContext(intent)).resolves.toMatchObject({ source: { reference: proposal.reference }, diagnostic: failure.diagnostic });
  await expect(context({ ...valid, account_id: "foreign", failure_json: { ...failure, accountId: "foreign" } }).repairContext(intent)).rejects.toThrow("VALIDATION_REPAIR_CONTEXT_BINDING_INVALID");
  await expect(context({ ...valid, failure_json: { ...failure, toolchainSha256: "e".repeat(64) } }).repairContext(intent)).rejects.toThrow("VALIDATION_REPAIR_CONTEXT_BINDING_INVALID");
  await expect(context(valid).repairContext({ ...intent, validationRepair: { ...intent.validationRepair!, reportReference: `validation:sha256:${"f".repeat(64)}` } })).rejects.toThrow("VALIDATION_REPAIR_CONTEXT_BINDING_INVALID");
});
