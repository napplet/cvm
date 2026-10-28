import { expect, test } from "bun:test";
import { Pool } from "pg";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { matchFilters } from "nostr-tools/filter";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";

import { openProductionNip46Signer } from "../../src/production/nip46-signer";
import { createProductionNostrRelayPort } from "../../src/production/nostr-relay";
import { createAuthorizationReceipt, createAuthorizationRequest } from "../../src/release/authorization";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createNostrRelayPublicationAdapter } from "../../src/release/native/nostr-relay";

const digest = (letter: string) => letter.repeat(64);
const hash = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

function localRelay(options: Readonly<{ dropAcknowledgement?: boolean; emitEose?: boolean; onPublish?: (event: Event) => Event | undefined }> = {}) {
  const events: Event[] = [];
  const publishes: string[] = [];
  const queries: Array<Readonly<{ connection: number; ids: readonly string[] }>> = [];
  let connections = 0;
  const server = Bun.serve<{ connection: number }>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request, { data: { connection: ++connections } }) ? undefined : new Response("Not found", { status: 404 }); },
    websocket: {
      message(socket, message) {
        const wire = JSON.parse(String(message));
        const type = wire[0];
        if (type === "EVENT") {
          const event = wire[1] as Event;
          publishes.push(event.id); events.push(event);
          const response = options.onPublish?.(event);
          if (response) events.push(response);
          if (options.dropAcknowledgement) { socket.close(1011, "ack lost"); return; }
          socket.send(JSON.stringify(["OK", event.id, true, "accepted"]));
          return;
        }
        if (type === "REQ") {
          const subscription = wire[1] as string;
          const filters = wire.slice(2);
          const ids = filters.flatMap((filter: { ids?: string[] }) => filter.ids ?? []);
          queries.push(Object.freeze({ connection: socket.data.connection, ids: Object.freeze(ids) }));
          for (const event of events.filter(event => matchFilters(filters, event))) socket.send(JSON.stringify(["EVENT", subscription, event]));
          if (options.emitEose !== false) socket.send(JSON.stringify(["EOSE", subscription]));
        }
      },
    },
  });
  return Object.freeze({ events, publishes, queries, connections: () => connections, url: `ws://127.0.0.1:${server.port}`, close: () => server.stop(true) });
}

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
integration("real local relay persists exact signed bytes, recovers a lost acknowledgement by original ID on a fresh client, and never redispatches", async () => {
  const name = `napplet-cvm-relay-${crypto.randomUUID().replaceAll("-", "")}`;
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`DOCKER_${args[0]}:${error.slice(0, 300)}`);
      return output.trim();
    } finally { clearTimeout(timer); }
  };
  let admin: Pool | undefined, application: Pool | undefined;
  const relays: Array<ReturnType<typeof localRelay>> = [];
  try {
    await docker("run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine");
    const port = (await docker("port", name, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await admin.query("SELECT 1"); break; }
      catch (error) { if (attempt === 59) throw error; await Bun.sleep(250); }
    }
    for (const migration of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql", "phase-03/004_production_rail_material_scope.sql", "phase-07/001_production_operation_journal.sql"]) await admin.query(await Bun.file(`migrations/${migration}`).text());
    await admin.query("CREATE ROLE relay_test LOGIN");
    await admin.query("GRANT napplet_production_real TO relay_test");
    application = new Pool({ connectionString: `postgresql://relay_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2_000 });
    const sqlPool: PostgresSqlPool = { async connect() {
      if (!application) throw new Error("APPLICATION_POOL_UNAVAILABLE");
      const client = await application.connect();
      return { async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]) { return client.query<Row>(sql, values ? [...values] : undefined); }, release() { client.release(); } };
    } };
    const journal = () => new PostgresOperationJournal(sqlPool, { namespace: "relay:production", scopeSha256: digest("a") });
    const event = finalizeEvent({ kind: 1, content: "exact signed relay candidate", tags: [], created_at: 1_700_000_000 }, generateSecretKey());
    const eventBytes = new TextEncoder().encode(JSON.stringify(event));
    const operation = "owner_manifest:original";
    const persistedInput = (operationId = operation, bytes = eventBytes, eventId = event.id) => ({ operationId, eventId, eventBytes: bytes, eventBytesSha256: hash(bytes), candidateSha256: digest("b"), sealedArtifactSha256: digest("c"), aggregateSha256: digest("d"), relaySetReference: "candidate-relays", relaySetSha256: digest("e"), authorizationRequestSha256: digest("f"), authorizationReceiptSha256: digest("0") });

    const acknowledged = localRelay(); relays.push(acknowledged);
    const acknowledgedPort = createProductionNostrRelayPort({ relays: [acknowledged.url], journal: journal(), timeoutMs: 250 });
    await acknowledgedPort.persistSignedEvent(persistedInput());
    await acknowledgedPort.publishSignedEvent({ operationId: operation, eventId: event.id, eventBytes, relays: [acknowledged.url] });
    expect(acknowledged.publishes).toEqual([event.id]);
    expect(await acknowledgedPort.observeOriginalEvent({ operationId: operation, eventId: event.id, relaySetReference: "candidate-relays" })).toMatchObject({ status: "complete", eventId: event.id });

    const lostAck = localRelay({ dropAcknowledgement: true }); relays.push(lostAck);
    const lostOperation = "owner_manifest:lost-ack";
    const lostPort = createProductionNostrRelayPort({ relays: [lostAck.url], journal: journal(), timeoutMs: 250 });
    await lostPort.persistSignedEvent(persistedInput(lostOperation));
    await lostPort.publishSignedEvent({ operationId: lostOperation, eventId: event.id, eventBytes, relays: [lostAck.url] });
    expect(lostAck.publishes).toEqual([event.id]);
    expect(lostAck.queries).toHaveLength(1);
    expect(lostAck.queries[0]?.ids).toEqual([event.id]);
    expect(lostAck.connections()).toBeGreaterThanOrEqual(2);
    await lostPort.publishSignedEvent({ operationId: lostOperation, eventId: event.id, eventBytes, relays: [lostAck.url] });
    expect(lostAck.publishes).toEqual([event.id]);
    await expect(lostPort.observeOriginalEvent({ operationId: lostOperation, eventId: event.id, relaySetReference: "substituted-relays" })).rejects.toThrow("NOSTR_RELAY_REFERENCE_MISMATCH");

    const nativeEvent = finalizeEvent({ kind: 35129, content: "native replay fixture", tags: [["d", "native"]], created_at: 1_700_000_010 }, generateSecretKey());
    const candidateSha256 = digest("3"), topologySha256 = digest("4"), effectPlanSha256 = digest("5"), ownerAccountScopeSha256 = digest("6"), ownerProjectScopeSha256 = digest("7");
    const request = await createAuthorizationRequest({
      candidateSha256, topologySha256, effectPlanSha256, controllerStateSha256: digest("8"), providerCapabilitiesSha256: digest("9"),
      orderedEffects: [{ id: "owner-relay", provider: "owner_relay", operation: "verify_integration", estimatedCostMicros: 1 }, { id: "external-signer", provider: "signer", operation: "verify_integration", estimatedCostMicros: 1 }],
      providerScopes: [{ provider: "owner_relay", accountScopeSha256: ownerAccountScopeSha256, projectScopeSha256: ownerProjectScopeSha256 }, { provider: "signer", accountScopeSha256: ownerAccountScopeSha256, projectScopeSha256: ownerProjectScopeSha256 }],
      estimate: { currency: "USD", maximumMicros: 2, sourceId: "local-relay", observedAtMs: 1, freshUntilMs: 10_000 }, maximumRunDurationMs: 1_000, cleanupByMs: 8_000, evidenceRetentionDays: 30, artifactRetentionDays: 30,
      gcpEffects: { projectBootstrap: false, billing: false, apiEnablement: ["storage.googleapis.com"] }, expiresAtMs: 9_000,
    });
    const nativeRelay = createNostrRelayPublicationAdapter({
      config: { candidateSha256, topologySha256, effectPlanSha256, ownerAccountScopeSha256, ownerProjectScopeSha256, attestationAccountScopeSha256: digest("a"), attestationProjectScopeSha256: digest("b"), intentId: "native", sealedArtifactSha256: digest("c"), aggregateSha256: digest("d"), relaySetReference: "candidate-relays", relaySetSha256: digest("e"), relays: [lostAck.url], ownerEvent: nativeEvent, attestationEvent: nativeEvent, ownerSignerPubkey: nativeEvent.pubkey, attestationSignerPubkey: nativeEvent.pubkey },
      request, receipt: await createAuthorizationReceipt(request), now: () => 1_000, port: lostPort,
    });
    const nativeOperation = "owner_manifest:native";
    await expect(nativeRelay.publishOwnerManifest({ operationId: nativeOperation, event: nativeEvent, relays: [lostAck.url] })).resolves.toMatchObject({ state: "completed", operationId: nativeOperation });
    expect(lostAck.publishes).toEqual([event.id, nativeEvent.id]);
    await expect(nativeRelay.publishOwnerManifest({ operationId: nativeOperation, event: nativeEvent, relays: [lostAck.url] })).resolves.toMatchObject({ state: "completed", operationId: nativeOperation });
    expect(lostAck.publishes).toEqual([event.id, nativeEvent.id]);

    const tampered = new TextEncoder().encode(JSON.stringify({ ...event, content: "signature no longer verifies" }));
    await expect(acknowledgedPort.persistSignedEvent(persistedInput("owner_manifest:bad-signature", tampered))).rejects.toThrow("NOSTR_RELAY_EVENT_INVALID");
    await expect(acknowledgedPort.publishSignedEvent({ operationId: operation, eventId: digest("9"), eventBytes, relays: [acknowledged.url] })).rejects.toThrow("NOSTR_RELAY_EVENT_INVALID");

    const noEose = localRelay({ emitEose: false }); relays.push(noEose);
    const timeoutOperation = "owner_manifest:no-eose";
    const boundedPort = createProductionNostrRelayPort({ relays: [noEose.url], journal: journal(), timeoutMs: 100 });
    await boundedPort.persistSignedEvent(persistedInput(timeoutOperation));
    const began = performance.now();
    await expect(boundedPort.observeOriginalEvent({ operationId: timeoutOperation, eventId: event.id, relaySetReference: "candidate-relays" })).resolves.toMatchObject({ status: "unknown" });
    expect(performance.now() - began).toBeLessThan(600);

    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);
    const bunkerKey = generateSecretKey();
    const bunkerPubkey = getPublicKey(bunkerKey);
    const sessionKey = generateSecretKey();
    let withholdSigning = false;
    const nipRelay = localRelay({
      // Store the owner response then deliberately lose the request's OK. The
      // production client must query this retained response, not sign/send a
      // second NIP-46 request with a random replacement ID.
      dropAcknowledgement: true,
      onPublish(request) {
        const conversation = nip44.v2.utils.getConversationKey(bunkerKey, request.pubkey);
        const decoded = JSON.parse(nip44.v2.decrypt(request.content, conversation));
        if (decoded.method === "sign_event" && withholdSigning) return undefined;
        const result = decoded.method === "connect" ? "ack" : decoded.method === "get_public_key" ? ownerPubkey : decoded.method === "sign_event"
          ? JSON.stringify(finalizeEvent(JSON.parse(decoded.params[0]), ownerKey)) : undefined;
        if (!result) throw new Error("UNEXPECTED_NIP46_METHOD");
        return finalizeEvent({ kind: 24133, content: nip44.v2.encrypt(JSON.stringify({ id: decoded.id, result }), conversation), tags: [["p", request.pubkey]], created_at: 1_700_000_002 }, bunkerKey);
      },
    }); relays.push(nipRelay);
    let nipOperation = "owner_manifest:nip46-lost-response", signerNow = 1_000;
    const signerReceipt = await createAuthorizationReceipt(request);
    const authorization = { request, receipt: signerReceipt, authorizationRequestSha256: request.authorizationRequestSha256, authorizationReceiptSha256: signerReceipt.authorizationReceiptSha256 };
    const openSigner = () => openProductionNip46Signer({
      authorization, now: () => signerNow,
      bunkerUri: `bunker://${bunkerPubkey}?relay=${encodeURIComponent(nipRelay.url)}&secret=fixture-secret`,
      sessionKeyReference: "nostr:disposable-client", sessionKeyBroker: { async resolve() { return sessionKey; } }, journal: new PostgresOperationJournal(sqlPool, { namespace: "nip46:production", scopeSha256: digest("1") }), timeoutMs: 1_000,
      context: { async resolve() { return { operationId: nipOperation, ownerPubkey, capabilities: ["sign_event"], expiresAtMs: 5_000, template: { kind: 35129 as const, content: "owner signed manifest", tags: [["d", "candidate"]], created_at: 1_700_000_001 } }; } },
      originalOperationContext: { async resolveOriginal({ operationId, purpose }) { expect({ operationId, purpose }).toEqual({ operationId: "upload:nip46", purpose: "upload_authorization" }); return { intentDigest: digest("f"), ownerPubkey, capabilities: ["sign_event"], expiresAtMs: 7_000, template: { kind: 24242 as const, content: "Upload blobs via napplet" as const, tags: [["t", "upload"], ["x", digest("a")], ["expiration", "1700003600"], ["client", "napplet"], ["server", "uploads.example"]], created_at: 1_700_000_000 } }; } },
    });
    const nipSigner = await openSigner();
    expect(await nipSigner.discover()).toEqual({ pubkey: ownerPubkey, capabilities: ["sign_event"], consentState: "granted" });
    const signed = await nipSigner.signExactIntent({ intentDigest: digest("2") });
    expect(signed).toMatchObject({ pubkey: ownerPubkey, intentDigest: digest("2") });
    expect(nipRelay.publishes).toHaveLength(3);
    await nipSigner.signExactIntent({ intentDigest: digest("2") });
    expect(nipRelay.publishes).toHaveLength(3);
    const upload = await nipSigner.signExactOperation({ operationId: "upload:nip46", purpose: "upload_authorization" });
    expect(upload).toMatchObject({ pubkey: ownerPubkey, event: { kind: 24242, content: "Upload blobs via napplet" } });
    expect(nipRelay.publishes).toHaveLength(4);
    const nipRecord = (await application.query("SELECT value_json FROM production_real.release_operation_journal WHERE namespace='nip46:production' AND operation_id=$1", [`nip46:${nipOperation}`])).rows[0]?.value_json;
    expect(nipRecord.requestEvent.content).not.toContain("owner signed manifest");
    signerNow = 6_000;
    nipOperation = "owner_manifest:expired-intent";
    await expect(nipSigner.signExactIntent({ intentDigest: digest("3") })).rejects.toThrow("NIP46_AUTHORIZATION_REQUIRED");
    expect(nipRelay.publishes).toHaveLength(4);
    nipOperation = "owner_manifest:nip46-lost-response";
    await expect(nipSigner.signExactIntent({ intentDigest: digest("2") })).resolves.toMatchObject({ pubkey: ownerPubkey });
    await nipSigner.close();
    signerNow = 10_000;
    const recovered = await openSigner();
    await expect(recovered.signExactIntent({ intentDigest: digest("2") })).resolves.toEqual(signed);
    await expect(recovered.signExactOperation({ operationId: "upload:nip46", purpose: "upload_authorization" })).resolves.toEqual(upload);
    expect(nipRelay.publishes).toHaveLength(4);
    nipOperation = "owner_manifest:expired-approval";
    await expect(recovered.signExactIntent({ intentDigest: digest("4") })).rejects.toThrow();
    expect(nipRelay.publishes).toHaveLength(4);
    await recovered.close();
    // A new disposable client cannot initiate discovery after approval expiry.
    const fresh = await openProductionNip46Signer({
      authorization, now: () => signerNow,
      bunkerUri: `bunker://${bunkerPubkey}?relay=${encodeURIComponent(nipRelay.url)}&secret=fixture-secret`,
      sessionKeyReference: "nostr:other-client", sessionKeyBroker: { async resolve() { return generateSecretKey(); } },
      journal: new PostgresOperationJournal(sqlPool, { namespace: "nip46:production", scopeSha256: digest("1") }),
      context: { async resolve() { throw new Error("not used"); } }, timeoutMs: 1_000,
    });
    expect(await fresh.discover()).toMatchObject({ consentState: "pending" });
    expect(nipRelay.publishes).toHaveLength(4);
    await fresh.close();
    signerNow = 2_000;
    nipOperation = "owner_manifest:unknown-response";
    withholdSigning = true;
    const uncertain = await openSigner();
    await expect(uncertain.signExactIntent({ intentDigest: digest("5") })).rejects.toThrow("NIP46_SIGNING_OUTCOME_UNKNOWN");
    expect(nipRelay.publishes).toHaveLength(5);
    withholdSigning = false;
    await expect(uncertain.signExactIntent({ intentDigest: digest("5") })).rejects.toThrow("NIP46_SIGNING_OUTCOME_UNKNOWN");
    expect(nipRelay.publishes).toHaveLength(5);
    await uncertain.close();
    signerNow = 10_000;
    const unknownRecovery = await openSigner();
    await expect(unknownRecovery.signExactIntent({ intentDigest: digest("5") })).rejects.toThrow("NIP46_SIGNING_OUTCOME_UNKNOWN");
    expect(nipRelay.publishes).toHaveLength(5);
    await unknownRecovery.close();
  } finally {
    for (const relay of relays) relay.close();
    await application?.end(); await admin?.end(); await docker("rm", "--force", name).catch(() => undefined);
  }
}, 120_000);
