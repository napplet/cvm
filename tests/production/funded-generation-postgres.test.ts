import { registerProductionPricing } from "../../src/production/pricing-catalog";
import { createVertexGeminiProductionPricing } from "../../src/model/price-card";
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { ProductionContinuationCoordinator } from "../../src/production/continuation-coordinator";
import { ProductionCheckpointCoordinator } from "../../src/production/checkpoint-coordinator";
import { ProductionWorkerBridge, ProductionWorkerOwnershipResolver } from "../../src/production/worker-bridge";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { DeterministicObjectStore } from "../../src/continuity/object-store";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES } from "../../src/model/price-card";
import type { ModelGateway } from "../../src/model/model-gateway";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";
import { proveAdmissionCommitOutcomes } from "../fixtures/admission-commit-outcome";
import { proveAdmissionCompensationWins, proveAdmissionAcceptanceWins, proveAdmissionCompensationFaults } from "../fixtures/admission-compensation-race";
import { proveAdmissionCapacityRecovery } from "../fixtures/admission-capacity-recovery";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const now = Date.parse("2026-10-28T12:00:00Z");
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

integration("production funded start spends its own accepted cap without requiring extra unheld funds", async () => {
  const name = `cvm-funded-generation-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); }
    }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("INSERT INTO production_real.model_profile_versions(id,profile_hash,provider,model,normalized_profile) VALUES($1,$2,'deterministic_fixture','phase-04-fixture-model',$3::jsonb)", [PHASE_04_MODEL_PROFILES["code-proposal"].id, "c".repeat(64), JSON.stringify(PHASE_04_MODEL_PROFILES["code-proposal"])]);
    await admin.query("INSERT INTO production_real.price_card_versions(id,card_hash,profile_id,unit,normalized_card) VALUES($1,$2,$3,'sat',$4::jsonb)", [PHASE_04_DETERMINISTIC_PRICE_CARD.id, "d".repeat(64), PHASE_04_MODEL_PROFILES["code-proposal"].id, JSON.stringify(PHASE_04_DETERMINISTIC_PRICE_CARD)]);
    await admin.query("CREATE ROLE funded_generation_test LOGIN");
    await admin.query("GRANT napplet_production_real TO funded_generation_test");
    native = new Pool({ connectionString: `postgresql://funded_generation_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const pool = restrictedPool(native), database = new PostgresFundingDatabase(pool, { realm: "production-real" });
    const principal = { pubkey: "6".repeat(64) }, funding = new FundingService(database.funding);
    // Deliberate ledger/model/worker protocol fixtures, not real rail credits,
    // paid model usage, an isolated build or production certification evidence.
    await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "seed-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "seed-topup", rail: "lightning", unit: "sat", amount: "3250", externalReference: "seed-external", settlementReference: "seed-settlement", verifiedAt: new Date(now).toISOString() } } });
    const capacity = { async reserveNow(value: { intentReference: string }) { return exactReadyReservation(value.intentReference, `capacity:${value.intentReference.split(":")[1]}`, new Date(now + 1_200_000).toISOString()); }, async observe(value: { intentReference: string }) { return this.reserveNow(value); }, async release() {} };
    const admissions = new FundedAdmissionService({ funding, store: database.funding, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => now });
    const admissionCommand = { principal, idempotencyKey: "admit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "3250", unit: "sat" } };
    const admission = await admissions.admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
    expect(admission.status).toBe("accepted"); if (admission.status !== "accepted") throw new Error("TEST_ADMISSION_FAILED");
    expect((await funding.status(principal)).available).toBe("0");
    const journal = new PostgresOperationJournal(pool, { namespace: "funded-generation", scopeSha256: "a".repeat(64) });
    const objects = new DeterministicObjectStore();
    const bridge = new ProductionWorkerBridge({ resolver: new ProductionWorkerOwnershipResolver({ pool, policyVersion: "funding-policy-v1", capacityJournal: journal }), workers: {} as never, workerJournal: journal, jobJournal: journal, requestJournal: journal, artifactStore: objects, toolchainSha256: "b".repeat(64) });
    const checkpoint = new ProductionCheckpointCoordinator({ pool, objectStore: objects, journal, kekPath: "/test/checkpoint-kek", readKekFile: async () => Buffer.alloc(32, 7).toString("base64") });
    const continuation = new ProductionContinuationCoordinator({ pool, store: database.funding, capacity, worker: bridge, checkpoint, compatibility: { policyVersion: "funding-policy-v1", profileId: PHASE_04_MODEL_PROFILES["code-proposal"].id, priceCardId: PHASE_04_DETERMINISTIC_PRICE_CARD.id, toolchainId: "b".repeat(64) }, now: () => now });
    let dispatches = 0, builds = 0;
    const gateway: ModelGateway = { async dispatch(intent) { dispatches++; return { status: "completed", receipt: { operationId: intent.operationId, providerRequestId: intent.providerRequestId, provider: "deterministic_fixture", model: "phase-04-fixture-model", profileId: intent.profileId, priceCardId: intent.priceCardId, selection: "unselected", completedAt: new Date(now).toISOString(), provenance: { protectedEvidenceReference: "fixture:usage" }, usage: [{ dimension: "input_tokens", units: "10" }, { dimension: "output_tokens", units: "5" }] } }; }, async lookup() { throw new Error("UNEXPECTED_LOOKUP"); } };
    const worker: WorkerPort = { async run(request) { builds++; return { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: "explicit protocol fixture completed" }], artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: "fixture:artifact", purpose: { kind: "focused", statements: ["one counter"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:fixture-scanner" }, conformance: { verdict: "pass", checkId: "upstream:fixture-browser" } } } }; } };
    const verifier: ArtifactVerifier = { async verify(facts) { if (facts.result.status !== "completed") return undefined; return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact }; } };
    const open = () => new MeteredGenerationService({ fundedAdmission: admissions, store: database.meteredFunding, gateway, worker, artifactVerifier: verifier, continuation: continuation.service, toolchainIdentity: "b".repeat(64), clock: { nowMs: () => now } });
    const command = { principal, admissionReference: admission.reference, idempotencyKey: "start", expectedVersion: 0, maximum: "3250", policyVersion: "funding-policy-v1", idea: "Build one focused counter napplet." };
    const result = await open().startSession(command);
    expect(result).toMatchObject({ status: "completed", confirmedSpend: "15", remainingCap: "3235" });
    expect(await open().startSession(command)).toEqual(result);
    expect({ dispatches, builds }).toEqual({ dispatches: 1, builds: 1 });
    expect((await funding.status(principal)).held).toBe("3235");
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.continuation_pauses")).rows[0].count).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS count FROM public.funding_accounts")).rows[0].count).toBe(0);
    await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "second-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "second-topup", rail: "lightning", unit: "sat", amount: "3250", externalReference: "second-external", settlementReference: "second-settlement", verifiedAt: new Date(now).toISOString() } } });
    const secondCommand = { ...admissionCommand, idempotencyKey: "second-admission" };
    const secondAdmission = await admissions.admit(secondCommand, await trustedAdmissionReceipt(secondCommand));
    expect(secondAdmission.status).toBe("accepted");
    if (secondAdmission.status !== "accepted") throw new Error("SECOND_ADMISSION_FAILED");
    expect((await funding.status(principal)).available).toBe("0");
    if (result.status !== "completed") throw new Error("FIRST_GENERATION_NOT_COMPLETED");
    const paused = await open().reviseSession({ principal, sessionId: result.sessionId, admissionReference: admission.reference, idempotencyKey: "revision-needs-cap", expectedVersion: 1, maximum: "3250", policyVersion: "funding-policy-v1", revision: "Use a larger counter button." });
    expect(paused).toMatchObject({ status: "needs_top_up", requiredAdditionalFunding: "15", requiredCapApproval: "15", remainingCap: "3235" });
    expect({ dispatches, builds }).toEqual({ dispatches: 1, builds: 1 });
    expect((await funding.status(principal)).admissions.find(value => value.reference === admission.reference)?.heldAmount).toBe("3235");
    const reservations = await Promise.allSettled(["left", "right"].map(key => database.funding.transact(admission.accountId, transaction => transaction.reserveActionBudget({ accountId: admission.accountId, admissionReference: secondAdmission.reference, idempotencyKey: `race:${key}`, fingerprint: (key === "left" ? "8" : "9").repeat(64), reference: `budget:${key}`, amount: 3250n }))));
    expect(reservations.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(reservations.filter(value => value.status === "rejected")).toHaveLength(1);
    const pausesBeforeBudgetCollision = await admin.query("SELECT count(*)::int AS count FROM production_real.continuation_pauses");
    await expect(open().startSession({ ...command, admissionReference: secondAdmission.reference, idempotencyKey: "blocked-by-active-budget" })).rejects.toThrow("ACTION_BUDGET_EXCEEDS_APPROVED_CAP");
    // A competing active budget is an authorization failure, not a recoverable
    // funding pause.  It must therefore create no new pause or external work.
    expect(await admin.query("SELECT count(*)::int AS count FROM production_real.continuation_pauses")).toEqual(pausesBeforeBudgetCollision);
    expect({ dispatches, builds }).toEqual({ dispatches: 1, builds: 1 });
    const pricingInput = {
      observation: { sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing", bytes: new TextEncoder().encode("explicit local pricing-catalog fixture"), observedAtMs: now, freshUntilMs: now + 60_000, currency: "USD" as const, location: "global" as const, model: "gemini-4-argon" as const, inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 },
      conversion: { source: { url: "https://blockchain.info/ticker", capturedBytesSha256: "e".repeat(64), observedAt: new Date(now).toISOString(), effectiveAt: new Date(now).toISOString(), freshUntil: new Date(now + 60_000).toISOString() }, satsPerUsd: { numerator: "1000", denominator: "1" } },
      profileId: "catalog-fixture-v1", maximumInputTokens: "1000", maximumOutputTokens: "100", deadlineMs: 30_000,
    };
    const pricing = await createVertexGeminiProductionPricing(pricingInput);
    expect((await createVertexGeminiProductionPricing(pricingInput)).card.id).toBe(pricing.card.id);
    expect((await createVertexGeminiProductionPricing({ ...pricingInput, observation: { ...pricingInput.observation, freshUntilMs: now + 120_000 } })).card.id).not.toBe(pricing.card.id);
    expect((await createVertexGeminiProductionPricing({ ...pricingInput, deadlineMs: 30_001 })).card.id).not.toBe(pricing.card.id);
    await expect(registerProductionPricing({ pool, ...pricing })).rejects.toThrow("PRODUCTION_PRICING_IMMUTABLE_SCHEMA_REQUIRED");
    const migration = await Bun.file("migrations/phase-07/002_production_pricing_catalog.sql").text();
    await admin.query(migration); await admin.query(migration);
    await Promise.all(Array.from({ length: 4 }, () => registerProductionPricing({ pool, ...pricing })));
    const snapshot = await admin.query("SELECT id,card_hash,profile_id,normalized_card FROM production_real.price_card_versions WHERE id=$1", [pricing.card.id]);
    expect(snapshot.rows.length).toBe(1); expect(snapshot.rows[0].normalized_card).toEqual(pricing.card);
    await expect(registerProductionPricing({ pool, profile: PHASE_04_MODEL_PROFILES["code-proposal"], card: PHASE_04_DETERMINISTIC_PRICE_CARD })).rejects.toThrow("PRODUCTION_PRICING_AUTHORITY_REQUIRED");
    await expect(registerProductionPricing({ pool, profile: { ...pricing.profile, deadlineMs: 30_001 }, card: pricing.card })).rejects.toThrow("PRODUCTION_MODEL_PROFILE_VERSION_CONFLICT");
    await expect(registerProductionPricing({ pool, profile: pricing.profile, card: { ...pricing.card, rates: { ...pricing.card.rates, input_tokens: { numerator: "99999999", denominator: "1000000" } } } })).rejects.toThrow("PRODUCTION_PRICE_CARD_VERSION_CONFLICT");
    await expect(native.query("UPDATE production_real.price_card_versions SET normalized_card='{}'::jsonb WHERE id=$1", [pricing.card.id])).rejects.toThrow();
    await expect(admin.query("UPDATE production_real.price_card_versions SET normalized_card='{}'::jsonb WHERE id=$1", [pricing.card.id])).rejects.toThrow("PRODUCTION_PRICING_VERSION_IMMUTABLE");
    expect((await admin.query("SELECT id,card_hash,profile_id,normalized_card FROM production_real.price_card_versions WHERE id=$1", [pricing.card.id])).rows).toEqual(snapshot.rows);
    const refreshed = await createVertexGeminiProductionPricing({ ...pricingInput, profileId: "catalog-fixture-v2", observation: { ...pricingInput.observation, freshUntilMs: now + 120_000 } });
    expect(refreshed.card.id).not.toBe(pricing.card.id);
    await registerProductionPricing({ pool, ...refreshed });
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.price_card_versions")).rows[0].count).toBe(3);
    expect((await admin.query("SELECT id,card_hash,profile_id,normalized_card FROM production_real.price_card_versions WHERE id=$1", [pricing.card.id])).rows).toEqual(snapshot.rows);

    await proveAdmissionCommitOutcomes(pool);
    await proveAdmissionCompensationWins(pool);
    await proveAdmissionAcceptanceWins(pool);
    await proveAdmissionCompensationFaults(pool);
    await proveAdmissionCapacityRecovery(pool);
  } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); }
}, 120_000);
