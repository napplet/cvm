import { z } from "zod";
import { verifyEvent } from "nostr-tools/pure";
import { canonicalJson } from "../promotion/schema";
import { assertDirectUploadOwner, DirectUploadScopeSchema, type DirectSealedUploadPort } from "../release/native/direct-upload";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { DIRECT_CLI_NETWORK_IDENTITY, loadPinnedDirectCliNetworkHelpers } from "./pinned-direct-cli-network";
import { validateAuthorizationReceipt, validateAuthorizationRequest } from "../release/authorization";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Event = z.object({ id: Digest, pubkey: Digest, sig: z.string().regex(/^[a-f0-9]{128}$/u), kind: z.literal(24242), created_at: z.number().int().positive(),
  content: z.literal("Upload blobs via napplet"), tags: z.array(z.array(z.string().max(1024)).min(1).max(3)).max(8) }).strict();
const File = z.object({ path: z.literal("/index.html"), mimeType: z.literal("text/html"), sha256: Digest, size: z.number().int().min(1).max(2_000_000) }).strict();
const Common = z.object({ scope: DirectUploadScopeSchema, server: z.string(), ownerPubkey: Digest, helperSha256: z.literal(DIRECT_CLI_NETWORK_IDENTITY.bundleSha256) }).strict();
const Binding = z.object({ candidateSha256: Digest, topologySha256: Digest, effectPlanSha256: Digest, accountScopeSha256: Digest, projectScopeSha256: Digest }).strict();
const Record = z.discriminatedUnion("state", [Common.extend({ state: z.literal("prepared") }).strict(), Common.extend({ state: z.literal("dispatching"), file: File, authorization: Event }).strict()]);
const sha = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const key = (operationId: string) => `direct-cli-upload:v1:${sha(operationId)}`;
async function bounded(response: Response, maximum: number) {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > maximum) throw new Error("DIRECT_UPLOAD_RESPONSE_LIMIT");
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maximum) throw new Error("DIRECT_UPLOAD_RESPONSE_LIMIT"); chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Actual receipt-gated certification transport. Ordinary post-cutover owner
 * publication requires its own approved actor composition; it must not inherit
 * an expiring release receipt as permanent user authority. No signer callback
 * or credentials are accepted here. */
export async function createProductionDirectCliUploadPort(input: Readonly<{ server: string; targetReference: string; ownerPubkey: string; binding: z.input<typeof Binding>; journal: PostgresOperationJournal; timeoutMs?: number; now?: () => number }>): Promise<DirectSealedUploadPort> {
  assertPostgresOperationJournal(input.journal);
  const url = new URL(input.server), server = url.origin, ownerPubkey = Digest.parse(input.ownerPubkey), now = input.now ?? Date.now, timeoutMs = input.timeoutMs ?? 30_000;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    || !input.targetReference || input.targetReference.length > 256 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000) throw new Error("DIRECT_UPLOAD_CONFIGURATION_INVALID");
  const helpers = await loadPinnedDirectCliNetworkHelpers();
  const binding = Object.freeze(Binding.parse(input.binding));
  const exactBinding = (scope: z.infer<typeof DirectUploadScopeSchema>) => scope.candidateSha256 === binding.candidateSha256 && scope.topologySha256 === binding.topologySha256 && scope.effectPlanSha256 === binding.effectPlanSha256;
  const identity = (scope: z.infer<typeof DirectUploadScopeSchema>) => sha(canonicalJson({ scope, server, ownerPubkey, helperSha256: helpers.identity.bundleSha256 }));
  const stored = async (operationId: string) => {
    const row = await input.journal.read(key(operationId)); if (!row) return undefined;
    const record = Record.parse(row.value);
    if (row.identitySha256 !== identity(record.scope) || record.scope.operationId !== operationId || record.server !== server || record.scope.server !== server
      || record.ownerPubkey !== ownerPubkey || record.scope.ownerManifest.pubkey !== ownerPubkey || record.scope.targetReference !== input.targetReference || !exactBinding(record.scope)) throw new Error("DIRECT_UPLOAD_ORIGINAL_MISMATCH");
    assertDirectUploadOwner(record.scope);
    return { row, record };
  };
  const token = async (scope: z.infer<typeof DirectUploadScopeSchema>, eventValue: unknown, checkTime: boolean) => {
    const event = Event.parse(eventValue), seconds = Math.floor(now() / 1000);
    if (event.pubkey !== ownerPubkey || !verifyEvent(event) || checkTime && (event.created_at > seconds + 30 || event.created_at + 3600 <= seconds)) throw new Error("DIRECT_UPLOAD_OWNER_AUTHORIZATION_INVALID");
    const sign = async (template: unknown) => {
      if (canonicalJson(template) !== canonicalJson({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content })) throw new Error("DIRECT_UPLOAD_AUTH_SCOPE_DOWNGRADE_DENIED");
      return event;
    };
    // The actual CLI constructs the expected BUD-11 template/header. The
    // callback only returns an already-completed, matching public signature.
    const header = await helpers.createUploadAuthorization({ sign }, [scope.artifactHash], event.created_at, url.hostname);
    return { event, header, sign };
  };
  const authorizePut = async (scope: z.infer<typeof DirectUploadScopeSchema>, authority: Readonly<{ request: unknown; receipt: unknown }>) => {
    const request = await validateAuthorizationRequest(authority.request), receipt = await validateAuthorizationReceipt({ request, receipt: authority.receipt, nowMs: now() });
    const effects = request.orderedEffects.filter(effect => effect.provider === "upload"), scopes = request.providerScopes.filter(scope => scope.provider === "upload");
    if (request.authorizationRequestSha256 !== scope.authorizationRequestSha256 || receipt.authorizationReceiptSha256 !== scope.authorizationReceiptSha256
      || request.candidateSha256 !== scope.candidateSha256 || request.topologySha256 !== scope.topologySha256 || request.effectPlanSha256 !== scope.effectPlanSha256
      || !exactBinding(scope) || now() >= scope.intentExpiresAtMs || scopes.length !== 1 || scopes[0]!.accountScopeSha256 !== binding.accountScopeSha256 || scopes[0]!.projectScopeSha256 !== binding.projectScopeSha256
      || request.artifactRetentionDays !== scope.retentionDays || effects.length !== 1 || effects[0]!.id !== "sealed-upload" || effects[0]!.operation !== "verify_integration") throw new Error("DIRECT_UPLOAD_EFFECT_AUTHORIZATION_REQUIRED");
  };
  const readExact = async (file: z.infer<typeof File>, signal: AbortSignal) => {
    const response = await fetch(`${server}/${file.sha256}`, { method: "GET", redirect: "manual", signal });
    if (!response.ok || response.status !== 200) { await response.body?.cancel(); return false; }
    const bytes = await bounded(response, file.size + 1);
    return bytes.length === file.size && sha(bytes) === file.sha256;
  };
  return Object.freeze<DirectSealedUploadPort>({
    async persist(value) {
      const scope = DirectUploadScopeSchema.parse(value); assertDirectUploadOwner(scope);
      if (scope.server !== server || scope.targetReference !== input.targetReference || scope.ownerManifest.pubkey !== ownerPubkey || !exactBinding(scope)) throw new Error("DIRECT_UPLOAD_SCOPE_MISMATCH");
      await input.journal.claim(key(scope.operationId), identity(scope), { state: "prepared", scope, server, ownerPubkey, helperSha256: helpers.identity.bundleSha256 });
      const original = await stored(scope.operationId);
      if (!original || canonicalJson(original.record.scope) !== canonicalJson(scope)) throw new Error("DIRECT_UPLOAD_ORIGINAL_MISMATCH");
    },
    async observeOriginalUpload(value) {
      if (value.targetReference !== input.targetReference) throw new Error("DIRECT_UPLOAD_SCOPE_MISMATCH");
      const original = await stored(value.operationId); if (!original || original.record.state === "prepared") return { status: "missing" };
      const record = original.record;
      if (record.file.sha256 !== record.scope.artifactHash) throw new Error("DIRECT_UPLOAD_ORIGINAL_MISMATCH");
      await token(record.scope, record.authorization, false);
      try {
        if (!await readExact(record.file, AbortSignal.timeout(timeoutMs))) return { status: "unknown", operationId: value.operationId };
        return { status: "complete", operationId: value.operationId, server, targetReference: record.scope.targetReference, retentionDays: record.scope.retentionDays,
          artifactHash: record.scope.artifactHash, archiveSha256: record.scope.archiveSha256, ownerEventId: record.scope.ownerManifest.id,
          fileChecksums: [record.file.sha256], locationReference: `${server}/${record.file.sha256}` };
      } catch { return { status: "unknown", operationId: value.operationId }; }
    },
    async uploadExact(value) {
      const original = await stored(value.operationId); if (!original) throw new Error("DIRECT_UPLOAD_PERSISTENCE_REQUIRED");
      if (original.record.state === "dispatching") throw new Error("DIRECT_UPLOAD_ORIGINAL_REQUIRES_OBSERVATION");
      const scope = original.record.scope;
      if (value.targetReference !== scope.targetReference || value.retentionDays !== scope.retentionDays || value.files.length !== 1) throw new Error("DIRECT_UPLOAD_SCOPE_MISMATCH");
      const source = value.files[0]!, file = File.parse({ path: source.path, mimeType: source.mimeType, sha256: source.sha256, size: source.size });
      if (!(source.bytes instanceof Uint8Array) || file.size !== source.bytes.length || file.sha256 !== scope.artifactHash) throw new Error("DIRECT_UPLOAD_EXACT_BYTES_REQUIRED");
      const bytes = new Uint8Array(source.bytes);
      if (sha(bytes) !== file.sha256) throw new Error("DIRECT_UPLOAD_EXACT_BYTES_REQUIRED");
      const authorization = await token(scope, value.authorization, true);
      await authorizePut(scope, value.effectAuthorization);
      const dispatch = await input.journal.compareAndSet(key(value.operationId), original.row.identitySha256, original.row.revision,
        { ...original.record, state: "dispatching", file, authorization: authorization.event });
      if (!dispatch) throw new Error("DIRECT_UPLOAD_ORIGINAL_REQUIRES_OBSERVATION");
      let sent = false; const signal = AbortSignal.timeout(timeoutMs);
      const fetcher: typeof fetch = Object.assign(async (resource: Parameters<typeof fetch>[0], options?: RequestInit) => {
        if (options?.method === "HEAD" && String(resource) === `${server}/${file.sha256}`) return new Response(null, { status: await readExact(file, signal) ? 200 : 404 });
        if (sent || options?.method !== "PUT" || String(resource) !== `${server}/upload` || !(options.body instanceof Blob)) throw new Error("DIRECT_UPLOAD_NETWORK_SCOPE_INVALID");
        const headers = new Headers(options.headers), body = new Uint8Array(await options.body.arrayBuffer());
        if (headers.get("authorization") !== authorization.header || headers.get("x-sha-256") !== file.sha256 || headers.get("content-type") !== file.mimeType || body.length !== file.size || sha(body) !== file.sha256) throw new Error("DIRECT_UPLOAD_EXACT_BYTES_REQUIRED");
        await authorizePut(scope, value.effectAuthorization);
        await token(scope, authorization.event, true);
        sent = true;
        const response = await fetch(String(resource), { ...options, redirect: "manual", signal });
        const result = await bounded(response, 65_536);
        return new Response(result, { status: response.status, headers: response.headers });
      }, { preconnect() { throw new Error("DIRECT_UPLOAD_NETWORK_SCOPE_INVALID"); } });
      const results = await helpers.uploadFilesToServers([{ candidateDir: "sealed", path: file.path, sha256: file.sha256, data: bytes, contentType: file.mimeType }], [server], { sign: authorization.sign }, { now: () => authorization.event.created_at, fetch: fetcher });
      if (results.length !== 1 || !results[0]!.success || results[0]!.server !== server || results[0]!.sha256 !== file.sha256 || results[0]!.file !== file.path) throw new Error("DIRECT_UPLOAD_OUTCOME_REQUIRES_OBSERVATION");
    },
  });
}
