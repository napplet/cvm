import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevelopmentPool, type DevPayments } from "../../scripts/dev-payments";
import { SourceProposalStore } from "../../src/dev/source-proposal-store";
import { DevelopmentModelGateway } from "../../src/dev/development-model-gateway";
import { DurableWorkerResultStore } from "../../src/dev/durable-worker-result-store";
import { LocalNappletWorker, runBoundedDevelopmentCommand } from "../../src/dev/local-napplet-worker";
import { LocalProposalWorkerPort } from "../../src/dev/local-generation-adapters";
import { LocalArtifactVerifier } from "../../src/dev/local-artifact-verifier";
import { accountIdForPrincipal } from "../../src/domain/account-command";

test("SQL worker claim reuses a real Docker result across duplicates, process recreation and completion-write loss", async () => {
  const config = await Bun.file(`${import.meta.dir}/../../.local/napplet-cvm-dev-payments/payments.json`).json() as DevPayments;
  let pool = createDevelopmentPool(config.databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "napplet-worker-result-"));
  const ownerId = "73".repeat(32); const accountId = await accountIdForPrincipal({ pubkey: ownerId }); const nonce = crypto.randomUUID();
  const operationId = `operation:worker-persistence:${nonce}`;
  let builds = 0;
  try {
    const inspected = await runBoundedDevelopmentCommand(["docker", "image", "inspect", "napplet-cvm/dev-worker:development", "--format", "{{.Id}}"], { deadlineMs: 15_000, maxBytes: 1_000 });
    expect(inspected.exitCode).toBe(0);
    const image = inspected.stdout.trim(); const toolchainSha256 = image.replace(/^sha256:/u, "");
    const proposals = new SourceProposalStore(pool);
    const intent = { operationId, providerRequestId: operationId, accountId, sessionId: `session:${nonce}`, actionId: `start:${nonce}`, expectedVersion: 0, actionBudgetReference: `budget:${nonce}`, profileId: "code-proposal", priceCardId: "phase-04-deterministic-card-2026-08-04", requestFingerprint: "a".repeat(64), prompt: "A focused counter", maximumUnits: [{ dimension: "input_tokens", units: "1000" }, { dimension: "output_tokens", units: "1000" }], selection: "unselected" as const };
    await new DevelopmentModelGateway({ store: proposals }).dispatch(intent, new AbortController().signal);
    const proposal = (await proposals.lookup({ intent }))!.proposal;
    const request = { sessionId: intent.sessionId, actionId: intent.actionId, expectedVersion: 0, policyVersion: "development-local-v1", capabilityGrant: "development-test", workspaceId: `workspace:${nonce}`, sourceProposalReference: proposal.reference, sourceProposalSha256: proposal.sha256, sourceProposalFiles: proposal.files };
    const worker = new LocalNappletWorker({ image });
    const materialize = worker.materialize.bind(worker);
    worker.materialize = async (...args) => { builds += 1; return materialize(...args); };
    let results = new DurableWorkerResultStore({ pool, root, toolchainSha256 });
    let port = new LocalProposalWorkerPort(worker, { results });
    const concurrentPort = new LocalProposalWorkerPort(worker, { results: new DurableWorkerResultStore({ pool, root, toolchainSha256 }) });
    const [first, duplicate] = await Promise.all([port.run(request, new AbortController().signal), concurrentPort.run(request, new AbortController().signal)]);
    expect(first.status).toBe("completed"); expect(duplicate).toEqual(first); expect(builds).toBe(1);
    const output = port.take(request)!.output;
    const facts = { ownerId, accountId, sessionId: request.sessionId, actionId: request.actionId, expectedVersion: 0, proposalSha256: proposal.sha256, toolchainSha256, distRoot: output.distRoot, commandEvidence: output.commandEvidence };
    const verified = await new LocalArtifactVerifier().verify(facts);
    expect(verified.files.some((file) => file.path === "index.html")).toBe(true);
    await port.discard(request);
    await pool.end(); pool = createDevelopmentPool(config.databaseUrl);
    results = new DurableWorkerResultStore({ pool, root, toolchainSha256 });
    port = new LocalProposalWorkerPort(worker, { results });
    expect(await port.run(request, new AbortController().signal)).toEqual(first);
    expect(builds).toBe(1);
    expect((await new LocalArtifactVerifier().verify({ ...facts, distRoot: port.take(request)!.output.distRoot })).aggregateSha256).toBe(verified.aggregateSha256);
    // Model a process exit after immutable output installation but before the
    // SQL completed flag. The pre-persisted hash still authorizes exact reuse.
    await pool.query("UPDATE development_worker_results SET state='claimed',completed_at=NULL WHERE operation_id=$1", [operationId]);
    const recovered = await new DurableWorkerResultStore({ pool, root, toolchainSha256 }).materialize(request, async () => { throw new Error("MUST_NOT_BUILD_AGAIN"); });
    expect(recovered.distRoot).toBe(output.distRoot);
    const row = (await pool.query<{ state: string; count: string }>("SELECT state,count(*) OVER ()::text AS count FROM development_worker_results WHERE operation_id=$1", [operationId])).rows[0]!;
    expect(row).toMatchObject({ state: "completed", count: "1" });
    const originalHash = (await pool.query<{ manifest_sha256: string }>("SELECT manifest_sha256 FROM development_worker_results WHERE operation_id=$1", [operationId])).rows[0]!.manifest_sha256;
    await pool.query("UPDATE development_worker_results SET state='claimed',manifest_sha256=NULL WHERE operation_id=$1", [operationId]);
    await expect(new DurableWorkerResultStore({ pool, root, toolchainSha256, waitMs: 20 }).materialize(request, async () => { throw new Error("MUST_NOT_REPLACE_UNKNOWN_BUILD"); })).rejects.toThrow("DEV_WORKER_ORIGINAL_BUILD_UNCERTAIN");
    await pool.query("UPDATE development_worker_results SET state='completed',manifest_sha256=$2 WHERE operation_id=$1", [operationId, originalHash]);
    await expect(results.materialize({ ...request, sessionId: "session:foreign" }, async () => { throw new Error("must not run"); })).rejects.toThrow("DEV_WORKER_SOURCE_BINDING_INVALID");
    await expect(new DurableWorkerResultStore({ pool, root, toolchainSha256: "0".repeat(64) }).materialize(request, async () => { throw new Error("must not run"); })).rejects.toThrow("DEV_WORKER_RESULT_BINDING_INVALID");
    const index = join(recovered.distRoot, "index.html"); await chmod(index, 0o600); await writeFile(index, "tampered");
    await expect(new DurableWorkerResultStore({ pool, root, toolchainSha256 }).materialize(request, async () => { throw new Error("must not run"); })).rejects.toThrow("DEV_WORKER_RESULT_FILES_CHANGED");
    expect(builds).toBe(1);
  } finally {
    await pool.query("DELETE FROM development_worker_results WHERE operation_id=$1", [operationId]);
    await pool.query("DELETE FROM provider_observations WHERE operation_id=$1", [operationId]);
    await pool.query("DELETE FROM source_proposals WHERE operation_id=$1", [operationId]);
    await pool.end(); await rm(root, { recursive: true, force: true });
  }
}, 240_000);
