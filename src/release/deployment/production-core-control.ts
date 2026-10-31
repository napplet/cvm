import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";
import { ReleaseAuthorizationReceiptSchema, validateAuthorizationReceipt, validateAuthorizationRequest } from "../authorization";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "./postgres-operation-journal";
import { CoreControlPayloadSchemas } from "./production-core-suite-protocol";

export const CoreControlKindSchema = z.enum(["cohort.prepare", "cohort.observe", "telemetry.emit", "telemetry.window", "fault.inject", "fault.observe", "restore.prepare", "restore.inventory", "restore.lose-local", "restore.create", "restore.subject", "restore.expiry", "restore.topology", "restore.cleanup", "edge.security.build", "edge.security.hostile", "edge.security.browser", "edge.security.signer", "edge.supply.primary", "edge.supply.secondary", "edge.supply.attestation", "edge.payment.contextvm", "edge.payment.cep8", "edge.payment.model", "edge.publication.source", "edge.publication.submit", "edge.publication.reconcile", "edge.publication.direct.source", "edge.publication.direct.submit", "edge.publication.direct.reconcile"]);
export type CoreControlKind = z.infer<typeof CoreControlKindSchema>;
const Id = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Status = z.object({ operationId: Id, kind: CoreControlKindSchema, requestSha256: Digest, state: z.enum(["pending", "completed", "unknown", "failed"]), result: z.unknown().optional() }).strict();
export type CoreControlObservation = z.infer<typeof Status>;
const LIMIT = 1_048_576;
const clients = new WeakSet<object>();
export function assertProductionCoreControlClient(value: unknown): asserts value is ProductionCoreControlClient {
  if (!value || typeof value !== "object" || !clients.has(value)) throw new Error("PRODUCTION_CORE_CONTROL_CLIENT_REQUIRED");
}

export type PrivateControlIdentity = Readonly<{ token(audience: string): Promise<string> }>;
/** Official ADC service-account ID tokens. User OAuth access tokens cannot
 * substitute for Cloud Run's audience-bound service identity. No I/O on construction. */
export function createGooglePrivateControlIdentity(principal: string): PrivateControlIdentity {
  if (!/^[a-z][a-z0-9-]{2,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u.test(principal)) throw new Error("CORE_CONTROL_PRINCIPAL_INVALID");
  const auth = new GoogleAuth(); const verifier = new OAuth2Client();
  return Object.freeze({ async token(audience) {
    const client = await auth.getIdTokenClient(audience);
    const token = await client.idTokenProvider.fetchIdToken(audience);
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload || payload.email !== principal || payload.email_verified !== true || !payload.exp || payload.exp * 1000 <= Date.now() + 30_000) throw new Error("CORE_CONTROL_IDENTITY_MISMATCH");
    return token;
  } });
}
async function sha256(value: unknown) { return new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex"); }
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("CORE_CONTROL_TIMEOUT")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Private diagnostic/fault/restore control only: no HTTP generation endpoint.
 * POST is attempted once after durable claim. Re-entry and unknown responses
 * perform GET on the same original operation, including after process loss. */
export type ProductionCoreControlInput = Readonly<{
    serviceUrl: string; candidateSha256: string; topologySha256: string;
    request: unknown; receipt: unknown; journal: PostgresOperationJournal;
    identity: PrivateControlIdentity; fetch?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number;
  }>;
export class ProductionCoreControlClient {
  readonly #input: ProductionCoreControlInput;
  readonly binding: Readonly<{ candidateSha256: string; topologySha256: string }>;
  constructor(input: ProductionCoreControlInput) {
    assertPostgresOperationJournal(input.journal);
    const url = new URL(input.serviceUrl);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.run\.app$/u.test(url.hostname) || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("CORE_CONTROL_ORIGIN_INVALID");
    Digest.parse(input.candidateSha256); Digest.parse(input.topologySha256);
    this.#input = Object.freeze({ ...input, serviceUrl: url.origin });
    clients.add(this);
    this.binding = Object.freeze({ candidateSha256: input.candidateSha256.toLowerCase(), topologySha256: input.topologySha256.toLowerCase() });
    Object.freeze(this);
  }
  async #authorize(readOnly = false) {
    const request = await validateAuthorizationRequest(this.#input.request);
    const receipt = ReleaseAuthorizationReceiptSchema.parse(this.#input.receipt);
    const now = (this.#input.now ?? Date.now)();
    // Expiry closes dispatch authority. It must not strand observation of a
    // previously claimed operation after a lost response or process restart.
    await validateAuthorizationReceipt({ request, receipt, nowMs: readOnly ? Math.min(now, receipt.expiresAtMs - 1) : now });
    if (request.candidateSha256 !== this.#input.candidateSha256 || request.topologySha256 !== this.#input.topologySha256 || !request.orderedEffects.some(effect => effect.provider === "cloud_run") || !request.providerScopes.some(scope => scope.provider === "cloud_run")) throw new Error("CORE_CONTROL_BINDING_INVALID");
    return request;
  }
  async #http(path: string, method: "GET" | "POST", body?: string): Promise<unknown> {
    // Independently revalidate immediately before authentication/network I/O.
    await this.#authorize(method === "GET");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const token = await bounded(this.#input.identity.token(this.#input.serviceUrl), 5_000);
      if (!/^[A-Za-z0-9_.-]{20,16384}$/u.test(token)) throw new Error("CORE_CONTROL_TOKEN_INVALID");
      await this.#authorize(method === "GET");
      const response = await (this.#input.fetch ?? fetch)(`${this.#input.serviceUrl}${path}`, { method, body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("CORE_CONTROL_RESPONSE_UNAVAILABLE");
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0; let finished = false;
      try {
        for (;;) { const part = await reader.read(); if (part.done) { finished = true; break; } length += part.value.byteLength; if (length > LIMIT) throw new Error("CORE_CONTROL_RESPONSE_TOO_LARGE"); chunks.push(part.value); }
      } finally { if (!finished) void reader.cancel(); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async execute(input: Readonly<{ operationId: string; kind: CoreControlKind; payload: unknown }>): Promise<CoreControlObservation> {
    const request = await this.#authorize(true); const operationId = Id.parse(input.operationId); const kind = CoreControlKindSchema.parse(input.kind);
    const schema = CoreControlPayloadSchemas[kind as keyof typeof CoreControlPayloadSchemas];
    const payload = schema ? schema.parse(input.payload) : input.payload;
    const command = { operationId, kind, payload, candidateSha256: this.#input.candidateSha256, topologySha256: this.#input.topologySha256, authorizationRequestSha256: request.authorizationRequestSha256 };
    const body = canonicalJson(command); if (Buffer.byteLength(body) > LIMIT) throw new Error("CORE_CONTROL_REQUEST_TOO_LARGE");
    const requestSha256 = await sha256(command);
    const original = await this.#input.journal.read(operationId);
    if (original) {
      if (original.identitySha256 !== requestSha256) throw new Error("OPERATION_IDENTITY_CONFLICT");
      return this.observe({ operationId, kind, requestSha256 });
    }
    // Only a new claim can reach POST, and it needs unexpired authority.
    await this.#authorize();
    const claim = await this.#input.journal.claim(operationId, requestSha256, { state: "pending", kind });
    if (!claim.claimed) return this.observe({ operationId, kind, requestSha256 });
    try {
      const observed = Status.parse(await this.#http("/internal/certification/operations", "POST", JSON.stringify({ ...command, requestSha256 })));
      if (observed.operationId !== operationId || observed.kind !== kind || observed.requestSha256 !== requestSha256) throw new Error("CORE_CONTROL_OPERATION_MISMATCH");
      return observed;
    } catch { return Object.freeze({ operationId, kind, requestSha256, state: "unknown" }); }
  }
  async observe(input: Readonly<{ operationId: string; kind: CoreControlKind; requestSha256: string }>): Promise<CoreControlObservation> {
    await this.#authorize(true); const operationId = Id.parse(input.operationId); const kind = CoreControlKindSchema.parse(input.kind); const requestSha256 = Digest.parse(input.requestSha256);
    const original = await this.#input.journal.read(operationId);
    if (!original || original.identitySha256 !== requestSha256) throw new Error("CORE_CONTROL_ORIGINAL_REQUIRED");
    try {
      const observed = Status.parse(await this.#http(`/internal/certification/operations/${encodeURIComponent(operationId)}`, "GET"));
      if (observed.operationId !== operationId || observed.kind !== kind || observed.requestSha256 !== requestSha256) throw new Error("CORE_CONTROL_OPERATION_MISMATCH");
      return observed;
    } catch { return Object.freeze({ operationId, kind, requestSha256, state: "unknown" }); }
  }
}
