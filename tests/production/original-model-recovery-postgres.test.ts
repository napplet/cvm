import { fundedReplayAuthorityFixture } from "../fixtures/funded-replay-authority";
import { ProtectedGenerationCommands } from "../../src/model/retained-generation-command";
import { ProductionGenerationRecovery } from "../../src/production/generation-recovery";
import { loadMountedCheckpointKek } from "../../src/production/checkpoint-crypto";
import { expect, test } from "bun:test";
import { z } from "zod";
import { Pool } from "pg";
import { createVertexGeminiProductionPricing } from "../../src/model/price-card";
import { createProductionRetainedPricing, registerProductionPricing } from "../../src/production/pricing-catalog";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { MeteredGenerationService, SessionActionResultSchema } from "../../src/phase-04/metered-generation-service";
import { ProductionSourceProposalStore, assertProductionSourceProposalSchema } from "../../src/production/source-proposal-store";
import { ProductionVertexReceiptRecovery } from "../../src/production/vertex-receipt-recovery";
import { ProductionVertexModelGateway } from "../../src/production/vertex-model-gateway";
import { createProductionVertexGenerationSettlement } from "../../src/production/vertex-generation-settlement";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort } from "../../src/release/deployment/vertex-client";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createPostgresVertexOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { ProviderOperationIntentSchema } from "../../src/model/model-gateway";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const now = Date.now();
async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
function restrictedPool(native: Pool): PostgresSqlPool {
  return { async connect() {
    const client = await native.connect();
    return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await client.query<Row>(sql, values ? [...values] : undefined);
      return { rows: result.rows };
    }, release() { client.release(); } };
  } };
}

integration.each([false,true])("lost creation ACK recovers the original paid model across candidate, price, profile and FX changes without redispatch (retained=%s)", async (retained) => {
  const name = `cvm-original-model-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); }
    }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql", "phase-07/003_production_checkpoints.sql", "phase-07/008_production_account_owners.sql", "phase-07/009_production_resume_pricing_quotes.sql", "phase-07/010_production_priced_continuations.sql", "phase-07/011_production_priced_continuation_workers.sql", "phase-07/012_production_priced_continuation_restores.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE funded_generation_test LOGIN");
    await admin.query("GRANT napplet_production_real TO funded_generation_test");
    native = new Pool({ connectionString: `postgresql://funded_generation_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const pool = restrictedPool(native), database = new PostgresFundingDatabase(pool, { realm: "production-real" });
    if(retained) await admin.query(await Bun.file("migrations/phase-07/007_production_generation_recovery.sql").text());
    const commands = new ProtectedGenerationCommands({reference:"test:checkpoint-kek",load:()=>loadMountedCheckpointKek({kekPath:"/test/kek",readFile:async()=>Buffer.alloc(32,9).toString("base64")})});
    const pricing = await createVertexGeminiProductionPricing({
      observation: { sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing", bytes: new TextEncoder().encode("explicit composed model pricing fixture"), observedAtMs: now, freshUntilMs: now + 60_000, currency: "USD", location: "global", model: "gemini-4-argon", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 },
      conversion: { source: { url: "https://blockchain.info/ticker", capturedBytesSha256: "e".repeat(64), observedAt: new Date(now).toISOString(), effectiveAt: new Date(now).toISOString(), freshUntil: new Date(now + 60_000).toISOString() }, satsPerUsd: { numerator: "1000", denominator: "1" } },
      profileId: "composed-model-fixture", maximumInputTokens: "2000", maximumOutputTokens: "100", deadlineMs: 30_000,
    });
    await registerProductionPricing({ pool, ...pricing });
    let posts = 0, builds = 0, reads = 0, at = now;
    let originalInteraction: unknown;
    await expect(assertProductionSourceProposalSchema(pool)).rejects.toThrow("PRODUCTION_SOURCE_PROPOSAL_SCHEMA_REQUIRED");
    expect(posts).toBe(0);
    const migration = await Bun.file("migrations/phase-07/004_production_source_proposals.sql").text();
    await admin.query(migration); await admin.query(migration);
    await assertProductionSourceProposalSchema(pool);
    const sources = new ProductionSourceProposalStore(pool);
    const journal = new PostgresOperationJournal(pool, { namespace: "composed-model", scopeSha256: "a".repeat(64) });
    const interactions = createVertexInteractionsHttpPort({ accessToken: async () => "test-only-token-aaaaaaaaaaaaaaaaaaaa", fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "GET") {
        reads++;
        return String(url).includes("page_size=") ? Response.json({ interaction_metadatas: [{ id: "composed-original" }] }) : Response.json(originalInteraction);
      }
      if (init?.method !== "POST") throw new Error("ONLY_ORIGINAL_POST_EXPECTED");
      posts++;
      const wire = z.object({ input: z.array(z.unknown()), system_instruction: z.string(), generation_config: z.object({ max_output_tokens: z.literal(200) }).passthrough() }).passthrough().parse(JSON.parse(String(init.body)));
      originalInteraction = { id: "composed-original", model: "gemini-4-argon", status: "completed", created: new Date(now).toISOString(), steps: [{ type: "user_input", content: wire.input }, { type: "model_output", content: [{ type: "text", text: JSON.stringify({ files: [{ path: "src/main.ts", content: "document.body.textContent = 'One timer';" }] }) }] }], usage: { total_input_tokens: 1000, total_cached_tokens: 200, total_output_tokens: 100, total_thought_tokens: 0, total_tool_use_tokens: 0, total_tokens: 1100 } };
      throw new Error("FIXTURE_LOST_CREATION_ACK");
    }, { preconnect() {} }) });
    const vertex = createVertexDeploymentClient({ candidateSha256: "b".repeat(64), projectId: "napplet-cvm-test", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:test", price: { sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing", sourceDocumentSha256: pricing.card.sources!.provider.capturedBytesSha256, quoteSha256: "c".repeat(64), observedAtMs: now, freshUntilMs: now + 60_000, effectiveFromMs: now, effectiveUntilMs: now + 60_000, currency: "USD", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 }, journal: createPostgresVertexOperationJournal(journal), interactions, now: () => at });
    const gateway = new ProductionVertexModelGateway({ vertex, proposals: sources });
    const settlement = createProductionVertexGenerationSettlement({ gateway, conversion: pricing.conversion, journal });
    const principal = { pubkey: "9".repeat(64) }, funding = new FundingService(database.funding);
    // Local credit, HTTP and worker protocol fixtures: production classes run,
    // but no real funding, model API, isolated build or release suite is claimed.
    await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "seed-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "seed-topup", rail: "lightning", unit: "sat", amount: "13", externalReference: "seed-external", settlementReference: "seed-settlement", verifiedAt: new Date(now).toISOString() } } });
    const capacity = { async reserveNow(value: { intentReference: string }) { return exactReadyReservation(value.intentReference, `capacity:${value.intentReference.split(":")[1]}`, new Date(now + 1_200_000).toISOString()); }, async observe(value: { intentReference: string }) { return this.reserveNow(value); }, async release() {} };
    const admissions = new FundedAdmissionService({ funding, store: database.funding, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => now });
    const admissionCommand = { principal, idempotencyKey: "admit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "13", unit: "sat" } };
    const admission = await admissions.admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
    if (admission.status !== "accepted") throw new Error("FIXTURE_ADMISSION_REQUIRED");
    const replay = await fundedReplayAuthorityFixture({pool,principal,admissionReference:admission.reference});
    const worker: WorkerPort = { async run(request) { builds++; return { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: "explicit protocol fixture completed" }], artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: "fixture:artifact", purpose: { kind: "focused", statements: ["one counter"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:fixture-scanner" }, conformance: { verdict: "pass", checkId: "upstream:fixture-browser" } } } }; } };
    const verifier: ArtifactVerifier = { async verify(facts) { if (facts.result.status !== "completed") return undefined; return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact }; } };
    const open = () => new MeteredGenerationService({ ...(retained ? {recoveryCommands:commands}:{}), fundedAdmission: admissions, store: database.meteredFunding, gateway, worker, artifactVerifier: verifier, proposalStore: sources, pricing, settlement, continuation: new ContinuationService({ store: database.funding, includeAdmissionHold: true }), toolchainIdentity: "b".repeat(64), clock: { nowMs: () => now } });
    const command = { principal, admissionReference: admission.reference, idempotencyKey: "start", expectedVersion: 0, maximum: "13", policyVersion: "funding-policy-v1", idea: "One focused timer." };
    const first = await open().startSession(command);
    expect(first.status).toBe("usage_unknown");
    expect({ posts, builds, reads }).toEqual({ posts: 1, builds: 0, reads: 0 });
    if (first.status !== "usage_unknown") throw new Error("FIXTURE_UNKNOWN_REQUIRED");
    const prepared = await database.meteredFunding.findMeteredAction(first.accountId, command.idempotencyKey);
    if (!prepared) throw new Error("FIXTURE_PREPARED_REQUIRED");
    const intent = ProviderOperationIntentSchema.parse({ operationId: prepared.operationId, providerRequestId: prepared.operationId, accountId: prepared.accountId, sessionId: prepared.sessionId, actionId: prepared.actionId, expectedVersion: prepared.expectedVersion, actionBudgetReference: prepared.actionBudgetReference, profileId: prepared.profileId, priceCardId: prepared.priceCardId, requestFingerprint: prepared.fingerprint, prompt: command.idea, maximumUnits: pricing.profile.maximumUnits, selection: "unselected" });
    at = now + 120_000;
    const nextPricing = await createVertexGeminiProductionPricing({
      observation: { sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing", bytes: new TextEncoder().encode("new explicit fixture source"), observedAtMs: at, freshUntilMs: at + 60_000, currency: "USD", location: "global", model: "gemini-4-argon", inputMicrosPerMillion: 8_000_000, cachedInputMicrosPerMillion: 400_000, outputAndThoughtMicrosPerMillion: 40_000_000 },
      conversion: { source: { url: "https://blockchain.info/ticker", capturedBytesSha256: "f".repeat(64), observedAt: new Date(at).toISOString(), effectiveAt: new Date(at).toISOString(), freshUntil: new Date(at + 60_000).toISOString() }, satsPerUsd: { numerator: "2000", denominator: "1" } },
      profileId: "upgraded-model-fixture", maximumInputTokens: "2000", maximumOutputTokens: "100", deadlineMs: 30_000,
    });
    await registerProductionPricing({ pool, ...nextPricing });
    const originalConfig = vertex.discovery();
    const current = createVertexDeploymentClient({ ...originalConfig, candidateSha256: "d".repeat(64), price: { ...originalConfig.price, sourceDocumentSha256: nextPricing.card.sources!.provider.capturedBytesSha256, observedAtMs: at, freshUntilMs: at + 60_000, effectiveFromMs: at, effectiveUntilMs: at + 60_000, inputMicrosPerMillion: 8_000_000, cachedInputMicrosPerMillion: 400_000, outputAndThoughtMicrosPerMillion: 40_000_000 }, journal: createPostgresVertexOperationJournal(journal), interactions, now: () => at });
    await expect(current.reconcileOriginal({ operationId: prepared.operationId })).rejects.toThrow("VERTEX_OPERATION_IDENTITY_CONFLICT");
    const recovery = new ProductionVertexReceiptRecovery({ pool, journal, interactions, current, now: () => at });
    const retainedPricing = createProductionRetainedPricing(pool);
    expect(await retainedPricing.readOriginal(prepared)).toEqual({ profile: pricing.profile, card: pricing.card });
    expect(await retainedPricing.readOriginal({ ...prepared, accountId: `account:${"0".repeat(64)}` })).toBeUndefined();
    expect(await retainedPricing.readOriginal({ ...prepared, maximum: prepared.maximum + 1n })).toBeUndefined();
    for (const changed of [{ ...intent, accountId: `account:${"0".repeat(64)}` }, { ...intent, actionBudgetReference: "foreign:budget" }, { ...intent, profileId: nextPricing.profile.id }]) await expect(recovery.reconcile(changed)).rejects.toThrow("PRODUCTION_VERTEX_ORIGINAL_OWNER_REQUIRED");
    await expect(recovery.reconcile({ ...intent, prompt: "Changed idea" })).rejects.toThrow("PRODUCTION_VERTEX_ORIGINAL_REQUEST_REQUIRED");
    await expect(recovery.reconcile({ ...intent, maximumUnits: [{ dimension: "input_tokens", units: "999" }, { dimension: "output_tokens", units: "200" }] })).rejects.toThrow("PRODUCTION_VERTEX_ORIGINAL_REQUEST_REQUIRED");
    const foreignProject = createVertexDeploymentClient({ ...current.discovery(), projectId: "different-fixture-project", journal: createPostgresVertexOperationJournal(journal), interactions });
    await expect(new ProductionVertexReceiptRecovery({ pool, journal, interactions, current: foreignProject }).reconcile(intent)).rejects.toThrow("PRODUCTION_VERTEX_ORIGINAL_PROJECT_APPROVAL_REQUIRED");
    expect(reads).toBe(0);
    const nextGateway = new ProductionVertexModelGateway({ vertex: current, proposals: sources, recovery });
    const nextSettlement = createProductionVertexGenerationSettlement({ gateway: nextGateway, conversion: nextPricing.conversion, journal });
    const upgraded = () => new MeteredGenerationService({ fundedAdmission: admissions, store: database.meteredFunding, gateway: nextGateway, worker, artifactVerifier: verifier, proposalStore: sources, pricing: nextPricing, settlement: nextSettlement, retainedPricing, continuation: new ContinuationService({ store: database.funding, includeAdmissionHold: true }), toolchainIdentity: "b".repeat(64), clock: { nowMs: () => at } });
    await expect(upgraded().startSession({ ...command, idea: "Changed idea" })).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
    const missingCatalog = new MeteredGenerationService({ fundedAdmission: admissions, store: database.meteredFunding, gateway: nextGateway, worker, artifactVerifier: verifier, pricing: nextPricing, settlement: nextSettlement });
    await expect(missingCatalog.startSession(command)).rejects.toThrow("RECORDED_ACTION_PRICING_REQUIRED");
    expect(reads).toBe(0);
    if(retained){
      await admin.query("UPDATE production_real.generation_recovery_commands SET next_attempt_at=clock_timestamp()-interval '1 second'");
      expect(await new ProductionGenerationRecovery({pool,commands,replayAuthority:replay.authority,acceptedToolchains:["f".repeat(64)],generation:upgraded()}).scan()).toEqual({attempted:1,erased:0});
      expect({posts,reads,builds}).toEqual({posts:1,reads:0,builds:0});
      await admin.query("UPDATE production_real.generation_recovery_commands SET next_attempt_at=clock_timestamp()-interval '1 second'");
      expect(await new ProductionGenerationRecovery({pool,commands,replayAuthority:replay.authority,acceptedToolchains:["b".repeat(64)],generation:upgraded()}).scan()).toEqual({attempted:1,erased:0});
    }
    const result = retained ? SessionActionResultSchema.parse((await database.meteredFunding.findMeteredAction(prepared.accountId,command.idempotencyKey))?.result) : await upgraded().startSession(command);
    expect(result).toMatchObject({ status: "completed", confirmedSpend: "6", remainingCap: "7" });
    if (result.status !== "completed") throw new Error("FIXTURE_COMPLETION_REQUIRED");
    expect(await upgraded().startSession(command)).toEqual(result);
    expect({ posts, builds }).toEqual({ posts: 1, builds: 1 });
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.source_proposals")).rows[0].count).toBe(1);
    expect(reads).toBe(3);
    const finalAction = await database.meteredFunding.findMeteredAction(result.accountId, command.idempotencyKey);
    expect(finalAction?.operationId).toBe(prepared.operationId);
    expect(finalAction?.actionBudgetReference).toBe(prepared.actionBudgetReference);
    expect(finalAction?.profileId).toBe(pricing.profile.id);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.metered_actions")).rows[0].count).toBe(1);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.action_budget_reservations")).rows[0].count).toBe(1);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.ledger_entries WHERE direction='debit' AND account_id=$1", [prepared.accountId])).rows[0].count).toBe(1);
    expect({ posts, builds, reads }).toEqual({ posts: 1, builds: 1, reads: 3 });
    await expect(native.query("UPDATE production_real.source_proposals SET proposal_json='{}'::jsonb")).rejects.toThrow();
    await expect(admin.query("DELETE FROM production_real.source_proposals")).rejects.toThrow("PRODUCTION_SOURCE_PROPOSAL_IMMUTABLE");
  } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
