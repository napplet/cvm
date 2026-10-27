import { computeCanonicalInvocationIdentity } from "@contextvm/sdk/payments/canonical-identity";
import { ApplesauceRelayPool } from "@contextvm/sdk/relay";
import { EncryptionMode, type NostrSigner } from "@contextvm/sdk/core";
import { NostrClientTransport, NostrServerTransport } from "@contextvm/sdk/transport";
import { z } from "zod";
import { ContextVmSdkBridge, type ContextVmInboundEnvelope, type ContextVmTransportPort, type ContextVmWireNotification, type ContextVmWireResponse } from "../../contextvm/sdk-bridge";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "./postgres-operation-journal";
import { validateAuthorizationReceipt, validateAuthorizationRequest } from "../authorization";
import { assertProductionAdmissionObserver, type ProductionCertificationCoreServices } from "../../production/certification-services";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const PubkeySchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ReferenceSchema = z.string().regex(/^[a-z][a-z0-9:./_-]{2,255}$/iu);

function reference(value: unknown): string {
  const parsed = ReferenceSchema.parse(value);
  if (/(?:nsec|private|secret|password|ya29\.)/iu.test(parsed)) throw new Error("DEPLOYMENT_SECRET_REFERENCE_INVALID");
  return parsed;
}

const RelaySchema = z.string().url().refine((value) => new URL(value).protocol === "wss:", "WSS relay required");
const EventIdSchema = z.string().min(1).max(256);

/** Durable original-event authority. The concrete PostgreSQL CAS adapter is
 * supplied by the production composition; local maps are deliberately rejected. */
export type ContextVmInvocationJournal = PostgresOperationJournal;

export type ContextVmServiceSignerBroker = Readonly<{
  resolveContextVmSigner(input: Readonly<{ reference: string; purpose: "contextvm_service" }>): Promise<NostrSigner>;
}>;

/** A release probe uses a disposable, broker-held client signer.  This is
 * deliberately distinct from both the service key and a user's NIP-46 key. */
export type ContextVmCertificationSignerBroker = Readonly<{
  resolveContextVmCertificationSigner(input: Readonly<{ reference: string; purpose: "contextvm_certification_client" }>): Promise<NostrSigner>;
}>;

type CertificationCallState = Readonly<{
  candidateId: string;
  operationId: string;
  requestIdentitySha256: string;
  state: "pending" | "responded" | "observed";
  sessionId?: string;
  serverOperationId?: string;
}>;

export type ContextVmCertificationClient = Readonly<{
  /** Measures the signed funding/admission boundary without invoking inference. */
  admit(input: Readonly<{ operationId: unknown; candidateId: unknown; requestedCap: unknown }>): Promise<Readonly<{ operationId: string; state: "responded" | "unknown"; admissionReference?: string; outcome?: "accepted" | "capacity_unavailable" | "reconciliation_pending" }>>;
  /** Sends exactly one signed generate invocation for an original operation.
   * A duplicate call is an observation/recovery, never a second dispatch. */
  generate(input: Readonly<{ operationId: unknown; candidateId: unknown; admissionReference: unknown; maximum: unknown; idea: unknown }>): Promise<Readonly<{ operationId: string; state: "responded" | "unknown"; sessionId?: string; serverOperationId?: string }>>;
  /** Uses ContextVM's signed status tool only; it has no redispatch path. */
  observeOriginal(input: Readonly<{ operationId: unknown }>): Promise<Readonly<{ operationId: string; state: "pending" | "observed" | "unknown"; sessionId?: string; serverOperationId?: string }>>;
  close(): Promise<void>;
}>;

const certificationClients = new WeakSet<object>();

/** Rejects lookalike callback clients outside tests.  Only the official SDK
 * transport constructed by openContextVmCertificationClient carries this
 * private runtime brand. */
export function assertContextVmCertificationClient(value: unknown): asserts value is ContextVmCertificationClient {
  if (!value || typeof value !== "object" || !certificationClients.has(value)) throw new Error("CONTEXTVM_CERTIFICATION_CLIENT_REQUIRED");
}

const CertificationOperationSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,127}$/u);
const CertificationCandidateSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const CertificationReferenceSchema = z.string().min(1).max(512);
const CertificationMaximumSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/u);
const CertificationIdeaSchema = z.string().min(1).max(20_000);

type InvocationState = Readonly<{ state: "pending" }> | Readonly<{ state: "completed"; response: ContextVmWireResponse }>;
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Persists a signed original event before the core is invoked. Redelivery
 * returns the one durable response; it never creates another funded action. */
export function createDurableContextVmTransport(input: Readonly<{ source: ContextVmTransportPort; journal: ContextVmInvocationJournal; relaySetSha256?: unknown }>): ContextVmTransportPort {
  try { assertPostgresOperationJournal(input.journal); } catch { throw new Error("CONTEXTVM_DURABLE_JOURNAL_REQUIRED"); }
  const relaySetSha256 = input.relaySetSha256 === undefined ? undefined : DigestSchema.parse(input.relaySetSha256);
  let handler: ((value: ContextVmInboundEnvelope) => Promise<void>) | undefined;
  const dispatching = new Map<string, Readonly<{ envelope: ContextVmInboundEnvelope; identitySha256: string; revision: number }>>();
  input.source.onInbound(async (envelope) => {
    const requestEventId = EventIdSchema.parse(envelope.requestEventId);
    if (envelope.rawEvent.id !== requestEventId) throw new Error("CONTEXTVM_ORIGINAL_EVENT_MISMATCH");
    const canonical = input.source.canonicalInvocation(envelope.verifiedClientPubkey, envelope.request.method, envelope.request.params);
    const identitySha256 = await digest({ requestEventId, clientPubkey: canonical.clientPubkey, invocationSha256: DigestSchema.parse(canonical.invocationHash), relaySetSha256 });
    const claim = await input.journal.claim<InvocationState>(requestEventId, identitySha256, { state: "pending" });
    if (!claim.claimed && claim.record.value.state === "completed") return input.source.sendResponse(envelope.verifiedClientPubkey, claim.record.value.response, requestEventId);
    if (!claim.claimed) return input.source.sendResponse(envelope.verifiedClientPubkey, { jsonrpc: "2.0", id: envelope.request.id, error: { code: -32001, message: "original ContextVM invocation pending reconciliation" } }, requestEventId);
    if (!handler) throw new Error("CONTEXTVM_INBOUND_HANDLER_UNAVAILABLE");
    dispatching.set(requestEventId, { envelope, identitySha256, revision: claim.record.revision });
    try { await handler(envelope); } finally { dispatching.delete(requestEventId); }
  });
  const certificationClient = Object.freeze<ContextVmTransportPort>({
    onInbound(value) { handler = value; },
    configureAnnouncement: (announcement) => input.source.configureAnnouncement(announcement),
    async sendResponse(clientPubkey, response, requestEventId) {
      const active = dispatching.get(requestEventId);
      if (active && active.envelope.verifiedClientPubkey === clientPubkey) {
        const completed = await input.journal.compareAndSet<InvocationState>(requestEventId, active.identitySha256, active.revision, { state: "completed", response });
        if (!completed) throw new Error("CONTEXTVM_RESPONSE_JOURNAL_CONFLICT");
      }
      await input.source.sendResponse(clientPubkey, response, requestEventId);
    },
    sendNotification(clientPubkey: string, notification: ContextVmWireNotification, requestEventId: string) { return input.source.sendNotification(clientPubkey, notification, requestEventId); },
    canonicalInvocation(clientPubkey: string, method: string, params: unknown) { return input.source.canonicalInvocation(clientPubkey, method, params); },
  });
  return certificationClient;
}

/** Builds the official SDK relay transport with a broker-held service signer;
 * construction itself performs no network I/O. */
export async function openContextVmRelayTransport(input: Readonly<{
  serviceKeyReference: unknown; relaySetSha256: unknown; relays: unknown;
  signerBroker: ContextVmServiceSignerBroker; journal: ContextVmInvocationJournal;
  admissionObserver?: ProductionCertificationCoreServices;
}>): Promise<Readonly<{ transport: ContextVmTransportPort; start(): Promise<void>; close(): Promise<void> }>> {
  const serviceKeyReference = reference(input.serviceKeyReference);
  const relaySetSha256 = DigestSchema.parse(input.relaySetSha256);
  const relays = z.array(RelaySchema).min(1).max(16).parse(input.relays);
  if (new Set(relays).size !== relays.length) throw new Error("CONTEXTVM_RELAY_SET_INVALID");
  try { assertPostgresOperationJournal(input.journal); } catch { throw new Error("CONTEXTVM_DURABLE_JOURNAL_REQUIRED"); }
  if (input.admissionObserver) assertProductionAdmissionObserver(input.admissionObserver);
  if (!input.signerBroker || typeof input.signerBroker.resolveContextVmSigner !== "function") throw new Error("CONTEXTVM_SIGNER_BROKER_REQUIRED");
  const signer = await input.signerBroker.resolveContextVmSigner({ reference: serviceKeyReference, purpose: "contextvm_service" });
  if (!signer || typeof signer.getPublicKey !== "function" || typeof signer.signEvent !== "function") throw new Error("CONTEXTVM_SIGNER_BROKER_INVALID");
  const pool = new ApplesauceRelayPool(relays, { reconnectBaseDelayMs: 1_000, reconnectMaxDelayMs: 30_000, publishOptions: { retries: 1, timeout: 10_000 } });
  const sdk = new NostrServerTransport({ signer, relayHandler: pool, encryptionMode: EncryptionMode.REQUIRED, injectClientPubkey: true, injectRequestEventId: true, isAnnouncedServer: true, logLevel: "warn" });
  const source = new ContextVmSdkBridge(sdk);
  return Object.freeze({ transport: createDurableContextVmTransport({ source: input.admissionObserver ? input.admissionObserver.wrap(source) : source, journal: input.journal, relaySetSha256 }), start: () => sdk.start(), close: () => sdk.close() });
}

/**
 * Opens the official authenticated ContextVM client transport used by the
 * admission/edge protected suites.  It is intentionally internal: caller
 * supplied WSS endpoints and a broker-held disposable signer are the only
 * authority inputs, and no HTTP generation path exists here.  The durable
 * PostgreSQL journal is claimed before `send`; a lost response can only be
 * recovered with the signed `session_status` tool under that same operation.
 */
export async function openContextVmCertificationClient(input: Readonly<{
  certificationKeyReference: unknown;
  serverPubkey: unknown;
  relays: unknown;
  signerBroker: ContextVmCertificationSignerBroker;
  journal: PostgresOperationJournal;
  candidateSha256: unknown;
  topologySha256: unknown;
  authorizationRequest: unknown;
  authorizationReceipt: unknown;
  now?: () => number;
  timeoutMs?: number;
}>): Promise<ContextVmCertificationClient> {
  const certificationKeyReference = reference(input.certificationKeyReference);
  const configuredCandidate = CertificationCandidateSchema.parse(input.candidateSha256);
  const topologySha256 = CertificationCandidateSchema.parse(input.topologySha256);
  const serverPubkey = PubkeySchema.parse(input.serverPubkey);
  const relays = z.array(RelaySchema).min(1).max(16).parse(input.relays);
  if (new Set(relays).size !== relays.length || !input.signerBroker || typeof input.signerBroker.resolveContextVmCertificationSigner !== "function") throw new Error("CONTEXTVM_CERTIFICATION_CLIENT_INVALID");
  try { assertPostgresOperationJournal(input.journal); } catch { throw new Error("CONTEXTVM_DURABLE_JOURNAL_REQUIRED"); }
  const timeoutMs = input.timeoutMs ?? 540_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error("CONTEXTVM_CERTIFICATION_TIMEOUT_INVALID");
  async function authorize(): Promise<void> {
    const request = await validateAuthorizationRequest(input.authorizationRequest);
    const receipt = await validateAuthorizationReceipt({ request, receipt: input.authorizationReceipt, nowMs: (input.now ?? Date.now)() });
    if (request.candidateSha256 !== configuredCandidate || request.topologySha256 !== topologySha256 || receipt.candidateSha256 !== configuredCandidate || receipt.topologySha256 !== topologySha256 || !request.orderedEffects.some(effect => effect.provider === "contextvm") || !request.providerScopes.some(scope => scope.provider === "contextvm")) throw new Error("CONTEXTVM_CERTIFICATION_AUTHORIZATION_INVALID");
  }
  await authorize();
  const signer = await input.signerBroker.resolveContextVmCertificationSigner({ reference: certificationKeyReference, purpose: "contextvm_certification_client" });
  if (!signer || typeof signer.getPublicKey !== "function" || typeof signer.signEvent !== "function") throw new Error("CONTEXTVM_CERTIFICATION_SIGNER_INVALID");
  const client = new NostrClientTransport({ signer, relayHandler: relays, serverPubkey, encryptionMode: EncryptionMode.REQUIRED, logLevel: "warn" });
  const pending = new Map<string, Readonly<{ resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>>();
  client.onmessage = (message: unknown) => {
    if (!message || typeof message !== "object" || !("id" in message)) return;
    const id = (message as { id?: unknown }).id;
    if (typeof id !== "string") return;
    const active = pending.get(id); if (!active) return;
    pending.delete(id); clearTimeout(active.timer);
    const result = message as { result?: unknown; error?: { message?: unknown } };
    if (result.error) active.reject(new Error(typeof result.error.message === "string" ? result.error.message : "CONTEXTVM_CERTIFICATION_REQUEST_FAILED"));
    else active.resolve(result.result);
  };
  await authorize();
  await client.start();
  let sequence = 0;
  async function call(operationId: string, method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const id = `cert:${operationId}:${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("CONTEXTVM_CERTIFICATION_TIMEOUT")); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      void authorize().then(() => client.send({ jsonrpc: "2.0", id, method, params } as never)).catch(error => {
        const active = pending.get(id); if (active) { pending.delete(id); clearTimeout(active.timer); active.reject(error instanceof Error ? error : new Error("CONTEXTVM_CERTIFICATION_SEND_FAILED")); }
      });
    });
  }
  async function identity(inputValue: Readonly<{ operationId: string; candidateId: string; admissionReference: string; maximum: string; idea: string }>): Promise<string> {
    const principal = await signer.getPublicKey();
    return DigestSchema.parse(computeCanonicalInvocationIdentity(principal, "tools/call", { name: "start_session", arguments: inputValue }).invocationHash);
  }
  // Authenticate the supported MCP/ContextVM session before any funded tool
  // call. This is protocol setup only; it is neither a generation dispatch nor
  // a substitute for the durable original-operation record below.
  await call("certification_bootstrap", "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "napplet-cvm-certification", version: "1" },
  });
  await authorize();
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} } as never);
  const certificationClient: ContextVmCertificationClient = Object.freeze({
    async admit(value) {
      await authorize();
      const operationId = CertificationOperationSchema.parse(value.operationId);
      const candidateId = CertificationCandidateSchema.parse(value.candidateId);
      if (candidateId !== configuredCandidate) throw new Error("CONTEXTVM_CERTIFICATION_CANDIDATE_MISMATCH");
      const requestedCap = CertificationMaximumSchema.refine(value => BigInt(value) > 0n).parse(value.requestedCap);
      const args = Object.freeze({ idempotencyKey: operationId, requestedCap, unit: "sat" as const });
      const principal = await signer.getPublicKey();
      const requestIdentitySha256 = await digest({ candidateId, topologySha256, serverPubkey, invocation: computeCanonicalInvocationIdentity(principal, "tools/call", { name: "funded_admission", arguments: args }).invocationHash });
      const key = `contextvm-admission:${operationId}`;
      type AdmissionState = Readonly<{ candidateId: string; operationId: string; requestIdentitySha256: string; state: "pending" | "responded"; admissionReference?: string; outcome?: "accepted" | "capacity_unavailable" | "reconciliation_pending" }>;
      const claim = await input.journal.claim<AdmissionState>(key, requestIdentitySha256, { candidateId, operationId, requestIdentitySha256, state: "pending" });
      const project = (stored: AdmissionState) => Object.freeze({ operationId, state: stored.state === "responded" ? "responded" as const : "unknown" as const, ...(stored.admissionReference ? { admissionReference: stored.admissionReference } : {}), ...(stored.outcome ? { outcome: stored.outcome } : {}) });
      if (!claim.claimed) return project(claim.record.value);
      try {
        const response = z.object({ status: z.enum(["accepted", "capacity_unavailable", "reconciliation_pending"]), admissionReference: CertificationReferenceSchema, unit: z.literal("sat") }).passthrough().parse(await call(operationId, "tools/call", { name: "funded_admission", arguments: args }));
        const saved = await input.journal.compareAndSet<AdmissionState>(key, requestIdentitySha256, claim.record.revision, { ...claim.record.value, state: "responded", admissionReference: response.admissionReference, outcome: response.status });
        if (!saved) throw new Error("CONTEXTVM_CERTIFICATION_JOURNAL_CONFLICT");
        return project(saved.value);
      } catch {
        // A lost response never permits another signed admission request.
        // The private cohort observer queries this exact original operation.
        return Object.freeze({ operationId, state: "unknown" as const });
      }
    },
    async generate(value) {
      await authorize();
      const operationId = CertificationOperationSchema.parse(value.operationId);
      const candidateId = CertificationCandidateSchema.parse(value.candidateId);
      if (candidateId !== configuredCandidate) throw new Error("CONTEXTVM_CERTIFICATION_CANDIDATE_MISMATCH");
      const admissionReference = CertificationReferenceSchema.parse(value.admissionReference);
      const maximum = CertificationMaximumSchema.parse(value.maximum);
      const idea = CertificationIdeaSchema.parse(value.idea);
      // Exactly StartSessionArgumentsSchema's funded wire fields. Candidate
      // binding belongs to the receipt/journal, not user-visible tool args.
      const args = Object.freeze({ idempotencyKey: operationId, admissionReference, maximum, idea });
      const requestIdentitySha256 = await identity({ operationId, candidateId, admissionReference, maximum, idea });
      const claim = await input.journal.claim<CertificationCallState>(`contextvm-generate:${operationId}`, requestIdentitySha256, { candidateId, operationId, requestIdentitySha256, state: "pending" });
      if (!claim.claimed) {
        const prior = claim.record.value;
        if (prior.candidateId !== candidateId || prior.operationId !== operationId || prior.requestIdentitySha256 !== requestIdentitySha256) throw new Error("CONTEXTVM_CERTIFICATION_OPERATION_CONFLICT");
        return Object.freeze({ operationId, state: prior.sessionId ? "responded" as const : "unknown" as const, ...(prior.sessionId ? { sessionId: prior.sessionId } : {}), ...(prior.serverOperationId ? { serverOperationId: prior.serverOperationId } : {}) });
      }
      try {
        const response = z.object({ sessionId: z.string().min(1), operationId: z.string().min(1) }).passthrough().safeParse(await call(operationId, "tools/call", { name: "start_session", arguments: args }));
        if (!response.success) return Object.freeze({ operationId, state: "unknown" as const });
        const saved = await input.journal.compareAndSet(`contextvm-generate:${operationId}`, requestIdentitySha256, claim.record.revision, { ...claim.record.value, state: "responded", sessionId: response.data.sessionId, serverOperationId: response.data.operationId });
        if (!saved) throw new Error("CONTEXTVM_CERTIFICATION_JOURNAL_CONFLICT");
        return Object.freeze({ operationId, state: "responded" as const, sessionId: response.data.sessionId, serverOperationId: response.data.operationId });
      } catch (error) {
        // The original pending record deliberately remains.  A caller must use
        // observeOriginal rather than retrying the paid signed invocation.
        return Object.freeze({ operationId, state: "unknown" as const });
      }
    },
    async observeOriginal(value) {
      const operationId = CertificationOperationSchema.parse(value.operationId);
      const record = await input.journal.read<CertificationCallState>(`contextvm-generate:${operationId}`);
      if (!record || record.value.operationId !== operationId) throw new Error("CONTEXTVM_CERTIFICATION_ORIGINAL_REQUIRED");
      // A lost response with no server session mapping remains unknown. It
      // cannot authorise a replacement start_session invocation.
      if (!record.value.sessionId) return Object.freeze({ operationId, state: "unknown" as const });
      const result = await call(operationId, "tools/call", { name: "session_status", arguments: { sessionId: record.value.sessionId } });
      const status = z.object({ status: z.string().min(1) }).passthrough().safeParse(result);
      if (!status.success) return Object.freeze({ operationId, state: "unknown" as const });
      const saved = await input.journal.compareAndSet(`contextvm-generate:${operationId}`, record.identitySha256, record.revision, { ...record.value, state: "observed" });
      if (!saved) throw new Error("CONTEXTVM_CERTIFICATION_JOURNAL_CONFLICT");
      return Object.freeze({ operationId, state: "observed" as const, sessionId: record.value.sessionId, ...(record.value.serverOperationId ? { serverOperationId: record.value.serverOperationId } : {}) });
    },
    async close() {
      for (const active of pending.values()) { clearTimeout(active.timer); active.reject(new Error("CONTEXTVM_CERTIFICATION_CLOSED")); }
      pending.clear(); await client.close();
    },
  });
  certificationClients.add(certificationClient);
  return certificationClient;
}

/**
 * Deployment-owned ContextVM descriptor.  It calls the installed official
 * SDK's canonical identity primitive and contains only a named service-key
 * reference. `openContextVmRelayTransport` resolves the broker-held signer
 * and constructs the operational relay path without exposing key bytes.
 */
export function createContextVmDeploymentClient(input: Readonly<{
  serviceKeyReference: unknown;
  relaySetReference: unknown;
  relaySetSha256: unknown;
}>) {
  const serviceKeyReference = reference(input.serviceKeyReference);
  const relaySetReference = reference(input.relaySetReference);
  const relaySetSha256 = DigestSchema.parse(input.relaySetSha256);
  return Object.freeze({
    discovery: () => Object.freeze({ sdkPackage: "@contextvm/sdk@0.13.10", serviceKeyReference, relaySetReference, relaySetSha256 }),
    correlate(value: Readonly<{ clientPubkey: unknown; method: unknown; params: unknown }>) {
      const clientPubkey = PubkeySchema.parse(value.clientPubkey);
      const method = z.string().min(1).max(256).parse(value.method);
      const identity = computeCanonicalInvocationIdentity(clientPubkey, method, value.params);
      return Object.freeze({
        serviceKeyReference,
        relaySetReference,
        relaySetSha256,
        clientPubkey,
        invocationSha256: DigestSchema.parse(identity.invocationHash),
      });
    },
  });
}
