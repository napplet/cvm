// Local signed-WSS protocol fixture, never live funding/certification evidence.
import assert from "node:assert/strict";
import type { ServerWebSocket } from "bun";
import { Pool } from "pg";
import { z } from "zod";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { NostrClientTransport } from "@contextvm/sdk/transport";
import { EncryptionMode } from "@contextvm/sdk/core";
import { matchFilters, type Filter } from "nostr-tools/filter";
import { verifyEvent } from "nostr-tools/pure";
import { openContextVmRelayTransport } from "../../../src/release/deployment/contextvm-client";
import { PostgresOperationJournal } from "../../../src/release/deployment/postgres-operation-journal";
import { PostgresFundingDatabase } from "../../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../../src/persistence/postgres-sql-funding-store";
import { FundingService } from "../../../src/funding/funding-service";
import { SessionCapApprovalService } from "../../../src/funding/session-cap";
import { ContextVmFundingAdapter } from "../../../src/contextvm/adapter";
import { buildContextVmAnnouncement } from "../../../src/contextvm/announcement";

const [database, cert, key, sessionId, admissionReference, previous] = process.argv.slice(2);
if (!database || !cert || !key || !sessionId || !admissionReference || !previous) throw new Error("FIXTURE_ARGUMENTS_REQUIRED");
const Signed = z.object({ id: z.string(), pubkey: z.string(), kind: z.number().int(), created_at: z.number().int(), tags: z.array(z.array(z.string())), content: z.string(), sig: z.string() }).strict();
const FilterSchema: z.ZodType<Filter> = z.object({ ids: z.array(z.string()).optional(), authors: z.array(z.string()).optional(), kinds: z.array(z.number().int()).optional(), since: z.number().optional(), until: z.number().optional(), limit: z.number().optional(), "#p": z.array(z.string()).optional(), "#e": z.array(z.string()).optional(), "#d": z.array(z.string()).optional() }).strict();
type RelayData = { subscriptions: Map<string, Filter[]> };
const events: z.infer<typeof Signed>[] = [], sockets = new Set<ServerWebSocket<RelayData>>();
const relay = Bun.serve<RelayData>({
  hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) },
  fetch(request, server) { return server.upgrade(request, { data: { subscriptions: new Map() } }) ? undefined : new Response("Not found", { status: 404 }); },
  websocket: {
    open(socket) { sockets.add(socket); }, close(socket) { sockets.delete(socket); },
    message(socket, bytes) {
      const frame = z.array(z.unknown()).parse(JSON.parse(String(bytes)));
      if (frame[0] === "EVENT") {
        const event = Signed.parse(frame[1]); assert(verifyEvent(event)); events.push(event);
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
        for (const peer of sockets) for (const [id, filters] of peer.data.subscriptions) if (matchFilters(filters, event)) peer.send(JSON.stringify(["EVENT", id, event]));
      } else if (frame[0] === "REQ") {
        const id = z.string().parse(frame[1]), filters = z.array(FilterSchema).parse(frame.slice(2));
        socket.data.subscriptions.set(id, filters);
        for (const event of events) if (matchFilters(filters, event)) socket.send(JSON.stringify(["EVENT", id, event]));
        socket.send(JSON.stringify(["EOSE", id]));
      } else if (frame[0] === "CLOSE") socket.data.subscriptions.delete(z.string().parse(frame[1]));
    },
  },
});
const native = new Pool({ connectionString: database });
const pool: PostgresSqlPool = { async connect() { const client = await native.connect(); return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) { return { rows: (await client.query<Row>(sql, values ? [...values] : undefined)).rows }; }, release() { client.release(); } }; } };
const ledger = new PostgresFundingDatabase(pool, { realm: "production-real" });
const signer = new PrivateKeySigner();
let service: Awaited<ReturnType<typeof openContextVmRelayTransport>> | undefined;
const clients: NostrClientTransport[] = [];
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
try {
  const relays = [`wss://127.0.0.1:${relay.port}`];
  service = await openContextVmRelayTransport({ serviceKeyReference: "nostr:cap-test-service", relaySetSha256: "1".repeat(64), relays, signerBroker: { async resolveContextVmSigner() { return signer; } }, journal: new PostgresOperationJournal(pool, { namespace: "session-cap-wire", scopeSha256: "2".repeat(64) }) });
  const announcement = buildContextVmAnnouncement({ topUpCap: { minimum: "1", maximum: "1000", unit: "sat" }, pmis: ["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"], paymentInteraction: ["transparent", "explicit_gating"], tools: ["account_status", "top_up", "funded_admission", "approve_session_cap", "start_session", "revise_session", "resume_session", "session_status", "preview", "publication"].map(name => ({ name, available: name === "approve_session_cap", planned: name !== "approve_session_cap" })) });
  service.transport.configureAnnouncement(announcement);
  new ContextVmFundingAdapter({ service: new FundingService(ledger.funding), transport: service.transport, sessionCaps: new SessionCapApprovalService(ledger.funding) });
  await service.start();
  const serverPubkey = await signer.getPublicKey();
  const connect = async (fixtureKey: string) => {
    // Fixture client keys stay in client signers. The server receives only
    // verified public identities and signed event references from the SDK.
    const client = new NostrClientTransport({ signer: new PrivateKeySigner(fixtureKey), relayHandler: relays, serverPubkey, encryptionMode: EncryptionMode.REQUIRED, logLevel: "warn" });
    client.onmessage = message => {
      const parsed = z.object({ id: z.string() }).passthrough().safeParse(message);
      if (!parsed.success) return;
      const wait = pending.get(parsed.data.id); if (!wait) return;
      pending.delete(parsed.data.id); clearTimeout(wait.timer); wait.resolve(message);
    };
    clients.push(client); await client.start(); return client;
  };
  const owner = await connect("11".repeat(32)), foreign = await connect("33".repeat(32));
  const call = (client: NostrClientTransport, id: string, arguments_: unknown, method = "tools/call") => new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("SIGNED_CAP_RESPONSE_TIMEOUT")); }, 8000);
    pending.set(id, { resolve, reject, timer });
    void client.send({ jsonrpc: "2.0", id, method, params: method === "tools/list" ? {} : { name: "approve_session_cap", arguments: arguments_ } }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
  const discovery = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) });
  assert(discovery.parse(await call(owner, "owner:discovery", {}, "tools/list")).result.tools.some(tool => tool.name === "approve_session_cap"));
  service.transport.configureAnnouncement(buildContextVmAnnouncement({ topUpCap: { minimum: "1", maximum: "1000", unit: "sat" }, pmis: ["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"], paymentInteraction: ["transparent", "explicit_gating"], tools: announcement.metadata.tools.filter(tool => tool.name !== "approve_session_cap").map(({ name, available, planned }) => ({ name, available, planned })) }));
  assert(!discovery.parse(await call(owner, "owner:legacy-discovery", {}, "tools/list")).result.tools.some(tool => tool.name === "approve_session_cap"));
  service.transport.configureAnnouncement(announcement);
  const args = { sessionId, admissionReference, idempotencyKey: "cap:wss", expectedApprovedCap: previous, maximum: String(BigInt(previous) + 1n), unit: "sat" };
  const response = z.object({ result: z.object({ status: z.literal("approved"), approvedCap: z.string(), approvalReference: z.string() }).passthrough() });
  const first = response.parse(await call(owner, "owner:first", args));
  assert.equal(first.result.approvedCap, args.maximum);
  assert(!("accountId" in first.result));
  const replay = response.parse(await call(owner, "owner:replay", args));
  assert.deepEqual(replay.result, first.result);
  const denied = z.object({ error: z.object({ code: z.literal(-32602) }).passthrough() }).passthrough();
  denied.parse(await call(owner, "owner:forged-argument", { ...args, principal: { pubkey: "f".repeat(64) } }));
  const refused = z.object({ result: z.object({ status: z.literal("denied"), code: z.string() }).strict() });
  assert.equal(refused.parse(await call(foreign, "foreign:attempt", { ...args, expectedApprovedCap: args.maximum, maximum: String(BigInt(args.maximum) + 1n), idempotencyKey: "cap:foreign" })).result.code, "SESSION_CAP_NOT_FOUND_OR_DENIED");
  assert.equal(refused.parse(await call(owner, "owner:stale", { ...args, idempotencyKey: "cap:stale" })).result.code, "SESSION_CAP_STALE_APPROVAL");
  assert.equal(refused.parse(await call(owner, "owner:conflict", { ...args, maximum: String(BigInt(args.maximum) + 1n) })).result.code, "SESSION_CAP_IDEMPOTENCY_CONFLICT");
  process.stdout.write(`${JSON.stringify({ passed: true, signedCapCalls: 2, deniedCalls: 4 })}\n`);
} finally {
  for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error("FIXTURE_CLOSED")); }
  pending.clear();
  await Promise.all(clients.map(client => client.close()));
  await service?.close(); for (const socket of sockets) socket.close(); relay.stop(true); await native.end();
}
