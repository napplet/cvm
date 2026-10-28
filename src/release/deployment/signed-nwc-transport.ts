import { ApplesauceRelayPool } from "@contextvm/sdk/relay";
import type { NostrSigner } from "@contextvm/sdk/core";
import { verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { z } from "zod";
import type { AuthenticatedNwcInvoiceTransport } from "../../funding/nwc-receipt-port";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "./postgres-operation-journal";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Pubkey = z.string().regex(/^[a-f0-9]{64}$/u);
const Relay = z.string().url().refine((value) => new URL(value).protocol === "wss:");
const Method = z.enum(["make_invoice", "lookup_invoice", "list_transactions"]);
const Result = z.object({ result_type: Method, result: z.unknown(), error: z.object({ code: z.string(), message: z.string() }).optional() }).passthrough();
type OriginalState = Readonly<{ eventId: string; event: NostrEvent; method: z.infer<typeof Method>; state: "pending" }>;
type QuerySequence = Readonly<{ nextAttempt: number }>;

export type NwcSigningBroker = Readonly<{
  openNwcConnection(input: Readonly<{ reference: string; purpose: "nwc_lightning_receipts" }>): Promise<Readonly<{
    connectionScopeDigest: string;
    walletPubkey: string;
    relays: readonly string[];
    consentedMethods: readonly string[];
    signer: NostrSigner;
  }>>;
}>;

/** Deployment credential authority (Keychain/HSM/secret-manager backed).
 * It returns a narrowly-scoped NIP-44 signing capability, never a connection
 * URI, nsec, or exported key bytes. This is the production composition seam;
 * `NwcSigningBroker` remains the normalized transport-facing shape. */
export type NwcCredentialBroker = Readonly<{
  resolveNwcLightningCapability(input: Readonly<{ reference: string; purpose: "nwc_lightning_receipts" }>): Promise<Readonly<{
    connectionScopeDigest: string;
    walletPubkey: string;
    relays: readonly string[];
    consentedMethods: readonly string[];
    signer: NostrSigner;
  }>>;
}>;

export function createNwcCredentialSigningBroker(input: Readonly<{ credentials: NwcCredentialBroker }>): NwcSigningBroker {
  if (!input.credentials || typeof input.credentials.resolveNwcLightningCapability !== "function") throw new Error("NWC_CREDENTIAL_BROKER_REQUIRED");
  return Object.freeze({ openNwcConnection: ({ reference, purpose }) => input.credentials.resolveNwcLightningCapability({ reference, purpose }) });
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal, cleanup?: () => Promise<void>): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { void cleanup?.(); reject(new DOMException("aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** NIP-47 transport using an authority-held NIP-44 signer. The connection
 * secret is never materialized in application memory: the broker exposes only
 * signing/encryption operations. Original signed request identity is stored in
 * PostgreSQL before publication; uncertainty observes `#e`, never republishes. */
export async function openSignedNwcTransport(input: Readonly<{
  connectionReference: string;
  broker: NwcSigningBroker;
  journal: PostgresOperationJournal;
}>): Promise<AuthenticatedNwcInvoiceTransport & Readonly<{ journal: PostgresOperationJournal; close(): Promise<void> }>> {
  try { assertPostgresOperationJournal(input.journal); } catch { throw new Error("NWC_DURABLE_JOURNAL_REQUIRED"); }
  if (!/^nwc:[a-z][a-z0-9:._/-]{2,255}$/iu.test(input.connectionReference) || /(?:nsec|private|secret|token|proof)/iu.test(input.connectionReference)) throw new Error("NWC_CONNECTION_REFERENCE_INVALID");
  if (!input.broker || typeof input.broker.openNwcConnection !== "function") throw new Error("NWC_SIGNING_BROKER_REQUIRED");
  const connection = await input.broker.openNwcConnection({ reference: input.connectionReference, purpose: "nwc_lightning_receipts" });
  const connectionScopeDigest = Digest.parse(connection?.connectionScopeDigest);
  const walletPubkey = Pubkey.parse(connection?.walletPubkey);
  const relays = z.array(Relay).min(1).max(16).parse(connection?.relays);
  const consentedMethods = z.array(Method).min(1).max(3).parse(connection?.consentedMethods);
  if (new Set(relays).size !== relays.length || new Set(consentedMethods).size !== consentedMethods.length || !connection.signer?.nip44) throw new Error("NWC_CONNECTION_BROKER_INVALID");
  const signer = connection.signer;
  const pool = new ApplesauceRelayPool(relays, { reconnectBaseDelayMs: 1_000, reconnectMaxDelayMs: 30_000, publishOptions: { retries: 1, timeout: 10_000 } });
  const signerPubkey = Pubkey.parse(await signer.getPublicKey());

  async function response(eventId: string, method: z.infer<typeof Method>, signal: AbortSignal): Promise<unknown | undefined> {
    await untilAborted(pool.connect(), signal, () => pool.disconnect());
    return new Promise<unknown | undefined>((resolve, reject) => {
      let finished = false; let unsubscribe: (() => void) | undefined;
      const finish = (value?: unknown, error?: unknown) => { if (finished) return; finished = true; signal.removeEventListener("abort", aborted); unsubscribe?.(); error ? reject(error) : resolve(value); };
      const aborted = () => finish(undefined, new DOMException("aborted", "AbortError"));
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted, { once: true });
      void pool.subscribe([{ kinds: [23195], authors: [walletPubkey], "#e": [eventId] }], (event: NostrEvent) => {
        void (async () => {
          if (!verifyEvent(event) || event.pubkey !== walletPubkey || !event.tags.some((tag) => tag[0] === "e" && tag[1] === eventId)) return;
          try {
            const plaintext = await signer.nip44!.decrypt(walletPubkey, event.content);
            const parsed = Result.safeParse(JSON.parse(plaintext));
            if (!parsed.success || parsed.data.result_type !== method || parsed.data.error) return;
            finish(parsed.data.result);
          } catch { /* an invalid wallet response is not a receipt */ }
        })();
      }).then(value => { unsubscribe = value; if (finished) unsubscribe(); }).catch(error => finish(undefined, error));
    });
  }

  async function nextQueryOperation(method: z.infer<typeof Method>, params: Readonly<Record<string, unknown>>): Promise<string> {
    const queryIdentity = await sha256({ connectionScopeDigest, walletPubkey, method, params });
    const counterKey = `nwc-query-sequence:${queryIdentity}`;
    for (;;) {
      const prior = await input.journal.read<QuerySequence>(counterKey);
      if (!prior) {
        const claimed = await input.journal.claim<QuerySequence>(counterKey, queryIdentity, { nextAttempt: 1 });
        if (claimed.claimed) return `nwc-query:${queryIdentity}:1`;
        continue;
      }
      if (prior.identitySha256 !== queryIdentity || !Number.isSafeInteger(prior.value.nextAttempt) || prior.value.nextAttempt < 1 || prior.value.nextAttempt >= 1_000_000) throw new Error("NWC_QUERY_SEQUENCE_CONFLICT");
      const attempt = prior.value.nextAttempt + 1;
      const advanced = await input.journal.compareAndSet<QuerySequence>(counterKey, queryIdentity, prior.revision, { nextAttempt: attempt });
      if (advanced) return `nwc-query:${queryIdentity}:${attempt}`;
    }
  }

  async function request(methodRaw: "make_invoice" | "lookup_invoice" | "list_transactions", params: Readonly<Record<string, unknown>>, signal: AbortSignal, originalOperationId?: string): Promise<unknown> {
    const method = Method.parse(methodRaw);
    if (method === "make_invoice" && originalOperationId === undefined) throw new Error("NWC_ORIGINAL_OPERATION_REQUIRED");
    // Lookup/list calls get a bounded durable observation attempt. A retry of
    // one uncertain attempt observes that same #e; a subsequent state poll
    // receives a new signed query rather than replaying an old unpaid result.
    const operationId = originalOperationId === undefined
      ? await nextQueryOperation(method, params)
      : z.string().regex(/^[a-z][a-z0-9:_-]{2,255}$/u).parse(originalOperationId);
    const identitySha256 = await sha256({ connectionScopeDigest, walletPubkey, method, params });
    const existing = await input.journal.read<OriginalState>(`nwc:${operationId}`);
    if (existing) {
      if (existing.identitySha256 !== identitySha256) throw new Error("NWC_ORIGINAL_OPERATION_CONFLICT");
      const observed = await response(existing.value.eventId, method, signal); if (observed === undefined) throw new Error("NWC_ORIGINAL_RESPONSE_UNKNOWN"); return observed;
    }
    const plaintext = JSON.stringify({ method, params });
    const content = await signer.nip44!.encrypt(walletPubkey, plaintext);
    const event = await signer.signEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1_000), tags: [["p", walletPubkey]], content });
    if (!verifyEvent(event) || event.pubkey !== signerPubkey || event.kind !== 23194 || event.tags.length !== 1 || event.tags[0]?.[0] !== "p" || event.tags[0]?.[1] !== walletPubkey || await signer.nip44!.decrypt(walletPubkey, event.content) !== plaintext) throw new Error("NWC_SIGNED_REQUEST_INVALID");
    const claim = await input.journal.claim<OriginalState>(`nwc:${operationId}`, identitySha256, { eventId: event.id, event, method, state: "pending" });
    if (!claim.claimed) {
      const observed = await response(claim.record.value.eventId, method, signal); if (observed === undefined) throw new Error("NWC_ORIGINAL_RESPONSE_UNKNOWN"); return observed;
    }
    await untilAborted(pool.connect(), signal, () => pool.disconnect());
    try { await untilAborted(pool.publish(event), signal, () => pool.disconnect()); } catch { const observed = await response(event.id, method, signal); if (observed === undefined) throw new Error("NWC_ORIGINAL_RESPONSE_UNKNOWN"); return observed; }
    const observed = await response(event.id, method, signal); if (observed === undefined) throw new Error("NWC_ORIGINAL_RESPONSE_UNKNOWN"); return observed;
  }
  return Object.freeze({ journal: input.journal, connectionScopeDigest, consentedMethods: Object.freeze([...consentedMethods]), request,
    observeOriginalResponse: async (operationId: string, signal: AbortSignal) => { const stored = await input.journal.read<OriginalState>(`nwc:${operationId}`); return stored ? response(stored.value.eventId, stored.value.method, signal) : undefined; },
    close: () => pool.disconnect(),
  });
}
