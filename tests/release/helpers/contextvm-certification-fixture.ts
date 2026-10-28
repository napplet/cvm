// Disposable local transport fixture. Its responses are not release evidence.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { NostrClientTransport } from "@contextvm/sdk/transport";
import { EncryptionMode } from "@contextvm/sdk/core";
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
import { ProductionRelayChaosCertification } from "../../../src/production/chaos-relay";
import { D122_FAULT_MATRIX } from "../../../src/resilience/fault-harness";
import { ProductionCoreControlClient } from "../../../src/release/deployment/production-core-control";
import { ProductionCertificationControl } from "../../../src/production/certification-control";
import { createProductionCoreSuiteAdapters } from "../../../src/release/deployment/production-core-suite-adapters";

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
  const request = await createAuthorizationRequest({ candidateSha256: candidate, topologySha256: topology, effectPlanSha256: "c".repeat(64), controllerStateSha256: "d".repeat(64), providerCapabilitiesSha256: "e".repeat(64), orderedEffects: [{ id: "signed-admission", provider: "contextvm", operation: "verify_integration", estimatedCostMicros: 1 }, { id: "private-control", provider: "cloud_run", operation: "verify_integration", estimatedCostMicros: 1 }], providerScopes: [{ provider: "contextvm", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) }, { provider: "cloud_run", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) }], estimate: { currency: "USD", maximumMicros: 2, sourceId: "local-fixture", observedAtMs: 1, freshUntilMs: 10000 }, maximumRunDurationMs: 1000, cleanupByMs: 8000, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: 9000 });
  const receipt = await createAuthorizationReceipt(request);
  const certificationClientPubkey = await clientSigner.getPublicKey();
  service = await openContextVmRelayTransport({ serviceKeyReference: "nostr:service-fixture", relaySetSha256: "1".repeat(64), relays, signerBroker: { async resolveContextVmSigner() { return serviceSigner; } }, journal: journal("contextvm-service-test"), certificationClientPubkey });
  assert.throws(() => assertContextVmCertificationClient(service!.transport), /CONTEXTVM_CERTIFICATION_CLIENT_REQUIRED/);
  const calls: Array<{ name: string; arguments: { idempotencyKey: string; requestedCap: string; unit: string } }> = [];
  service.transport.onInbound(async envelope => {
    if (envelope.request.method === "ping") {
      await service!.transport.sendResponse(envelope.verifiedClientPubkey, { jsonrpc: "2.0", id: envelope.request.id, result: {} }, envelope.requestEventId);
      return;
    }
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
  const attacker = new NostrClientTransport({ signer: new PrivateKeySigner("3".repeat(64)), relayHandler: relays, serverPubkey, encryptionMode: EncryptionMode.REQUIRED, logLevel: "warn" });
  const blocked = new Map<string, (value: unknown) => void>();
  attacker.onmessage = message => {
    if (!message || typeof message !== "object" || !("id" in message)) return;
    const id = (message as { id?: unknown }).id;
    if (typeof id !== "string") return;
    const resolve = blocked.get(id); if (resolve) { blocked.delete(id); resolve(message); }
  };
  await attacker.start();
  const serviceJournalBefore = Number((await pool.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace='contextvm-service-test' AND scope_sha256=$1", [topology])).rows[0].count);
  const blockedCall = (id: string, name: string, arguments_: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { blocked.delete(id); reject(new Error("ATTACKER_RELAY_RESPONSE_TIMEOUT")); }, 5_000);
    blocked.set(id, value => { clearTimeout(timer); resolve(value); });
    void attacker.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } } as never).catch(reject);
  });
  const [fundedDenied, topUpDenied] = await Promise.all([
    blockedCall("attacker-funded-admission", "funded_admission", { idempotencyKey: "attacker-admission", requestedCap: "1", unit: "sat" }),
    blockedCall("attacker-top-up", "top_up", { idempotencyKey: "attacker-top-up", amount: "1", unit: "sat" }),
  ]);
  for (const response of [fundedDenied, topUpDenied]) assert.equal((response as { error?: { code?: unknown } }).error?.code, -32003);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM production_real.release_operation_journal WHERE namespace='contextvm-service-test' AND scope_sha256=$1", [topology])).rows[0].count), serviceJournalBefore);
  await attacker.close();
  const openClient = () => openContextVmCertificationClient({ certificationKeyReference: "nostr:certification-fixture", serverPubkey, relays, signerBroker: { async resolveContextVmCertificationSigner() { return clientSigner; } }, journal: journal("contextvm-client-test"), candidateSha256: candidate, topologySha256: topology, authorizationRequest: request, authorizationReceipt: receipt, now: () => now, timeoutMs: 1000 });
  client = await openClient(); assertContextVmCertificationClient(client);
  const value = { operationId: "original-admission", candidateId: candidate, requestedCap: "1" };
  assert.deepEqual(await client.admit(value), { operationId: value.operationId, state: "responded", admissionReference: "admission:original-admission", outcome: "accepted" });
  assert.equal((await client.admit(value)).state, "responded"); assert.equal(calls.length, 1);
  await assert.rejects(client.admit({ ...value, requestedCap: "2" }), /OPERATION_IDENTITY_CONFLICT/);
  await assert.rejects(client.admit({ ...value, candidateId: "f".repeat(64) }), /CANDIDATE_MISMATCH/);
  const concurrent = await Promise.all([client.admit({ ...value, operationId: "concurrent-admission" }), client.admit({ ...value, operationId: "concurrent-admission" })]);
  assert(concurrent.some(result => result.state === "responded")); assert.equal(calls.length, 2);
  const duplicateRelay = await client.exerciseRelayDeliveryFault({ fault: "duplicate", first: { ...value, operationId: "duplicate-relay" } });
  assert.deepEqual(duplicateRelay.operationIds, ["duplicate-relay"]);
  assert.equal(duplicateRelay.eventIds.length, 1); assert.deepEqual(duplicateRelay.deliveryOrder, [duplicateRelay.eventIds[0], duplicateRelay.eventIds[0]]);
  assert.equal(calls.filter(call => call.arguments.idempotencyKey === "duplicate-relay").length, 1);
  const reorderedRelay = await client.exerciseRelayDeliveryFault({
    fault: "out_of_order",
    first: { ...value, operationId: "reorder-relay-first" },
    second: { candidateId: candidate, operationId: "reorder-relay-status" },
  });
  assert.deepEqual(reorderedRelay.operationIds, ["reorder-relay-first", "reorder-relay-status"]);
  assert.deepEqual(reorderedRelay.deliveryOrder, [reorderedRelay.eventIds[1], reorderedRelay.eventIds[0]]);
  assert.equal(calls.filter(call => call.arguments.idempotencyKey.startsWith("reorder-relay")).length, 1);
  assert.equal((await client.admit({ ...value, operationId: "lost-response" })).state, "unknown"); assert.equal(calls.length, 5);
  await client.close(); client = await openClient();
  assert.equal((await client.admit({ ...value, operationId: "lost-response" })).state, "unknown"); assert.equal(calls.length, 5);
  now = 10000; await assert.rejects(client.admit(value)); assert.equal(calls.length, 5);
  await client.close(); client = undefined; await service.close(); service = undefined; now = 1000;
  // Worker responses below are explicit transport-contract fixtures, never
  // Modal/Fly evidence. The signed adapter, holds, journal and cleanup are real.
  const workers = new Map<string, { provider: string; terminated: boolean }>();
  let creates = 0, terminations = 0, readinessQueries = 0, loseTerminationAck = false;
  const provider = (name: string) => ({
    async create(input: { operationId: string }) { assert(!workers.has(input.operationId)); creates++; workers.set(input.operationId, { provider: name, terminated: false }); return { status: "created", operationId: input.operationId, resourceId: input.operationId }; },
    async observe(input: { operationId: string }) { readinessQueries++; const found = workers.get(input.operationId); assert(found && found.provider === name && !found.terminated); return { status: "completed", resourceId: input.operationId, readiness: { readyMonotonicMs: Math.floor(performance.now()), readinessProbeDigest: `sha256:${"9".repeat(64)}` } }; },
    async terminate(input: { operationId: string }) { const found = workers.get(input.operationId); assert(found && found.provider === name); if (!found.terminated) terminations++; found.terminated = true; if (loseTerminationAck) { loseTerminationAck = false; throw new Error("TERMINATION_ACK_LOST"); } return { status: "terminated" }; },
    async observeTermination(input: { operationId: string }) { const found = workers.get(input.operationId); assert(found && found.provider === name); return { status: found.terminated ? "terminated" as const : "pending" as const }; },
  });
  const workerClients = { modal: provider("modal"), fly: provider("fly") };
  const capacityJournal = journal("cohort-capacity-test");
  const makeCapacity = (name: "modal" | "fly") => createProductionReadyCapacity({ provider: name, workers: workerClients as never, journal: capacityJournal, image: `registry/worker@sha256:${candidate}`, toolchainSha256: "2".repeat(64), flyRegion: "ams" });
  const capacities = { modal: makeCapacity("modal"), fly: makeCapacity("fly") };
  const observerInput = { candidates: { modal: candidate, fly: candidate }, certificationOwnerPubkey: await clientSigner.getPublicKey(), authorizationRequestSha256: request.authorizationRequestSha256, requestedCap: "1", capacities, selectedProvider: "modal" as const, journal: journal("cohort-observer-test"), pool };
  const observer = new ProductionCertificationCoreServices(observerInput);
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
  // A new authorization cannot turn a prior run's cached sample into fresh
  // evidence. Both preparation replay and query-only observation reject it.
  const foreignRun = new ProductionCertificationCoreServices({ ...observerInput, authorizationRequestSha256: "f".repeat(64) });
  const priorPayload = { candidateId: candidate, provider: "modal" as const, sample: { id: "benchmark-1", cohort: "pool_hit" } };
  await assert.rejects(foreignRun.prepareCohort({ operationId: "foreign-run", ...priorPayload }), /OPERATION_IDENTITY_CONFLICT/u);
  await assert.rejects(foreignRun.observeAdmissionOperation({ operationId: "admission-modal-benchmark-1" }), /AUTHORIZATION_BINDING_CHANGED/u);
  await assert.rejects(foreignRun.reconcile({ operationId: "foreign-run", kind: "cohort.observe", payload: priorPayload }), /AUTHORIZATION_BINDING_CHANGED/u);
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
  // An original observe command that lost its termination acknowledgement
  // must finish through reconciliation, without repeating the deletion.
  loseTerminationAck = true;
  await assert.rejects(observer.observeCohort(concurrentInput), /TERMINATION_ACK_LOST/u);
  const cleanupPayload = { candidateId: candidate, provider: concurrentInput.provider, sample: concurrentInput.sample };
  const recoveredCleanup = await observer.reconcile({ operationId: concurrentInput.operationId, kind: "cohort.observe", payload: cleanupPayload });
  assert.equal((recoveredCleanup as { sample: { cleanup: string } }).sample.cleanup, "passed");
  assert.equal(terminations, 3);
  const cleanupAuditCount = Number((await pool.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit")).rows[0].count);
  assert.deepEqual(await observer.reconcile({ operationId: concurrentInput.operationId, kind: "cohort.observe", payload: cleanupPayload }), recoveredCleanup);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit")).rows[0].count), cleanupAuditCount);
  assert.equal(creates, 3); assert.equal(terminations, 3);
  const usedInput = { operationId: "used-admission", candidateId: candidate, provider: "modal" as const, sample: { id: "benchmark-205", cohort: "pool_miss" } };
  await observer.prepareCohort(usedInput);
  const used = await client.admit({ operationId: "admission-modal-benchmark-205", candidateId: candidate, requestedCap: "1" });
  assert.equal(used.outcome, "accepted");
  await ledger.funding.transact(accountId, tx => tx.reserveActionBudget({ accountId, admissionReference: used.admissionReference!, idempotencyKey: "used-budget", fingerprint: candidate, reference: "budget:used", amount: 1n }));
  await assert.rejects(observer.observeCohort(usedInput), /ADMISSION_ALREADY_USED/);
  assert.equal((await funding.status({ pubkey: owner })).held, "1"); assert.equal(terminations, 3);
  await assert.rejects(observer.prepareCohort({ operationId: "unsupported", candidateId: candidate, provider: "modal", sample: { id: "benchmark-201", cohort: "contention" } }), /FAULT_PREPARATION_REQUIRED/);
  const faultRequest = await createAuthorizationRequest({ candidateSha256: candidate, topologySha256: topology, effectPlanSha256: "c".repeat(64), controllerStateSha256: "d".repeat(64), providerCapabilitiesSha256: "e".repeat(64), orderedEffects: [{ id: "signed-relay-fault", provider: "contextvm", operation: "verify_integration", estimatedCostMicros: 1 }, { id: "relay-fault-worker", provider: "modal", operation: "verify_integration", estimatedCostMicros: 1 }], providerScopes: ["contextvm", "modal"].map(provider => ({ provider: provider as "contextvm" | "modal", accountScopeSha256: "f".repeat(64), projectScopeSha256: "0".repeat(64) })), estimate: { currency: "USD", maximumMicros: 2, sourceId: "local-fixture", observedAtMs: 1, freshUntilMs: 10000 }, maximumRunDurationMs: 1000, cleanupByMs: 8000, evidenceRetentionDays: 30, artifactRetentionDays: 30, gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: 9000 });
  const faultReceipt = await createAuthorizationReceipt(faultRequest);
  await client.close();
  client = await openContextVmCertificationClient({ certificationKeyReference: "nostr:certification-fixture", serverPubkey, relays, signerBroker: { async resolveContextVmCertificationSigner() { return clientSigner; } }, journal: journal("contextvm-client-test"), candidateSha256: candidate, topologySha256: topology, authorizationRequest: faultRequest, authorizationReceipt: faultReceipt, now: () => now, timeoutMs: 1000 });
  const faultConfig = { realm: "production-real", candidateSha256: candidate, topologySha256: topology, worker: { selectedProvider: "modal" } } as const;
  const faultGeneration = { config: faultConfig, authorization: { request: faultRequest, receipt: faultReceipt, authorizationRequestSha256: faultRequest.authorizationRequestSha256 }, dependencies: { pool, journal: journal("contextvm-client-test") }, admissionObserver: observer };
  const openFault = () => new ProductionRelayChaosCertification({ config: faultConfig as never, generation: faultGeneration as never, contextvm: client!, core: observer, now: () => now });
  for (const schedule of D122_FAULT_MATRIX.filter(value => ["duplicate_relay", "out_of_order_relay"].includes(value.faultClass))) {
    const beforeCreates: number = creates, beforeTerminates: number = terminations;
    const command = { controlOperationId: `fault-${schedule.id}`, schedule };
    let dispatched;
    if (schedule.faultClass === "duplicate_relay") {
      loseTerminationAck = true;
      await assert.rejects(openFault().inject(command), /TERMINATION_ACK_LOST/u);
      now = 10000;
      dispatched = await openFault().reconcile(command);
      now = 1000;
    } else dispatched = await openFault().inject(command);
    assert.equal(dispatched.oracle.effects.worker, 1);
    const identity = { operationId: dispatched.operationId, sessionId: dispatched.sessionId };
    assert.equal((await openFault().observe(identity)).effects.worker, 1);
    assert.equal(creates, beforeCreates + 1); assert.equal(terminations, beforeTerminates + 1);
    const rowCount = Number((await pool.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit")).rows[0].count);
    now = 10000;
    assert.deepEqual(await openFault().reconcile(command), dispatched);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM production_real.release_operation_audit")).rows[0].count), rowCount);
    assert.equal(creates, beforeCreates + 1); assert.equal(terminations, beforeTerminates + 1);
    now = 1000;
  }
  assert.equal((await funding.status({ pubkey: owner })).held, "1");
  const ambiguityInput = { operationId: "ambiguity-cohort", candidateId: candidate, provider: "modal" as const, sample: { id: "benchmark-403", cohort: "ambiguity" } };
  const beforeAmbiguity = { creates, terminations, readinessQueries };
  await observer.prepareCohort(ambiguityInput);
  const ambiguousAdmission = await client.admit({ operationId: "admission-modal-benchmark-403", candidateId: candidate, requestedCap: "1" });
  assert.equal(ambiguousAdmission.outcome, "accepted");
  assert.equal(creates, beforeAmbiguity.creates + 1);
  assert.equal(readinessQueries, beforeAmbiguity.readinessQueries + 2);
  const ambiguousCohort = (await journal("cohort-observer-test").read<{ intentReference: string }>("cohort-operation:admission-modal-benchmark-403"))!.value;
  const ambiguityKey = `cohort-ambiguity:${new Bun.CryptoHasher("sha256").update(ambiguousCohort.intentReference).digest("hex")}`;
  const originalFault = await journal("cohort-observer-test").read<{ state: string; reference: string }>(ambiguityKey);
  assert.equal(originalFault!.revision, 2); assert.equal(originalFault!.value.state, "recovered");
  assert.equal(originalFault!.value.reference, ambiguousAdmission.admissionReference);
  const ambiguityObservation = await observer.observeCohort(ambiguityInput) as { sample: { cleanup: string; outcome: string; readyLeaseCount: number; durableBacklogCount: number } };
  assert.equal(ambiguityObservation.sample.cleanup, "passed"); assert.equal(ambiguityObservation.sample.outcome, "accepted");
  assert.equal(ambiguityObservation.sample.readyLeaseCount, 1); assert.equal(ambiguityObservation.sample.durableBacklogCount, 0);
  assert.equal(terminations, beforeAmbiguity.terminations + 1);
  assert.equal((await funding.status({ pubkey: owner })).held, "1");
  const unusedControl = async () => { throw new Error("UNEXPECTED_CONTROL"); };
  const backend = new ProductionCertificationControl({ candidateSha256: candidate, topologySha256: topology, authorizationRequestSha256: request.authorizationRequestSha256, authorizationRequest: request, authorizationReceipt: receipt, journal: journal("cohort-control-server"), now: () => now, services: {
    prepareCohort: value => observer.prepareCohort(value), observeCohort: value => observer.observeCohort(value), reconcile: value => observer.reconcile(value),
    emitTelemetry: unusedControl, telemetryWindow: unusedControl, injectFault: unusedControl, observeFault: unusedControl, restore: unusedControl,
  } });
  const controlCalls: string[] = [];
  const privateControl = new ProductionCoreControlClient({ serviceUrl: "https://local-fixture.run.app", candidateSha256: candidate, topologySha256: topology, request, receipt, journal: journal("cohort-control-client"), identity: { async token() { return "fixture-private-control-token"; } }, now: () => now, fetch: async (url, init) => {
    controlCalls.push(init!.method!);
    const observed = init!.method === "POST"
      ? await backend.execute(JSON.parse(String(init!.body)))
      : await backend.observe({ operationId: decodeURIComponent(new URL(String(url)).pathname.split("/").at(-1)!) });
    return Response.json(observed);
  } });
  const suites = createProductionCoreSuiteAdapters({ candidate: { id: candidate, provider: "modal", image: `registry.example/worker@sha256:${candidate}`, sourceSha256: candidate }, control: privateControl, contextvm: client });
  const beforeCleanup = { creates, terminations };
  const cleanupSample = await suites.admission.executeSample({ id: "benchmark-404", cohort: "cleanup" }) as { cleanup: string; outcome: string };
  assert.equal(cleanupSample.cleanup, "passed"); assert.equal(cleanupSample.outcome, "accepted");
  assert.deepEqual(controlCalls, ["POST", "POST", "GET"]);
  assert.equal(creates, beforeCleanup.creates + 1); assert.equal(terminations, beforeCleanup.terminations + 1);
  assert.deepEqual(await suites.admission.executeSample({ id: "benchmark-404", cohort: "cleanup" }), cleanupSample);
  assert.deepEqual(controlCalls, ["POST", "POST", "GET", "GET", "GET"]);
  assert.equal(creates, beforeCleanup.creates + 1); assert.equal(terminations, beforeCleanup.terminations + 1);
  const db = await pool.connect();
  try {
    const releaseRows = (await db.query("SELECT count(*)::int AS count FROM production_real.billing_line_items WHERE kind='release' AND account_id=$1", [accountId])).rows;
    assert.equal(releaseRows[0].count, 7);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM production_real.provider_operations WHERE account_id=$1", [accountId])).rows[0].count, 0);
  } finally { db.release(); }
  console.log(JSON.stringify({ passed: true, signedAdmissionCalls: calls.length, signedGenerationCalls: calls.filter(call => call.name === "start_session").length, lostResponseRedispatches: 0 }));
} finally { await client?.close(); await service?.close(); relay.stop(true); await pool.end(); }
