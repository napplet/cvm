import { SimplePool } from "nostr-tools/pool";
import { verifyEvent } from "nostr-tools/pure";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { NostrRelayPort } from "../release/native/nostr-relay";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { loadPinnedCliNetworkHelpers } from "./pinned-cli-network";

const Relay = z.string().url().refine(value => {
  const url = new URL(value);
  // Production relay configuration is wss-only. Plain WebSocket is retained
  // only for a loopback integration relay; accepting arbitrary ws:// would
  // turn a configuration typo into a clear-text publication path.
  return url.protocol === "wss:" || (url.protocol === "ws:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname));
}, "NOSTR_RELAY_URL_INVALID");
const Event = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/iu), pubkey: z.string().regex(/^[a-f0-9]{64}$/iu), created_at: z.number().int().nonnegative(), kind: z.number().int().nonnegative(), tags: z.array(z.array(z.string())), content: z.string(), sig: z.string().regex(/^[a-f0-9]{128}$/iu) }).strict();
const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const PersistedEvent = z.object({
  state: z.enum(["persisted", "dispatching"]), eventId: Digest, eventBytesSha256: Digest, eventBytesBase64: z.string().min(1),
  candidateSha256: Digest, sealedArtifactSha256: Digest, aggregateSha256: Digest, relaySetReference: z.string().min(1).max(256),
  relaySetSha256: Digest, authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest,
}).strict();

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const sameRelaySet = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every(value => right.includes(value));
const samePersistedIdentity = (left: z.infer<typeof PersistedEvent>, right: z.infer<typeof PersistedEvent>) => {
  const { state: _leftState, ...leftIdentity } = left;
  const { state: _rightState, ...rightIdentity } = right;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
};

/** Official relay I/O. No relay callback may be injected by a request: relay
 * membership is fixed at construction and every ambiguous publish readbacks
 * precisely the original signed event ID. */
export function createProductionNostrRelayPort(input: Readonly<{ relays: readonly string[]; journal: PostgresOperationJournal; timeoutMs?: number }>): NostrRelayPort {
  const relays = z.array(Relay).min(1).max(16).parse(input.relays); if (new Set(relays).size !== relays.length) throw new Error("NOSTR_RELAY_SET_INVALID");
  assertPostgresOperationJournal(input.journal); const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000) throw new Error("NOSTR_RELAY_TIMEOUT_INVALID");
  const read = async (eventId: string) => {
    // Reconciliation gets a fresh connection: the connection which lost an OK
    // acknowledgement is not trusted to answer its own recovery query.
    const pool = new SimplePool(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([
        pool.querySync(relays, { ids: [eventId], limit: 1 }, { maxWait: timeoutMs }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("NOSTR_RELAY_QUERY_TIMEOUT")), timeoutMs); }),
      ]);
      return found.find(event => event.id === eventId && verifyEvent(event));
    } finally { clearTimeout(timer); pool.destroy(); }
  };
  return Object.freeze({
    async persistSignedEvent(value) {
      const event = Event.parse(JSON.parse(new TextDecoder().decode(value.eventBytes)));
      const eventBytesSha256 = Digest.parse(value.eventBytesSha256);
      if (event.id !== Digest.parse(value.eventId) || !verifyEvent(event) || sha256(value.eventBytes) !== eventBytesSha256) throw new Error("NOSTR_RELAY_EVENT_INVALID");
      const persisted = PersistedEvent.parse({ state: "persisted", eventId: value.eventId, eventBytesSha256, eventBytesBase64: Buffer.from(value.eventBytes).toString("base64"), candidateSha256: value.candidateSha256, sealedArtifactSha256: value.sealedArtifactSha256, aggregateSha256: value.aggregateSha256, relaySetReference: value.relaySetReference, relaySetSha256: value.relaySetSha256, authorizationRequestSha256: value.authorizationRequestSha256, authorizationReceiptSha256: value.authorizationReceiptSha256 });
      const claimed = await input.journal.claim(`relay:${value.operationId}`, eventBytesSha256, persisted);
      if (!claimed.claimed && !samePersistedIdentity(PersistedEvent.parse(claimed.record.value), persisted)) throw new Error("NOSTR_RELAY_OPERATION_IDENTITY_CONFLICT");
    },
    async observeOriginalEvent(value) {
      const record = await input.journal.read<z.infer<typeof PersistedEvent>>(`relay:${value.operationId}`);
      if (!record) return { status: "missing" };
      const persisted = PersistedEvent.safeParse(record.value);
      if (!persisted.success || persisted.data.eventId !== Digest.parse(value.eventId)) throw new Error("NOSTR_RELAY_PERSISTED_IDENTITY_INVALID");
      if (persisted.data.relaySetReference !== value.relaySetReference) throw new Error("NOSTR_RELAY_REFERENCE_MISMATCH");
      try {
        const event = await read(value.eventId);
        return event ? { status: "complete", operationId: value.operationId, eventId: value.eventId, relaySetReference: value.relaySetReference, relayObservation: event.id } : { status: "missing", operationId: value.operationId };
      } catch { return { status: "unknown", operationId: value.operationId }; }
    },
    async publishSignedEvent(value) {
      const event = Event.parse(JSON.parse(new TextDecoder().decode(value.eventBytes)));
      if (event.id !== Digest.parse(value.eventId) || !verifyEvent(event) || !sameRelaySet(value.relays.map(relay => Relay.parse(relay)), relays)) throw new Error("NOSTR_RELAY_EVENT_INVALID");
      const record = await input.journal.read<z.infer<typeof PersistedEvent>>(`relay:${value.operationId}`);
      const persisted = record && PersistedEvent.safeParse(record.value);
      if (!persisted?.success || persisted.data.eventId !== event.id || persisted.data.eventBytesSha256 !== sha256(value.eventBytes)) throw new Error("NOSTR_RELAY_PERSISTENCE_REQUIRED");
      if (persisted.data.state === "dispatching") {
        const observed = await read(event.id).catch(() => undefined);
        if (observed) return;
        throw new Error("NOSTR_RELAY_OUTCOME_UNKNOWN");
      }
      const dispatching = PersistedEvent.parse({ ...persisted.data, state: "dispatching" });
      const transitioned = await input.journal.compareAndSet(`relay:${value.operationId}`, persisted.data.eventBytesSha256, record!.revision, dispatching);
      if (!transitioned) {
        const observed = await read(event.id).catch(() => undefined);
        if (observed) return;
        throw new Error("NOSTR_RELAY_OUTCOME_UNKNOWN");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Publication takes the reviewed, pinned @napplet/cli path.  Its
        // helper owns the SimplePool lifecycle and bounds each relay wait to
        // 15 seconds; the journal CAS above remains the exactly-once gate.
        const settlements = await Promise.race([
          loadPinnedCliNetworkHelpers().then(({ publishEventWithSimplePool }) => publishEventWithSimplePool([...relays], event)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("NOSTR_RELAY_ACK_TIMEOUT")), timeoutMs); }),
        ]);
        if (!settlements.some(result => result.success)) throw new Error("NOSTR_RELAY_ACK_REJECTED");
      } catch (error) {
        // A missing acknowledgement is an uncertain outcome. Query exactly the
        // original signed ID; do not republish or substitute an event.
        const observed = await read(event.id).catch(() => undefined);
        if (!observed) throw error;
      } finally { clearTimeout(timer); }
    },
  });
}
