// Disposable local transport fixture. Its responses are not release evidence.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { matchFilters } from "nostr-tools/filter";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { openContextVmRelayTransport, openContextVmCertificationClient, assertContextVmCertificationClient } from "../../../src/release/deployment/contextvm-client";
import { PostgresOperationJournal } from "../../../src/release/deployment/postgres-operation-journal";
import { createAuthorizationRequest, createAuthorizationReceipt } from "../../../src/release/authorization";
import { ProductionCertificationCoreServices } from "../../../src/production/certification-services";
import { createProductionReadyCapacity } from "../../../src/production/worker-capacity";
import { ProductionUnusedAdmissionRelease } from "../../../src/production/unused-admission";
import { PostgresFundingDatabase } from "../../../src/persistence/postgres-funding-database";
import { FundingService } from "../../../src/funding/funding-service";
import { FundedAdmissionService } from "../../../src/funding/funded-admission";
import { HmacAdmissionReceiptAuthority } from "../../../src/funding/admission-receipt";
import { ContextVmFundingAdapter } from "../../../src/contextvm/adapter";
import { accountIdForPrincipal } from "../../../src/domain/account-command";

const [database, cert, key] = process.argv.slice(2);
if (!database || !cert || !key) throw new Error("FIXTURE_ARGUMENTS_REQUIRED");
const { Pool } = createRequire(import.meta.url)("pg");
const pool = new Pool({ connectionString: database, connectionTimeoutMillis: 2000 });
const events: Event[] = [];
const sockets = new Set<any>();
const relay = Bun.serve<{ subscriptions: Map<string, any[]> }>({
  hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) },
  fetch(request, server) { return server.upgrade(request, { data: { subscriptions: new Map() } }) ? undefined : new Response("Not found", { status: 404 }); },
  websocket: {
    open(socket) { sockets.add(socket); }, close(socket) { sockets.delete(socket); },
    message(socket, bytes) {
      const wire = JSON.parse(String(bytes));
      if (wire[0] === "EVENT") {
        const event = wire[1] as Event; assert(verifyEvent(event)); events.push(event);
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
        for (const peer of sockets) for (const [id, filters] of peer.data.subscriptions) if (matchFilters(filters, event)) peer.send(JSON.stringify(["EVENT", id, event]));
      } else if (wire[0] === "REQ") {
        socket.data.subscriptions.set(wire[1], wire.slice(2));
        for (const event of events) if (matchFilters(wire.slice(2), event)) socket.send(JSON.stringify(["EVENT", wire[1], event]));
        socket.send(JSON.stringify(["EOSE", wire[1]]));
      } else if (wire[0] === "CLOSE") socket.data.subscriptions.delete(wire[1]);
    },
  },
});
const candidate = "a".repeat(64), topology = "b".repeat(64);
const journal = (namespace: string) => new PostgresOperationJournal(pool, { namespace, scopeSha256: topology });
const serviceSigner = new PrivateKeySigner(), clientSigner = new PrivateKeySigner("1".repeat(64));
const relays = [`wss://127.0.0.1:${relay.port}`];
let service: Awaited<ReturnType<typeof openContextVmRelayTransport>> | undefined;
let client: Awaited<ReturnType<typeof openContextVmCertificationClient>> | undefined;
try {
  const request = await createAuthorizationRequest({ candidateSha256: candidate, topologySha256: topology, effectPlanSha256: "c".repeat(64), controllerStateSha256: "d".repeat(64), providerCapabilitiesSha256: "e".repeat(64), orderedEffects: [{ id: "signed-admission", provider: "contextvm", operation: "verify_integration", estimatedCostMicros: 1 }], providerScopes: [{ provider: "contextvm", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) }], estimate: { currency: "USD", maximumMicros: 1, sourceId: "local-fixture", observedAtMs: 1, freshUntilMs: 10000 }, maximumRunDurationMs: 1000, cleanupByMs: 8000, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: 9000 });
  const receipt = await createAuthorizationReceipt(request);
  service = await openContextVmRelayTransport({ serviceKeyReference: "nostr:service-fixture", relaySetSha256: "1".repeat(64), relays, signerBroker: { async resolveContextVmSigner() { return serviceSigner; } }, journal: journal("contextvm-service-test") });
  assert.throws(() => assertContextVmCertificationClient(service!.transport), /CONTEXTVM_CERTIFICATION_CLIENT_REQUIRED/);
  const calls: Array<{ name: string; arguments: { idempotencyKey: string; requestedCap: string; unit: string } }> = [];
  service.transport.onInbound(async envelope => {
    const params = envelope.request.params as typeof calls[number];
    calls.push(params); assert.equal(params.name, "funded_admission");
    assert.equal(params.arguments.requestedCap, "1"); assert.equal(params.arguments.unit, "sat");
    if (params.arguments.idempotencyKey === "lost-response") return;
    await service!.transport.sendResponse(envelope.verifiedClientPubkey, { jsonrpc: "2.0", id: envelope.request.id, result: { status: "accepted", admissionReference: `admission:${params.arguments.idempotencyKey}`, unit: "sat" } }, envelope.requestEventId);
  });
  await service.start();
  let now = 1000;
  // Public key is resolved before crossing the strict constructor boundary.
  const serverPubkey = await serviceSigner.getPublicKey();
  const openClient = () => openContextVmCertificationClient({ certificationKeyReference: "nostr:certification-fixture", serverPubkey, relays, signerBroker: { async resolveContextVmCertificationSigner() { return clientSigner; } }, journal: journal("contextvm-client-test"), candidateSha256: candidate, topologySha256: topology, authorizationRequest: request, authorizationReceipt: receipt, now: () => now, timeoutMs: 1000 });
  client = await openClient(); assertContextVmCertificationClient(client);
  const value = { operationId: "original-admission", candidateId: candidate, requestedCap: "1" };
  assert.deepEqual(await client.admit(value), { operationId: value.operationId, state: "responded", admissionReference: "admission:original-admission", outcome: "accepted" });
  assert.equal((await client.admit(value)).state, "responded"); assert.equal(calls.length, 1);
  await assert.rejects(client.admit({ ...value, requestedCap: "2" }), /OPERATION_IDENTITY_CONFLICT/);
  await assert.rejects(client.admit({ ...value, candidateId: "f".repeat(64) }), /CANDIDATE_MISMATCH/);
  const concurrent = await Promise.all([client.admit({ ...value, operationId: "concurrent-admission" }), client.admit({ ...value, operationId: "concurrent-admission" })]);
  assert(concurrent.some(result => result.state === "responded")); assert.equal(calls.length, 2);
  assert.equal((await client.admit({ ...value, operationId: "lost-response" })).state, "unknown"); assert.equal(calls.length, 3);
  await client.close(); client = await openClient();
  assert.equal((await client.admit({ ...value, operationId: "lost-response" })).state, "unknown"); assert.equal(calls.length, 3);
  now = 10000; await assert.rejects(client.admit(value)); assert.equal(calls.length, 3);
  await client.close(); client = undefined; await service.close(); service = undefined; now = 1000;
  // Worker responses below are explicit transport-contract fixtures, never
  // Modal/Fly evidence. The signed adapter, holds, journal and cleanup are real.
  const workers = new Map<string, { provider: string; terminated: boolean }>();
  let creates = 0, terminations = 0;
  const provider = (name: string) => ({
    async create(input: { operationId: string }) { assert(!workers.has(input.operationId)); creates++; workers.set(input.operationId, { provider: name, terminated: false }); return { status: "created", operationId: input.operationId, resourceId: input.operationId }; },
    async observe(input: { operationId: string }) { const found = workers.get(input.operationId); assert(found && found.provider === name && !found.terminated); return { status: "completed", resourceId: input.operationId, readiness: { readyMonotonicMs: Math.floor(performance.now()), readinessProbeDigest: `sha256:${"9".repeat(64)}` } }; },
    async terminate(input: { operationId: string }) { const found = workers.get(input.operationId); assert(found && found.provider === name); if (!found.terminated) terminations++; found.terminated = true; return { status: "terminated" }; },
  });
  const workerClients = { modal: provider("modal"), fly: provider("fly") };
  const capacityJournal = journal("cohort-capacity-test");
  const makeCapacity = (name: "modal" | "fly") => createProductionReadyCapacity({ provider: name, workers: workerClients as never, journal: capacityJournal, image: `registry/worker@sha256:${candidate}`, toolchainSha256: "2".repeat(64), flyRegion: "ams" });
  const capacities = { modal: makeCapacity("modal"), fly: makeCapacity("fly") };
  const observer = new ProductionCertificationCoreServices({ candidates: { modal: candidate, fly: candidate }, certificationOwnerPubkey: await clientSigner.getPublicKey(), requestedCap: "1", capacities, selectedProvider: "modal", journal: journal("cohort-observer-test"), pool });
  service = await openContextVmRelayTransport({ serviceKeyReference: "nostr:service-fixture", relaySetSha256: "1".repeat(64), relays, signerBroker: { async resolveContextVmSigner() { return serviceSigner; } }, journal: journal("cohort-server-test"), admissionObserver: observer });
  const ledger = new PostgresFundingDatabase(pool, { realm: "production-real" });
  const funding = new FundingService(ledger.funding);
  const authority = new HmacAdmissionReceiptAuthority({ secret: new Uint8Array(32).fill(7) });
  new ContextVmFundingAdapter({ service: funding, transport: service.transport, admissions: new FundedAdmissionService({ funding, store: ledger.funding, capacity: observer.capacityRouter(), receiptAuthority: authority }), admissionReceipts: authority });
  await service.start(); client = await openClient();
  const owner = await clientSigner.getPublicKey(); const accountId = await accountIdForPrincipal({ pubkey: owner });
  for (const [worker, sample] of [["modal", { id: "benchmark-1", cohort: "pool_hit" }], ["fly", { id: "benchmark-202", cohort: "pool_miss" }]] as const) {
    const input = { operationId: `control-${worker}`, candidateId: candidate, provider: worker, sample };
    const before = creates; const prepared = await observer.prepareCohort(input);
    assert.equal(creates, before + (sample.cohort === "pool_hit" ? 1 : 0));
    const operationId = `admission-${worker}-${sample.id}`;
    const admission = await client.admit({ operationId, candidateId: candidate, ...prepared });
    assert.equal(admission.outcome, "accepted"); assert.equal(creates, before + 1);
    const observed = await observer.observeCohort(input) as { sample: { readyMonotonicMs: number; receiptMonotonicMs: number; cleanup: string; readyLeaseCount: number; durableBacklogCount: number } };
    assert(observed.sample.readyMonotonicMs >= observed.sample.receiptMonotonicMs);
    assert.equal(observed.sample.cleanup, "passed"); assert.equal(observed.sample.readyLeaseCount, 1); assert.equal(observed.sample.durableBacklogCount, 0);
    assert.deepEqual(await observer.observeCohort(input), observed);
    const status = await funding.status({ pubkey: owner }); assert.equal(status.held, "0"); assert.equal(status.available, "10");
    await assert.rejects(ledger.funding.transact(accountId, tx => tx.reserveActionBudget({ accountId, admissionReference: admission.admissionReference!, idempotencyKey: `late-${worker}`, fingerprint: candidate, reference: `budget:${worker}`, amount: 1n })), /ACTIVE_ADMISSION_REQUIRED/);
  }
  assert.equal(creates, 2); assert.equal(terminations, 2);
  const concurrentInput = { operationId: "release-concurrency", candidateId: candidate, provider: "modal" as const, sample: { id: "benchmark-203", cohort: "cold" } };
  await observer.prepareCohort(concurrentInput);
  const concurrentOperation = "admission-modal-benchmark-203";
  const concurrentAdmission = await client.admit({ operationId: concurrentOperation, candidateId: candidate, requestedCap: "1" });
  assert.equal(concurrentAdmission.outcome, "accepted");
  const cohort = (await journal("cohort-observer-test").read<{ intentReference: string }>(`cohort-operation:${concurrentOperation}`))!.value;
  const releaseInput = { accountId, admissionReference: concurrentAdmission.admissionReference!, intentReference: cohort.intentReference };
  const releases = await Promise.all(Array.from({ length: 3 }, () => new ProductionUnusedAdmissionRelease(pool).release(releaseInput)));
  assert(releases.every(result => result.amount === "1" && result.state === "released"));
  await assert.rejects(new ProductionUnusedAdmissionRelease(pool).release({ ...releaseInput, accountId: `account:${"f".repeat(64)}` }), /UNUSED_ADMISSION_REQUIRED/);
  await observer.observeCohort(concurrentInput); assert.equal(terminations, 3);
  const usedInput = { operationId: "used-admission", candidateId: candidate, provider: "modal" as const, sample: { id: "benchmark-205", cohort: "pool_miss" } };
  await observer.prepareCohort(usedInput);
  const used = await client.admit({ operationId: "admission-modal-benchmark-205", candidateId: candidate, requestedCap: "1" });
  assert.equal(used.outcome, "accepted");
  await ledger.funding.transact(accountId, tx => tx.reserveActionBudget({ accountId, admissionReference: used.admissionReference!, idempotencyKey: "used-budget", fingerprint: candidate, reference: "budget:used", amount: 1n }));
  await assert.rejects(observer.observeCohort(usedInput), /ADMISSION_ALREADY_USED/);
  assert.equal((await funding.status({ pubkey: owner })).held, "1"); assert.equal(terminations, 3);
  await assert.rejects(observer.prepareCohort({ operationId: "unsupported", candidateId: candidate, provider: "modal", sample: { id: "benchmark-201", cohort: "contention" } }), /FAULT_PREPARATION_REQUIRED/);
  const db = await pool.connect();
  try {
    const releaseRows = (await db.query("SELECT count(*)::int AS count FROM production_real.billing_line_items WHERE kind='release' AND account_id=$1", [accountId])).rows;
    assert.equal(releaseRows[0].count, 3);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM production_real.provider_operations WHERE account_id=$1", [accountId])).rows[0].count, 0);
  } finally { db.release(); }
  console.log(JSON.stringify({ passed: true, signedAdmissionCalls: calls.length, signedGenerationCalls: calls.filter(call => call.name === "start_session").length, lostResponseRedispatches: 0 }));
} finally { await client?.close(); await service?.close(); relay.stop(true); await pool.end(); }
