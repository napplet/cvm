import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { ProductionAdmissionCapacityRecovery } from "../../src/production/admission-capacity-recovery";
import { ProductionWorkerJobRouter } from "../../src/production/worker-job-router";
import { createProductionReadyCapacity } from "../../src/production/worker-capacity";
import { createWorkerDeploymentClients, createFlyMachinesHttpTransport, PRODUCTION_WORKER_POLICY } from "../../src/release/deployment/worker-clients";
import { createPostgresWorkerOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import type { ModalSandboxPort, ModalSdkPort } from "../../src/worker-adapters/modal-worker";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "./admission-ready";

const digest = (value: string) => value.repeat(64);
const currentImage = `registry.example/current@sha256:${digest("a")}`, retainedImage = `registry.example/retained@sha256:${digest("c")}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Native = { alive: boolean; mode: "exact" | "unknown" | "wrong"; lookups: number; sandbox: ModalSandboxPort; onMissing?: () => Promise<void> };

/** Actual native transport and SQL mechanisms, with local provider/rail fixtures. */
export async function proveAdmissionCapacityRecovery(pool: PostgresSqlPool) {
  const workerJournal = new PostgresOperationJournal(pool, { namespace: "admission-recovery-workers", scopeSha256: digest("a") });
  const jobs = new PostgresOperationJournal(pool, { namespace: "admission-recovery-jobs", scopeSha256: digest("a") });
  const capacityJournal = new PostgresOperationJournal(pool, { namespace: "admission-recovery-capacity", scopeSha256: digest("a") });
  const providerJournal = createPostgresWorkerOperationJournal(workerJournal), natives = new Map<string, Native>();
  let creates = 0, commands = 0, terminations = 0;
  let beforeLookup: (() => Promise<void>) | undefined;
  const sdk: ModalSdkPort = { apps: { fromName: async () => ({}) }, images: { fromRegistry: () => ({}) }, sandboxes: {
    async create(_app, _image, options) {
      creates++;
      if (!options.name) throw new Error("FIXTURE_NATIVE_NAME_REQUIRED");
      const tags = { ...options.tags };
      const native: Native = { alive: true, mode: "exact", lookups: 0, sandbox: {
        id: `recovery-native-${creates}`,
        async getTags() { return native.mode === "wrong" ? { ...tags, "napplet-cvm-lease-sha256": digest("f") } : tags; },
        async exec() { commands++; throw new Error("RECOVERY_CANNOT_EXECUTE_WORKER"); },
        async poll() { return {}; }, async terminate() { terminations++; throw new Error("RECOVERY_CANNOT_TERMINATE"); },
        filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] },
      } };
      natives.set(options.name, native); throw new Error("FIXTURE_CREATE_RESPONSE_LOST");
    },
    async findByName(_app, name) {
      const native = natives.get(name);
      if (!native) return { kind: "missing" };
      native.lookups++;
      await beforeLookup?.();
      if (!native.alive) { await native.onMissing?.(); return { kind: "missing" }; }
      return native.mode === "unknown" ? { kind: "unknown" } : { kind: "found", sandbox: native.sandbox };
    },
  } };
  const clients = (image: string) => createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: PRODUCTION_WORKER_POLICY.version,
    modalAppName: "recovery-workers", modalTags: {}, modalSdk: sdk, journal: providerJournal,
    fly: createFlyMachinesHttpTransport({ appName: "recovery-workers", journal: providerJournal, getAccessToken: async () => { throw new Error("WRONG_PROVIDER_AUTHORITY"); },
      fetch: async () => { throw new Error("WRONG_PROVIDER_AUTHORITY"); } }) });
  const current = clients(currentImage), retained = clients(retainedImage);
  const executables = [
    { image: currentImage, toolchainSha256: digest("b"), modalAppName: "recovery-workers", flyAppName: "recovery-workers", clients: current },
    { image: retainedImage, toolchainSha256: digest("d"), modalAppName: "recovery-workers", flyAppName: "recovery-workers", clients: retained },
  ];
  const router = (keep = true) => new ProductionWorkerJobRouter({ workerJournal, jobJournal: jobs, executables: keep ? executables : executables.slice(0, 1) });
  const capacity = createProductionReadyCapacity({ provider: "modal", workers: retained, journal: capacityJournal, workerJournal,
    image: retainedImage, toolchainSha256: digest("d") });
  const currentCapacity = createProductionReadyCapacity({ provider: "modal", workers: current, journal: capacityJournal, workerJournal,
    image: currentImage, toolchainSha256: digest("b") });
  const history = (name = "admission-recovery-progress", source = pool) => new PostgresOperationJournal(source, { namespace: name, scopeSha256: digest("a") });
  const recovery = (keep = true, journal = history(), source = pool, now?: () => number) => new ProductionAdmissionCapacityRecovery({ pool: source, capacity: currentCapacity,
    router: router(keep), workerJournal, journal, now });
  const database = new PostgresFundingDatabase(pool, { realm: "production-real" }), funding = new FundingService(database.funding);
  const principal = { pubkey: "ab".repeat(32) };
  await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "recovery-seed", policyVersion: "p1", protocolVersion: "v1",
    payload: { settlement: { topUpId: "recovery-topup", rail: "lightning", unit: "sat", amount: "1000", externalReference: "recovery-external",
      settlementReference: "recovery-settlement", verifiedAt: new Date().toISOString() } } });
  const accountId = (await funding.status(principal)).accountId;
  const createOriginal = async (key: string, bind = true) => {
    const command = { principal, idempotencyKey: key, policyVersion: "p1", protocolVersion: "v1", payload: { requestedCap: "80", unit: "sat" } };
    const admission = new FundedAdmissionService({ funding, store: database.funding, capacity, receiptAuthority: trustedAdmissionReceiptAuthority });
    const result = await admission.admit(command, await trustedAdmissionReceipt(command));
    if (result.status !== "reconciliation_pending") throw new Error("EXPECTED_UNACCEPTED_ORIGINAL");
    const record = await capacity.inspect({ intentReference: result.intentReference });
    if (!record) throw new Error("EXPECTED_DURABLE_CAPACITY");
    await expect(router().resolve({ provider: "modal", workerOperationId: record.workerOperationId })).rejects.toThrow("ORIGINAL_EXECUTABLE_REQUIRED");
    if (bind) expect(await router().observeTermination({ provider: "modal", workerOperationId: record.workerOperationId })).toEqual({ status: "pending" });
    const native = natives.get(`napplet-cvm-${record.workerOperationId}`);
    if (!native) throw new Error("EXPECTED_NATIVE_ORIGINAL");
    return { command, record, native };
  };
  const originals = [];
  for (let index = 0; index < 40; index++) originals.push(await createOriginal(`recovery:${index}`));
  originals.sort((a, b) => a.record.intentReference.localeCompare(b.record.intentReference));
  for (const original of originals) original.native.mode = "unknown";
  const target = originals.at(-1)!;
  target.native.alive = false;
  await recovery().assertReady();
  const beforeUnapproved = originals.reduce((total, original) => total + original.native.lookups, 0);
  expect((await recovery(false, history("admission-recovery-unapproved")).scan()).finalized).toBe(0);
  expect(originals.reduce((total, original) => total + original.native.lookups, 0)).toBe(beforeUnapproved);
  const first = recovery();
  const page = first.scan(); expect(first.scan()).toBe(page);
  expect(await page).toEqual({ examined: 32, finalized: 0, pending: 32 });
  expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(target.command.idempotencyKey)))?.state).not.toBe("released");
  await first.close();
  expect((await recovery().scan()).finalized).toBe(1);
  expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(target.command.idempotencyKey)))?.state).toBe("released");
  const proofRows = async () => {
    const client = await pool.connect();
    try { return (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM production_real.funding_outbox WHERE event_kind='admission_capacity_observed_terminated'")).rows[0]?.count; }
    finally { client.release(); }
  };
  expect(await proofRows()).toBe(1);
  const accepted = await createOriginal("recovery:already-accepted");
  await database.funding.transact(accountId, tx => tx.recordCapacityObservation({ intentReference: accepted.record.intentReference, state: "available",
    capacityReference: accepted.record.reference, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const accept = (original: typeof accepted) => funding.execute({ ...original.command, kind: "funded_admission", payload: { requestedCap: "80", unit: "sat", capacity: { reference: original.record.reference, usable: true } } });
  await accept(accepted); accepted.native.alive = false;
  const acceptedLookups = accepted.native.lookups;
  for (let attempt = 0; attempt < 3; attempt++) await recovery().scan();
  expect(accepted.native.lookups).toBe(acceptedLookups);
  expect((await funding.status(principal)).held).toBe("80");
  const late = await createOriginal("recovery:late-acceptance");
  await database.funding.transact(accountId, tx => tx.recordCapacityObservation({ intentReference: late.record.intentReference, state: "available",
    capacityReference: late.record.reference, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  late.native.alive = false;
  late.native.onMissing = async () => { await accept(late); };
  for (let attempt = 0; attempt < 3; attempt++) await recovery().scan();
  expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(late.command.idempotencyKey)))?.state).toBe("available");
  expect((await funding.status(principal)).held).toBe("160");
  expect(await proofRows()).toBe(1);
  const missingKey = "recovery:missing-native", missingIntent = `capacity-intent:${sha(`${accountId}:${missingKey}`)}`;
  await database.funding.transact(accountId, tx => tx.createCapacityIntent({ accountId, idempotencyKey: missingKey, fingerprint: digest("e"), intentReference: missingIntent }));
  const continuationKey = "allocation:nonordinary", continuationIntent = `capacity-intent:${sha(JSON.stringify({ checkpointId: "checkpoint:owned", allocation: continuationKey }))}`;
  await database.funding.transact(accountId, tx => tx.createCapacityIntent({ accountId, idempotencyKey: continuationKey, fingerprint: digest("f"), intentReference: continuationIntent }));
  for (let attempt = 0; attempt < 3; attempt++) await recovery().scan();
  expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(missingKey)))?.state).toBe("created");
  expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(continuationKey)))?.state).toBe("created");
  expect({ creates, commands, terminations }).toEqual({ creates: 42, commands: 0, terminations: 0 });
  let expectedProofs = 1;
  const wrong = await createOriginal("recovery:wrong-native-tags");
  wrong.native.mode = "wrong";
  const beforeWrong = wrong.native.lookups;
  for (let attempt = 0; attempt < 3; attempt++) await recovery().scan();
  expect(wrong.native.lookups).toBeGreaterThan(beforeWrong);
  expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(wrong.command.idempotencyKey)))?.state).toBe("reconciliation_pending");
  wrong.native.mode = "exact"; wrong.native.alive = false;
  for (let attempt = 0; attempt < 3; attempt++) await recovery().scan();
  expect(await proofRows()).toBe(++expectedProofs);
  const unbound = await createOriginal("recovery:lost-before-native-id", false);
  unbound.native.alive = false;
  for (let attempt = 0; attempt < 3; attempt++) await recovery().scan();
  expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(unbound.command.idempotencyKey)))?.state).toBe("reconciliation_pending");
  expect((await providerJournal.read(unbound.record.workerOperationId))?.resourceId).toBeUndefined();
  expect(await proofRows()).toBe(expectedProofs);
  for (const fault of ["proof-ack", "finalization-ack"] as const) {
    const original = await createOriginal(`recovery:${fault}`); original.native.alive = false;
    let lost = false;
    const faultPool: PostgresSqlPool = { async connect() {
      const client = await pool.connect(); let targetWrite = false;
      return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        if ((fault === "proof-ack" && sql.startsWith("INSERT INTO production_real.release_operation_journal") && typeof values?.[2] === "string" && values[2].startsWith("admission-capacity-termination:v1:"))
          || (fault === "finalization-ack" && sql.startsWith("INSERT INTO production_real.funding_outbox"))) targetWrite = true;
        const result = await client.query<Row>(sql, values);
        if (sql === "COMMIT" && targetWrite && !lost) { lost = true; throw new Error("FIXTURE_CAPACITY_RECOVERY_COMMIT_ACK_LOST"); }
        return result;
      }, release() { client.release(); } };
    } };
    const journal = history(`admission-recovery-${fault}`, faultPool);
    const before = original.native.lookups;
    for (let attempt = 0; attempt < 4; attempt++) await recovery(true, journal, faultPool).scan();
    expect(lost).toBe(true);
    expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(original.command.idempotencyKey)))?.state).toBe("released");
    expect(original.native.lookups).toBe(before + 1);
    expect(await proofRows()).toBe(++expectedProofs);
  }
  const concurrent = await createOriginal("recovery:concurrent-observers"); concurrent.native.alive = false;
  const concurrentHistory = history("admission-recovery-concurrent");
  for (let attempt = 0; attempt < 4; attempt++) await Promise.all([recovery(true, concurrentHistory).scan(), recovery(true, concurrentHistory).scan()]);
  expect((await database.funding.transact(accountId, tx => tx.findCapacityIntent(concurrent.command.idempotencyKey)))?.state).toBe("released");
  expect(await proofRows()).toBe(++expectedProofs);
  let logicalNow = Date.now(), budgetLookups = 0;
  beforeLookup = async () => { budgetLookups++; logicalNow += 30_001; };
  const bounded = await recovery(true, history("admission-recovery-budget"), pool, () => logicalNow).scan();
  expect(budgetLookups).toBe(1); expect(bounded.examined).toBeLessThan(32);
  beforeLookup = undefined;
  let enterLookup = () => {}, releaseLookup = () => {};
  const lookupEntered = new Promise<void>(resolve => { enterLookup = resolve; }), lookupGate = new Promise<void>(resolve => { releaseLookup = resolve; });
  beforeLookup = async () => { enterLookup(); await lookupGate; };
  const closing = recovery(true, history("admission-recovery-close")), scanning = closing.scan();
  await lookupEntered;
  const closed = closing.close();
  releaseLookup();
  await closed;
  expect((await scanning).examined).toBeLessThan(32);
  beforeLookup = undefined;
  expect(await closing.scan()).toEqual({ examined: 0, finalized: 0, pending: 0 });
  expect((await funding.status(principal)).held).toBe("160");
  expect((await funding.status(principal)).available).toBe("840");
  expect({ creates, commands, terminations }).toEqual({ creates: 47, commands: 0, terminations: 0 });
  const stopped = recovery(); await stopped.close();
  expect(await stopped.scan()).toEqual({ examined: 0, finalized: 0, pending: 0 });
}
