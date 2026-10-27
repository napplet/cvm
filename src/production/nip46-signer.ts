import { createHash } from "node:crypto";
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { z } from "zod";

import type { ExternalSignerPort } from "../release/native/external-signer";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Operation = z.string().regex(/^[a-z][a-z0-9:_-]{2,300}$/u);
const Template = z.object({ kind: z.literal(35129), content: z.string().max(64_000), tags: z.array(z.array(z.string().max(4096)).min(1).max(16)).max(128), created_at: z.number().int().positive() }).strict();
const UploadAuthorizationTemplate = z.object({ kind: z.literal(24242), content: z.literal("Upload blobs via napplet"), tags: z.array(z.array(z.string().max(4096)).min(1).max(16)).min(5).max(128), created_at: z.number().int().positive() }).strict().superRefine((value, context) => {
  const values = (name: string) => value.tags.filter(tag => tag[0] === name).map(tag => tag[1]);
  if (values("t")[0] !== "upload" || values("x").length === 0 || values("expiration").length !== 1 || values("client")[0] !== "napplet" || values("server").length !== 1) context.addIssue({ code: "custom", message: "NIP46_UPLOAD_TEMPLATE_INVALID" });
});
const ExactTemplate = z.union([Template, UploadAuthorizationTemplate]);
const BunkerEvent = z.object({ id: Digest, pubkey: Digest, created_at: z.number().int().nonnegative(), kind: z.literal(24133), tags: z.array(z.array(z.string())).max(128), content: z.string().min(1), sig: z.string().regex(/^[a-f0-9]{128}$/iu) }).strict();
const SignedEvent = z.object({ id: Digest, pubkey: Digest, created_at: z.number().int().nonnegative(), kind: z.number().int().nonnegative(), tags: z.array(z.array(z.string())), content: z.string(), sig: z.string().regex(/^[a-f0-9]{128}$/iu) }).strict();
const SignRecord = z.object({
  state: z.enum(["request_persisted", "dispatching", "signed"]), intentDigest: Digest, requestId: z.string().min(1).max(400),
  ownerPubkey: Digest, requestEvent: BunkerEvent, event: z.unknown().optional(),
}).strict();

export type Nip46SessionKeyBroker = Readonly<{ resolve(input: Readonly<{ reference: string; purpose: "nip46_disposable_client" }>): Promise<Uint8Array> }>;
export type Nip46PublicationContext = Readonly<{
  resolve(input: Readonly<{ intentDigest: string }>): Promise<Readonly<{ operationId: string; ownerPubkey: string; capabilities: readonly string[]; template: z.infer<typeof Template> }>>;
}>;
export type Nip46OriginalOperationContext = Readonly<{
  resolveOriginal(input: Readonly<{ operationId: string; purpose: "upload_authorization" }>): Promise<Readonly<{ intentDigest: string; ownerPubkey: string; capabilities: readonly string[]; template: z.infer<typeof ExactTemplate> }>>;
}>;
type SigningContext = Readonly<{ operationId: string; ownerPubkey: string; capabilities: readonly string[]; template: z.infer<typeof ExactTemplate> }>;

type Bunker = Readonly<{ pubkey: string; relays: readonly string[]; secret: string | null }>;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function parseBunker(value: string): Bunker {
  const uri = new URL(value);
  const relays = uri.searchParams.getAll("relay");
  const localWs = (relay: string) => { const url = new URL(relay); return url.protocol === "ws:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname); };
  if (uri.protocol !== "bunker:" || !/^[a-f0-9]{64}$/iu.test(uri.hostname) || relays.length === 0 || relays.length > 16 || relays.some(relay => !relay.startsWith("wss://") && !localWs(relay)) || new Set(relays).size !== relays.length) throw new Error("NIP46_REFERENCE_INVALID");
  const secret = uri.searchParams.get("secret");
  if (secret !== null && (secret.length < 8 || secret.length > 512)) throw new Error("NIP46_REFERENCE_INVALID");
  return Object.freeze({ pubkey: Digest.parse(uri.hostname), relays: Object.freeze(relays), secret });
}

/** NIP-46 signing with a durable, deterministic request ID. A timeout never
 * reconstructs a request: it queries only for the response to the persisted
 * encrypted event. No owner private key enters this module. */
export async function openProductionNip46Signer(input: Readonly<{
  bunkerUri: string; sessionKeyReference: string; sessionKeyBroker: Nip46SessionKeyBroker;
  context: Nip46PublicationContext; originalOperationContext?: Nip46OriginalOperationContext; journal: PostgresOperationJournal; timeoutMs?: number;
}>): Promise<ExternalSignerPort & Readonly<{ close(): Promise<void>; signExactOperation(input: Readonly<{ operationId: string; purpose: "upload_authorization" }>): Promise<unknown> }>> {
  const bunker = parseBunker(input.bunkerUri);
  if (!input.sessionKeyReference.startsWith("nostr:") || /(?:nsec|owner|private|secret|password)/iu.test(input.sessionKeyReference)) throw new Error("NIP46_REFERENCE_INVALID");
  assertPostgresOperationJournal(input.journal);
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("NIP46_TIMEOUT_INVALID");
  const brokerKey = await input.sessionKeyBroker.resolve({ reference: input.sessionKeyReference, purpose: "nip46_disposable_client" });
  if (!(brokerKey instanceof Uint8Array) || brokerKey.byteLength !== 32) throw new Error("NIP46_SESSION_KEY_INVALID");
  const key = new Uint8Array(brokerKey);
  const clientPubkey = getPublicKey(key);
  const conversationKey = nip44.v2.utils.getConversationKey(key, bunker.pubkey);
  let closed = false;
  let discovery: Readonly<{ pubkey: string; capabilities: readonly string[]; consentState: "granted" | "pending" }> | undefined;
  const bounded = async <T>(work: Promise<T>, code: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  const responseFor = async (requestId: string) => {
    const pool = new SimplePool();
    try {
      const events = await bounded(pool.querySync([...bunker.relays], { kinds: [24133], authors: [bunker.pubkey], "#p": [clientPubkey], limit: 50 }, { maxWait: timeoutMs }), "NIP46_RESPONSE_TIMEOUT");
      for (const raw of events) {
        const event = BunkerEvent.safeParse(raw);
        if (!event.success || !verifyEvent(event.data)) continue;
        try {
          const response = z.object({ id: z.string(), result: z.string().optional(), error: z.string().optional() }).strict().parse(JSON.parse(nip44.v2.decrypt(event.data.content, conversationKey)));
          if (response.id === requestId) return response;
        } catch { /* Unrelated/malformed encrypted relay data is untrusted. */ }
      }
      return undefined;
    } finally { pool.destroy(); }
  };
  const requestResponse = async (method: "connect" | "get_public_key", params: readonly string[]) => {
    const requestId = `nip46:discovery:${clientPubkey}:${method}`;
    const requestEvent = BunkerEvent.parse(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", bunker.pubkey]], content: nip44.v2.encrypt(JSON.stringify({ id: requestId, method, params }), conversationKey) }, key));
    const pool = new SimplePool();
    try { await bounded(Promise.any(pool.publish([...bunker.relays], requestEvent)), "NIP46_REQUEST_TIMEOUT"); }
    catch { /* A retained response is still authoritative; query it below. */ }
    finally { pool.destroy(); }
    return responseFor(requestId);
  };
  const observeDiscovery = async () => {
    if (discovery) return discovery;
    if (!bunker.secret) return Object.freeze({ pubkey: bunker.pubkey, capabilities: [], consentState: "pending" as const });
    try {
      const connected = await requestResponse("connect", [bunker.pubkey, bunker.secret]);
      if (!connected || connected.error || connected.result !== "ack") return Object.freeze({ pubkey: bunker.pubkey, capabilities: [], consentState: "pending" as const });
      const publicKey = await requestResponse("get_public_key", []);
      const pubkey = publicKey?.result ? Digest.safeParse(publicKey.result) : undefined;
      if (!pubkey?.success) return Object.freeze({ pubkey: bunker.pubkey, capabilities: [], consentState: "pending" as const });
      discovery = Object.freeze({ pubkey: pubkey.data, capabilities: Object.freeze(["sign_event"]), consentState: "granted" as const });
      return discovery;
    } catch { return Object.freeze({ pubkey: bunker.pubkey, capabilities: [], consentState: "pending" as const }); }
  };
  const sign = async (record: z.infer<typeof SignRecord>, revision: number, context: SigningContext, intentDigest: string) => {
    const response = await responseFor(record.requestId);
    if (!response || response.error || !response.result) throw new Error("NIP46_SIGNING_OUTCOME_UNKNOWN");
    const event = SignedEvent.parse(JSON.parse(response.result));
    if (event.pubkey !== context.ownerPubkey.toLowerCase() || !verifyEvent(event)
      || event.kind !== context.template.kind || event.content !== context.template.content
      || JSON.stringify(event.tags) !== JSON.stringify(context.template.tags) || event.created_at !== context.template.created_at) throw new Error("NIP46_OWNER_MISMATCH");
    const identity = sha256(`${intentDigest}:${context.operationId}:${JSON.stringify(context.template)}`);
    const stored = await input.journal.compareAndSet(`nip46:${context.operationId}`, identity, revision, { ...record, state: "signed", event });
    const final = stored ? SignRecord.parse(stored.value) : SignRecord.parse((await input.journal.read(`nip46:${context.operationId}`))?.value);
    if (final.state !== "signed" || final.intentDigest !== intentDigest) throw new Error("NIP46_SIGNING_OUTCOME_UNKNOWN");
    const signed = SignedEvent.parse(final.event);
    return Object.freeze({ pubkey: signed.pubkey, intentDigest, authorizationReceipt: `nip46:${context.operationId}`, event: signed });
  };
  const signContext = async (rawContext: SigningContext, rawIntentDigest: string) => {
      if (closed) throw new Error("NIP46_CLOSED");
      const intentDigest = Digest.parse(rawIntentDigest);
      const context: SigningContext = { operationId: Operation.parse(rawContext.operationId), ownerPubkey: Digest.parse(rawContext.ownerPubkey), capabilities: rawContext.capabilities, template: ExactTemplate.parse(rawContext.template) };
      const operationId = Operation.parse(context.operationId);
      const ownerPubkey = Digest.parse(context.ownerPubkey);
      const observedSigner = await observeDiscovery();
      if (observedSigner.consentState !== "granted" || ownerPubkey !== observedSigner.pubkey || !observedSigner.capabilities.includes("sign_event") || !context.capabilities.includes("sign_event")) throw new Error("NIP46_OWNER_MISMATCH");
      const identity = sha256(`${intentDigest}:${operationId}:${JSON.stringify(context.template)}`);
      const requestId = `nip46:${operationId}:${intentDigest}`;
      const existing = await input.journal.read<z.infer<typeof SignRecord>>(`nip46:${operationId}`);
      let record: z.infer<typeof SignRecord>;
      let revision: number;
      if (existing) {
        record = SignRecord.parse(existing.value); revision = existing.revision;
      } else {
        const requestEvent = BunkerEvent.parse(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", bunker.pubkey]], content: nip44.v2.encrypt(JSON.stringify({ id: requestId, method: "sign_event", params: [JSON.stringify(context.template)] }), conversationKey) }, key));
        const claimed = await input.journal.claim(`nip46:${operationId}`, identity, { state: "request_persisted", intentDigest, requestId, ownerPubkey, requestEvent });
        record = SignRecord.parse(claimed.record.value); revision = claimed.record.revision;
      }
      if (record.intentDigest !== intentDigest || record.ownerPubkey !== ownerPubkey || record.requestId !== requestId) throw new Error("NIP46_ORIGINAL_SIGNING_REQUIRES_RECONCILIATION");
      if (record.state === "signed") {
        const event = SignedEvent.parse(record.event);
        return Object.freeze({ pubkey: event.pubkey, intentDigest, authorizationReceipt: `nip46:${operationId}`, event });
      }
      if (record.state === "dispatching") return sign(record, revision, context, intentDigest);
      const dispatching = SignRecord.parse({ ...record, state: "dispatching" });
      const transitioned = await input.journal.compareAndSet(`nip46:${operationId}`, identity, revision, dispatching);
      if (!transitioned) {
        const latest = await input.journal.read(`nip46:${operationId}`);
        if (!latest) throw new Error("NIP46_SIGNING_OUTCOME_UNKNOWN");
        const latestRecord = SignRecord.parse(latest.value);
        if (latestRecord.state === "signed") {
          const event = SignedEvent.parse(latestRecord.event);
          return Object.freeze({ pubkey: event.pubkey, intentDigest, authorizationReceipt: `nip46:${operationId}`, event });
        }
        return sign(latestRecord, latest.revision, context, intentDigest);
      }
      const pool = new SimplePool();
      try { await bounded(Promise.any(pool.publish([...bunker.relays], record.requestEvent)), "NIP46_REQUEST_TIMEOUT"); }
      catch { /* The persisted request may have reached the bunker; query only. */ }
      finally { pool.destroy(); }
      return sign(dispatching, transitioned.revision, context, intentDigest);
  };
  return Object.freeze({
    async discover() {
      if (closed) throw new Error("NIP46_CLOSED");
      return observeDiscovery();
    },
    async signExactIntent({ intentDigest }: Readonly<{ intentDigest: string }>) { return signContext(await input.context.resolve({ intentDigest: Digest.parse(intentDigest) }), intentDigest); },
    async signExactOperation({ operationId, purpose }: Readonly<{ operationId: string; purpose: "upload_authorization" }>) {
      if (!input.originalOperationContext || purpose !== "upload_authorization") throw new Error("NIP46_OPERATION_CONTEXT_REQUIRED");
      const context = await input.originalOperationContext.resolveOriginal({ operationId: Operation.parse(operationId), purpose });
      if (context.template.kind !== 24242) throw new Error("NIP46_OPERATION_CONTEXT_INVALID");
      return signContext({ operationId, ownerPubkey: context.ownerPubkey, capabilities: context.capabilities, template: context.template }, context.intentDigest);
    },
    async close() { closed = true; key.fill(0); conversationKey.fill(0); },
  });
}
