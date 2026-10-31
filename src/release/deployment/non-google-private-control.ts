import { z } from "zod";

import { canonicalJson } from "../../promotion/schema";
import { CertificationEdgePayloadSchemas, CertificationEdgeKindSchema as EdgeKind, type CertificationEdgeKind } from "../../production/certification-edge-protocol";
import { assertNonGoogleInvocationAuthority, type NonGoogleInvocationAuthority } from "../../production/non-google-invocation-authority";
import { NonGoogleSuccessorControl, type NonGoogleSuccessorControlObservation } from "../../production/non-google-successor-control";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "./postgres-operation-journal";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Id = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u);
const KeyId = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u);
const Signature = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const Timestamp = z.string().regex(/^[1-9][0-9]{0,15}$/u);
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);
const MAX_BYTES = 1_048_576;
const MAX_SKEW_MS = 60_000;
const CONTROL_PATH = "/internal/non-google-edge/operations";
const Status = z.object({ operationId: Id, kind: EdgeKind, requestSha256: Digest, state: z.enum(["pending", "completed", "unknown", "failed"]), result: z.unknown().optional() }).strict();
const Command = z.object({ operationId: Id, kind: EdgeKind, payload: z.unknown(), candidateSha256: Digest, topologySha256: Digest, roleCostBoundSha256: Digest, requestSha256: Digest }).strict();

type EdgeCommand = z.infer<typeof Command>;
export type NonGooglePrivateControlObservation = z.infer<typeof Status>;

const capabilities = new WeakSet<object>();
const clients = new WeakSet<object>();

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || /(?:^|\.)run\.app$/iu.test(url.hostname) || /(?:^|\.)googleapis\.com$/iu.test(url.hostname)
    || /^(?:localhost|127\.0\.0\.1|::1)$/iu.test(url.hostname)) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_ORIGIN_INVALID");
  return url.origin;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength); bytes.set(source);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function b64url(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  if (a.byteLength !== b.byteLength) return false;
  let result = 0; for (let index = 0; index < a.byteLength; index += 1) result |= a[index]! ^ b[index]!;
  return result === 0;
}

export type NonGooglePrivateControlCapability = Readonly<{
  keyId: string;
  expiresAtMs: number;
  sign(input: Readonly<{ method: "GET" | "POST"; path: string; bodySha256: string; requestSha256: string; timestampMs: number; nonce: string; candidateSha256: string; topologySha256: string; roleCostBoundSha256: string }>): Promise<string>;
}>;

/** Controller-owned private channel material. It is deliberately separate
 * from successor authorization: possession only authenticates the private
 * channel and cannot itself permit spend or provider effects. */
export function createNonGooglePrivateControlCapability(input: Readonly<{ keyId: string; secret: Uint8Array; expiresAtMs: number }>): NonGooglePrivateControlCapability {
  const keyId = KeyId.parse(input.keyId);
  if (!(input.secret instanceof Uint8Array) || input.secret.byteLength < 32 || input.secret.byteLength > 4096 || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= Date.now()) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_CAPABILITY_INVALID");
  const secret = new Uint8Array(input.secret);
  const capability = Object.freeze({ keyId, expiresAtMs: input.expiresAtMs, async sign(value: Readonly<{ method: "GET" | "POST"; path: string; bodySha256: string; requestSha256: string; timestampMs: number; nonce: string; candidateSha256: string; topologySha256: string; roleCostBoundSha256: string }>) {
    if (value.path !== CONTROL_PATH && !new RegExp(`^${CONTROL_PATH}/[a-z][a-z0-9:_-]{2,127}$`, "u").test(value.path)) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_ROUTE_DENIED");
    const material = canonicalJson({ keyId, ...value });
    const signature = await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(material));
    return b64url(new Uint8Array(signature));
  } });
  capabilities.add(capability);
  return capability;
}

async function body(response: Response): Promise<unknown> {
  if (!response.ok || response.redirected || !response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_RESPONSE_REJECTED");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0; let done = false;
  try { for (;;) { const next = await reader.read(); if (next.done) { done = true; break; } length += next.value.byteLength; if (length > MAX_BYTES) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_RESPONSE_TOO_LARGE"); chunks.push(next.value); } }
  finally { if (!done) void reader.cancel(); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function requestBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0; let done = false;
  try { for (;;) { const next = await reader.read(); if (next.done) { done = true; break; } length += next.value.byteLength; if (length > MAX_BYTES) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_REQUEST_TOO_LARGE"); chunks.push(next.value); } }
  finally { if (!done) void reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export class NonGooglePrivateControlClient {
  readonly binding: Readonly<{ candidateSha256: string; topologySha256: string; roleCostBoundSha256: string; authorizationRequestSha256: string }>;
  readonly #origin: string;
  readonly #capability: NonGooglePrivateControlCapability;
  readonly #authority: NonGoogleInvocationAuthority;
  readonly #journal: PostgresOperationJournal;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly #now: () => number;
  constructor(input: Readonly<{ serviceUrl: string; candidateSha256: string; topologySha256: string; roleCostBoundSha256: string; authorizationRequestSha256: string; capability: NonGooglePrivateControlCapability; authority: NonGoogleInvocationAuthority; journal: PostgresOperationJournal; fetch?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number }>) {
    this.#origin = origin(input.serviceUrl); const now = input.now ?? Date.now; assertNonGoogleInvocationAuthority(input.authority); assertPostgresOperationJournal(input.journal);
    if (!capabilities.has(input.capability)) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_CAPABILITY_REQUIRED");
    const candidateSha256 = Digest.parse(input.candidateSha256); const topologySha256 = Digest.parse(input.topologySha256); const roleCostBoundSha256 = Digest.parse(input.roleCostBoundSha256); const authorizationRequestSha256 = Digest.parse(input.authorizationRequestSha256);
    if (input.capability.expiresAtMs <= now()) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_BINDING_REQUIRED");
    this.binding = Object.freeze({ candidateSha256, topologySha256, roleCostBoundSha256, authorizationRequestSha256 }); this.#capability = input.capability; this.#authority = input.authority; this.#journal = input.journal; this.#fetch = input.fetch ?? ((url, init) => fetch(url, init)); this.#now = now; clients.add(this); Object.freeze(this);
  }
  async #request(method: "GET" | "POST", path: string, requestSha256: string, command?: EdgeCommand): Promise<NonGooglePrivateControlObservation> {
    const now = this.#now();
    const bodyText = command === undefined ? undefined : canonicalJson(command); if (bodyText !== undefined && Buffer.byteLength(bodyText) > MAX_BYTES) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_REQUEST_TOO_LARGE");
    const timestampMs = now; const nonce = crypto.randomUUID().replaceAll("-", ""); const bodySha256 = await sha256(bodyText ?? "");
    const signature = await this.#capability.sign({ method, path, bodySha256, requestSha256, timestampMs, nonce, candidateSha256: this.binding.candidateSha256, topologySha256: this.binding.topologySha256, roleCostBoundSha256: this.binding.roleCostBoundSha256 });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, { method, redirect: "error", signal: controller.signal, headers: { accept: "application/json", "content-type": "application/json", "x-napplet-private-control-key-id": this.#capability.keyId, "x-napplet-private-control-timestamp": String(timestampMs), "x-napplet-private-control-nonce": nonce, "x-napplet-private-control-body-sha256": bodySha256, "x-napplet-private-control-request-sha256": requestSha256, "x-napplet-private-control-candidate-sha256": this.binding.candidateSha256, "x-napplet-private-control-topology-sha256": this.binding.topologySha256, "x-napplet-private-control-role-cost-bound-sha256": this.binding.roleCostBoundSha256, "x-napplet-private-control-signature": signature }, ...(bodyText === undefined ? {} : { body: bodyText }) });
      return Status.parse(await body(response));
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async execute(input: Readonly<{ operationId: string; kind: CertificationEdgeKind; payload: unknown }>): Promise<NonGooglePrivateControlObservation> {
    const operationId = Id.parse(input.operationId); const kind = EdgeKind.parse(input.kind); const payload = CertificationEdgePayloadSchemas[kind].parse(input.payload);
    const unsigned = { operationId, kind, payload, candidateSha256: this.binding.candidateSha256, topologySha256: this.binding.topologySha256, roleCostBoundSha256: this.binding.roleCostBoundSha256 }; const requestSha256 = await sha256(canonicalJson(unsigned));
    let dispatchError: unknown;
    try { this.#authority.assertDispatch({ scope: scopeFor(kind), effect: kind, candidateSha256: this.binding.candidateSha256, topologySha256: this.binding.topologySha256, roleCostBoundSha256: this.binding.roleCostBoundSha256, requestSha256: this.binding.authorizationRequestSha256 }); }
    catch (error) { if (!(error instanceof Error) || error.message !== "NON_GOOGLE_INVOCATION_EXPIRED") throw error; dispatchError = error; }
    const prior = await this.#journal.read(operationId);
    if (prior) {
      if (prior.identitySha256 !== requestSha256) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_ORIGINAL_CONFLICT");
      this.#authority.assertOriginalObservation({ scope: scopeFor(kind), effect: kind, candidateSha256: this.binding.candidateSha256, topologySha256: this.binding.topologySha256, roleCostBoundSha256: this.binding.roleCostBoundSha256, requestSha256: this.binding.authorizationRequestSha256, originalRecorded: true });
      return this.observe({ operationId, kind, requestSha256 });
    }
    if (dispatchError) throw dispatchError;
    const claim = await this.#journal.claim(operationId, requestSha256, { state: "pending", kind });
    if (!claim.claimed) return this.observe({ operationId, kind, requestSha256 });
    const observed = await this.#request("POST", CONTROL_PATH, requestSha256, Command.parse({ ...unsigned, requestSha256 }));
    if (observed.operationId !== operationId || observed.kind !== kind || observed.requestSha256 !== requestSha256) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_OPERATION_MISMATCH");
    return observed;
  }
  async observe(input: Readonly<{ operationId: string; kind: CertificationEdgeKind; requestSha256: string }>): Promise<NonGooglePrivateControlObservation> {
    const operationId = Id.parse(input.operationId); const kind = EdgeKind.parse(input.kind); const requestSha256 = Digest.parse(input.requestSha256);
    this.#authority.assertOriginalObservation({ scope: scopeFor(kind), effect: kind, candidateSha256: this.binding.candidateSha256, topologySha256: this.binding.topologySha256, roleCostBoundSha256: this.binding.roleCostBoundSha256, requestSha256: this.binding.authorizationRequestSha256, originalRecorded: true });
    const observed = await this.#request("GET", `${CONTROL_PATH}/${encodeURIComponent(operationId)}`, requestSha256);
    if (observed.operationId !== operationId || observed.kind !== kind || observed.requestSha256 !== requestSha256) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_OPERATION_MISMATCH");
    return observed;
  }
}

export function assertNonGooglePrivateControlClient(value: unknown): asserts value is NonGooglePrivateControlClient {
  if (!value || typeof value !== "object" || !clients.has(value)) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_CLIENT_REQUIRED");
}

function scopeFor(kind: CertificationEdgeKind): string {
  if (kind.startsWith("edge.security.")) return "edge.security";
  if (kind.startsWith("edge.supply.")) return "edge.supply";
  if (kind.startsWith("edge.payment.")) return "edge.payment";
  return "edge.publication";
}

export function createNonGooglePrivateControlHandler(input: Readonly<{ capability: NonGooglePrivateControlCapability; control: NonGoogleSuccessorControl; now?: () => number }>) {
  const now = input.now ?? Date.now;
  if (!capabilities.has(input.capability)) throw new Error("NON_GOOGLE_PRIVATE_CONTROL_CAPABILITY_REQUIRED");
  return Object.freeze({ async handle(request: Request): Promise<Response> {
    const url = new URL(request.url); const method = request.method;
    const operationId = url.pathname.startsWith(`${CONTROL_PATH}/`) ? decodeURIComponent(url.pathname.slice(CONTROL_PATH.length + 1)) : undefined;
    if ((method !== "POST" || url.pathname !== CONTROL_PATH) && (method !== "GET" || operationId === undefined || !Id.safeParse(operationId).success)) return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
    const timestamp = Timestamp.safeParse(request.headers.get("x-napplet-private-control-timestamp")); const nonce = Nonce.safeParse(request.headers.get("x-napplet-private-control-nonce")); const keyId = KeyId.safeParse(request.headers.get("x-napplet-private-control-key-id")); const sentHash = Digest.safeParse(request.headers.get("x-napplet-private-control-body-sha256")); const requestSha256 = Digest.safeParse(request.headers.get("x-napplet-private-control-request-sha256")); const candidateSha256 = Digest.safeParse(request.headers.get("x-napplet-private-control-candidate-sha256")); const topologySha256 = Digest.safeParse(request.headers.get("x-napplet-private-control-topology-sha256")); const roleCostBoundSha256 = Digest.safeParse(request.headers.get("x-napplet-private-control-role-cost-bound-sha256")); const signature = Signature.safeParse(request.headers.get("x-napplet-private-control-signature"));
    if (!timestamp.success || !nonce.success || !keyId.success || !sentHash.success || !requestSha256.success || !candidateSha256.success || !topologySha256.success || !roleCostBoundSha256.success || !signature.success || keyId.data !== input.capability.keyId || Math.abs(now() - Number(timestamp.data)) > MAX_SKEW_MS) return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401, headers: { "content-type": "application/json" } });
    let raw: string;
    try { raw = method === "POST" ? await requestBody(request) : ""; }
    catch { return new Response(JSON.stringify({ error: "INVALID_REQUEST" }), { status: 400, headers: { "content-type": "application/json" } }); }
    if (await sha256(raw) !== sentHash.data) return new Response(JSON.stringify({ error: "INVALID_REQUEST" }), { status: 400, headers: { "content-type": "application/json" } });
    let command: ReturnType<typeof Command.safeParse> | undefined;
    try { command = method === "POST" ? Command.safeParse(JSON.parse(raw)) : undefined; }
    catch { return new Response(JSON.stringify({ error: "INVALID_REQUEST" }), { status: 400, headers: { "content-type": "application/json" } }); }
    if (method === "POST" && (!command || !command.success || command.data.requestSha256 !== requestSha256.data)) return new Response(JSON.stringify({ error: "INVALID_REQUEST" }), { status: 400, headers: { "content-type": "application/json" } });
    const binding = { candidateSha256: candidateSha256.data, topologySha256: topologySha256.data, roleCostBoundSha256: roleCostBoundSha256.data };
    if (command?.data && (command.data.candidateSha256 !== binding.candidateSha256 || command.data.topologySha256 !== binding.topologySha256 || command.data.roleCostBoundSha256 !== binding.roleCostBoundSha256)) return new Response(JSON.stringify({ error: "INVALID_REQUEST" }), { status: 400, headers: { "content-type": "application/json" } });
    const expected = await input.capability.sign({ method, path: url.pathname, bodySha256: sentHash.data, requestSha256: requestSha256.data, timestampMs: Number(timestamp.data), nonce: nonce.data, ...binding });
    if (!equal(expected, signature.data)) return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401, headers: { "content-type": "application/json" } });
    try {
      const observed: NonGoogleSuccessorControlObservation = method === "POST"
        ? await input.control.execute(command!.data)
        : await input.control.observe({ operationId: Id.parse(operationId), requestSha256: requestSha256.data });
      return new Response(canonicalJson(Status.parse({ operationId: observed.operationId, kind: observed.kind, requestSha256: observed.requestSha256, state: observed.state, ...(observed.result === undefined ? {} : { result: observed.result }) })), { status: 200, headers: { "content-type": "application/json" } });
    } catch { return new Response(JSON.stringify({ error: "OPERATION_REJECTED" }), { status: 409, headers: { "content-type": "application/json" } }); }
  } });
}
