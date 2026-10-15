import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDevelopmentPool, developmentStack, type DevPayments } from "../../scripts/dev-payments";
import { accountIdForPrincipal } from "../../src/domain/account-command";
import { PendingActionEnvelopeService } from "../../src/continuity/checkpoint-envelope";
import { PreAdmissionSessionService } from "../../src/continuity/pre-admission-session-service";
import { LocalCheckpointStore } from "../../src/dev/local-checkpoint-store";
import { PostgresSqlFundingStore } from "../../src/persistence/postgres-sql-funding-store";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES } from "../../src/model/price-card";
import { createDevelopmentModelComposition } from "../../src/dev/dev-composition";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { MeteredGenerationService } from "../../src/phase-04/metered-generation-service";
import { LocalNappletWorker } from "../../src/dev/local-napplet-worker";
import { LocalArtifactVerifier } from "../../src/dev/local-artifact-verifier";
import { LocalArtifactRepository } from "../../src/dev/local-artifact-repository";
import { LocalGenerationArtifactVerifier, LocalProposalWorkerPort } from "../../src/dev/local-generation-adapters";
import { LocalDevelopmentRuntimeReadiness } from "../../src/dev/development-runtime-readiness";

const ownerId = "a".repeat(64);
const pins = Object.freeze({ policyVersion: "development-local-v1", profileId: "code-proposal", priceCardId: "phase-04-deterministic-card-2026-08-04", toolchainId: "development-test-toolchain", rootManifestSha256: "b".repeat(64) });

test("save restart fund resume original operation", async () => {
  const config = await Bun.file(`${import.meta.dir}/../../.local/napplet-cvm-dev-payments/payments.json`).json() as DevPayments;
  const admin = createDevelopmentPool(config.databaseUrl); const schema = `pending_${crypto.randomUUID().replaceAll("-", "")}`;
  const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => ReturnType<typeof createDevelopmentPool> };
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-csearch_path=${schema}`, max: 4 });
  const keyRoot = await mkdtemp(join(tmpdir(), "napplet-pre-admission-key-"));
  let calls = 0;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "development/005_pending_actions.sql"]) await pool.query(await Bun.file(`${import.meta.dir}/../../migrations/${file}`).text());
    const accountId = await accountIdForPrincipal({ pubkey: ownerId });
    const generation = { async startSessionAfterAdmission(input: any) { calls += 1; return { status: "completed", code: "ACTION_COMMITTED", accountId, sessionId: "session:original", sessionVersion: 1, artifactVersion: 1, artifactId: "artifact:original", confirmedSpend: "11", remainingCap: "3989", remainingBalance: "3989", nextAction: "revise_session", operationId: `operation:${input.idempotencyKey}` } as const; } };
    const create = (currentPins = pins) => new PreAdmissionSessionService({ store: new PostgresSqlFundingStore(pool, { deadlineMs: 5_000 }), envelope: new PendingActionEnvelopeService(new LocalCheckpointStore({ root: keyRoot })), generation, pricing: { card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] }, pins: currentPins });
    const command = { idempotencyKey: "one-original-command", maximum: "4000", idea: "A bounded private idea that never appears in SQL", policyVersion: pins.policyVersion } as const;
    const saved = await create().saveStart({ owner: { ownerId, accountId }, command });
    expect(saved.status).toBe("saved"); if (saved.status !== "saved") throw new Error("PENDING_ACTION_NOT_SAVED");
    expect(saved.shortfall).toBe("4000");
    const before = await pool.query("SELECT (SELECT count(*)::int FROM development_pending_actions) pending,(SELECT count(*)::int FROM capacity_intents) capacity,(SELECT count(*)::int FROM session_cap_holds) holds,(SELECT count(*)::int FROM metered_sessions) sessions,(SELECT count(*)::int FROM metered_actions) actions,(SELECT count(*)::int FROM provider_operations) providers,(SELECT count(*)::int FROM continuation_pauses) pauses,(SELECT count(*)::int FROM continuation_checkpoints) checkpoints");
    expect(before.rows[0]).toEqual({ pending: 1, capacity: 0, holds: 0, sessions: 0, actions: 0, providers: 0, pauses: 0, checkpoints: 0 });
    const serialized = await pool.query("SELECT envelope_json::text AS envelope FROM development_pending_actions");
    expect(serialized.rows[0]?.envelope).not.toContain(command.idea);
    expect(await create().saveStart({ owner: { ownerId, accountId }, command })).toMatchObject({ status: "saved", checkpointId: saved.checkpointId });
    await pool.query("INSERT INTO account_balance_projection(account_id,unit,settled_available,held) VALUES ($1,'sat',4000,3999)", [accountId]);
    await pool.query("INSERT INTO admissions(admission_id,account_id,reference,capacity_reference,state) VALUES ('admission:one',$1,'admission:one','capacity:one','accepted')", [accountId]);
    await pool.query("INSERT INTO session_cap_holds(hold_id,account_id,reference,requested_cap,held_amount,state) VALUES ('hold:one',$1,'admission:one',3999,3999,'active')", [accountId]);
    await expect(create().saveStart({ owner: { ownerId, accountId }, command: { ...command, idea: "conflicting after funding" } })).rejects.toThrow("PENDING_ACTION_REPLAY_CONFLICT");
    const resumeCommand = { kind: "pending_action" as const, checkpointId: saved.checkpointId, expectedCheckpointVersion: 1 as const, expectedSessionVersion: 0 as const, idempotencyKey: "resume-one", approvePendingAction: true as const, admissionReference: "admission:one", pendingAction: { reference: saved.reference, fingerprint: saved.fingerprint, kind: "start_session" as const, maximum: "4000" } };
    await expect(create({ ...pins, toolchainId: "changed-toolchain" }).resume({ owner: { ownerId, accountId }, command: resumeCommand })).rejects.toThrow("PENDING_ACTION_RESTORE_DENIED");
    expect((await pool.query("SELECT state FROM development_pending_actions")).rows[0]).toEqual({ state: "saved" });
    const tampered = JSON.parse(serialized.rows[0]!.envelope); tampered.ciphertextBase64 = "AA==";
    await pool.query("UPDATE development_pending_actions SET envelope_json=$2 WHERE checkpoint_id=$1", [saved.checkpointId, JSON.stringify(tampered)]);
    await expect(create().resume({ owner: { ownerId, accountId }, command: resumeCommand })).rejects.toThrow("PENDING_ACTION_RESTORE_DENIED");
    expect((await pool.query("SELECT state FROM development_pending_actions")).rows[0]).toEqual({ state: "saved" });
    await pool.query("UPDATE development_pending_actions SET envelope_json=$2 WHERE checkpoint_id=$1", [saved.checkpointId, serialized.rows[0]!.envelope]);
    await expect(create().resume({ owner: { ownerId, accountId }, command: resumeCommand })).rejects.toThrow("PENDING_ACTION_ADMISSION_INSUFFICIENT");
    expect((await pool.query("SELECT state FROM development_pending_actions")).rows[0]).toEqual({ state: "saved" });
    await pool.query("UPDATE session_cap_holds SET requested_cap=4000,held_amount=4000 WHERE hold_id='hold:one'");
    const result = await create().resume({ owner: { ownerId, accountId }, command: resumeCommand });
    expect(result).toMatchObject({ status: "completed", operationId: "operation:one-original-command" });
    expect(calls).toBe(1);
    const replay = await create().resume({ owner: { ownerId, accountId }, command: resumeCommand });
    expect(replay).toEqual(result); expect(calls).toBe(1);
    expect((await pool.query("SELECT state,operation_id FROM development_pending_actions")).rows[0]).toEqual({ state: "completed", operation_id: "operation:one-original-command" });
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); await rm(keyRoot, { recursive: true, force: true }); }
}, 30_000);

test("pre-admission resume drives the original command through the real worker once", async () => {
  const stack = developmentStack(true);
  let composition: Awaited<ReturnType<typeof createDevelopmentModelComposition>> | undefined;
  const keyRoot = await mkdtemp(join(tmpdir(), "napplet-pre-admission-real-worker-"));
  const owner = crypto.getRandomValues(new Uint8Array(32)); const ownerId = Buffer.from(owner).toString("hex"); const accountId = await accountIdForPrincipal({ pubkey: ownerId });
  const admissionReference = `admission:real:${crypto.randomUUID()}`;
  try {
    composition = await createDevelopmentModelComposition(await stack.up());
    const readiness = await new LocalDevelopmentRuntimeReadiness().assertReady();
    const owners = new Map([[accountId, ownerId]]);
    const worker = new LocalProposalWorkerPort(new LocalNappletWorker({ image: readiness.imageDigest }));
    const repository = new LocalArtifactRepository({ objectRoot: join(keyRoot, "artifacts"), pool: composition.funding.pool });
    const artifactVerifier = new LocalGenerationArtifactVerifier({ worker, verifier: new LocalArtifactVerifier(), repository, ownerIdForAccount: (id) => owners.get(id) });
    const fundedAdmission = new FundedAdmissionService({ funding: composition.funding.funding, store: composition.funding.database.funding, capacity: {} as never, receiptAuthority: {} as never });
    const generation = new MeteredGenerationService({ fundedAdmission, store: composition.funding.database.meteredFunding, gateway: composition.gateway, worker, artifactVerifier, proposalStore: composition.proposals, ...(composition.pricing ? { pricing: composition.pricing } : {}) });
    const pricing = composition.pricing ?? { card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] };
    const service = new PreAdmissionSessionService({ store: composition.funding.database.meteredFunding, envelope: new PendingActionEnvelopeService(new LocalCheckpointStore({ root: keyRoot })), generation, pricing, pins });
    const command = { idempotencyKey: `real-worker-${crypto.randomUUID()}`, maximum: "4000", idea: "A focused counter for this verified pending action", policyVersion: pins.policyVersion };
    const saved = await service.saveStart({ owner: { ownerId, accountId }, command });
    expect(saved.status).toBe("saved"); if (saved.status !== "saved") throw new Error("PENDING_ACTION_NOT_SAVED");
    // The direct SQL credit below bypasses the ordinary settlement ledger, so
    // seed its balancing account in this isolated test database.
    await composition.funding.pool.query("INSERT INTO funding_accounts(account_id,unit) VALUES ('treasury:clearing','sat') ON CONFLICT DO NOTHING");
    await composition.funding.pool.query("INSERT INTO account_balance_projection(account_id,unit,settled_available,held) VALUES ($1,'sat',4000,4000)", [accountId]);
    await composition.funding.pool.query("INSERT INTO admissions(admission_id,account_id,reference,capacity_reference,state) VALUES ($1,$2,$3,'capacity:real','accepted')", [`admission:${accountId}`, accountId, admissionReference]);
    await composition.funding.pool.query("INSERT INTO session_cap_holds(hold_id,account_id,reference,requested_cap,held_amount,state) VALUES ($1,$2,$3,4000,4000,'active')", [`hold:${accountId}`, accountId, admissionReference]);
    const resume = { kind: "pending_action" as const, checkpointId: saved.checkpointId, expectedCheckpointVersion: 1 as const, expectedSessionVersion: 0 as const, idempotencyKey: `resume-${crypto.randomUUID()}`, approvePendingAction: true as const, admissionReference, pendingAction: { reference: saved.reference, fingerprint: saved.fingerprint, kind: "start_session" as const, maximum: command.maximum } };
    const result = await service.resume({ owner: { ownerId, accountId }, command: resume });
    expect(result).toMatchObject({ status: "completed", artifactId: expect.any(String) });
    const replay = await service.resume({ owner: { ownerId, accountId }, command: resume });
    expect(replay).toEqual(result);
    const effects = await composition.funding.pool.query("SELECT (SELECT count(*)::int FROM metered_actions WHERE account_id=$1) actions,(SELECT count(*)::int FROM provider_operations p JOIN metered_actions a ON a.id=p.action_id WHERE a.account_id=$1) providers,(SELECT count(*)::int FROM development_artifacts WHERE account_id=$1) artifacts", [accountId]);
    expect(effects.rows[0]).toEqual({ actions: 1, providers: 1, artifacts: 1 });
  } finally {
    try { await composition?.close(); }
    finally { await stack.down(true); await rm(keyRoot, { recursive: true, force: true }); }
  }
}, 180_000);
