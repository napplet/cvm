import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools/pure";
import { z } from "zod";
import { loadPinnedCliNetworkHelpers } from "./pinned-cli-network";
import { canonicalSealedDeployAggregate } from "../publication/napplet-cli-adapter";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { ExactSealedUploadPort } from "../release/native/upload";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Event = z.object({ id: Digest, pubkey: Digest, sig: z.string().regex(/^[a-f0-9]{128}$/u), kind: z.literal(24242), created_at: z.number().int().positive(), content: z.string().max(512), tags: z.array(z.array(z.string().max(1024))).max(270) }).strict();
const File = z.object({ path: z.string().min(1).max(1024), sha256: Digest, size: z.number().int().min(0).max(16 * 1024 * 1024), mimeType: z.string().min(1).max(256) }).strict();
const Scope = z.object({ operationId: z.string().min(1).max(200), authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest, candidateSha256: Digest, sealedArtifactSha256: Digest, aggregateSha256: Digest, targetReference: z.string().min(1).max(256), retentionDays: z.number().int().min(30).max(3650) }).strict();
const Record = z.object({ state: z.enum(["prepared", "dispatching"]), scope: Scope, server: z.string().url(), ownerPubkey: Digest, files: z.array(File).min(1).max(256).optional(), authorization: Event.optional() }).strict();
type UploadHelper = (files: readonly { candidateDir: string; path: string; sha256: string; data: Uint8Array; contentType: string }[], servers: readonly string[], signer: { sign(template: unknown): Promise<z.infer<typeof Event>> }, options: { now(): number; fetch: typeof fetch }) => Promise<readonly { success: boolean }[]>;

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error("UPLOAD_RESPONSE_TOO_LARGE"); }
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > maximum) throw new Error("UPLOAD_RESPONSE_TOO_LARGE"); chunks.push(part.value); }
    const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Uses the exact bundled upstream CLI function. This constructor has no upload
 * effect and accepts no implementation callbacks. The caller must supply the
 * owner's signed, server-scoped BUD-11 authorization through uploadExact.
 * retentionDays records the approved retention intent; it is not a claim that
 * a Blossom server exposes or proves a retention SLA. */
export async function createProductionCliUploadPort(input: Readonly<{
  server: string; targetReference: string; ownerPubkey: string; journal: PostgresOperationJournal; timeoutMs?: number;
}>): Promise<ExactSealedUploadPort> {
  assertPostgresOperationJournal(input.journal);
  const serverUrl = new URL(input.server);
  if (serverUrl.username || serverUrl.password || serverUrl.search || serverUrl.hash || (serverUrl.protocol !== "https:" && !(serverUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(serverUrl.hostname)))) throw new Error("UPLOAD_SERVER_INVALID");
  const server = serverUrl.href.endsWith("/") ? serverUrl.href.slice(0, -1) : serverUrl.href;
  const ownerPubkey = Digest.parse(input.ownerPubkey); const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000 || !input.targetReference || input.targetReference.length > 256) throw new Error("UPLOAD_CONFIGURATION_INVALID");
  const { uploadFilesToServers } = await loadPinnedCliNetworkHelpers();
  const upload = uploadFilesToServers as UploadHelper;
  const key = (operationId: string) => `cli-upload:${digest(operationId)}`;
  const assertStored = (raw: unknown, operationId: string) => {
    const stored = Record.parse(raw);
    if (stored.scope.operationId !== operationId || stored.server !== server || stored.ownerPubkey !== ownerPubkey || stored.scope.targetReference !== input.targetReference) throw new Error("UPLOAD_OPERATION_IDENTITY_CONFLICT");
    return stored;
  };
  const readExact = async (file: z.infer<typeof File>, signal: AbortSignal) => {
    const response = await fetch(`${server}/${file.sha256}`, { method: "GET", redirect: "manual", signal });
    if (response.status !== 200) { await response.body?.cancel(); return false; }
    const actual = await boundedBytes(response, file.size + 1);
    return actual.byteLength === file.size && digest(actual) === file.sha256;
  };
  return Object.freeze({
    async persist(value) {
      const scope = Scope.parse(value);
      if (scope.targetReference !== input.targetReference) throw new Error("UPLOAD_TARGET_MISMATCH");
      const identity = digest(JSON.stringify({ scope, server, ownerPubkey }));
      const claimed = await input.journal.claim(key(scope.operationId), identity, { state: "prepared", scope, server, ownerPubkey });
      const existing = assertStored(claimed.record.value, scope.operationId);
      if (JSON.stringify(existing.scope) !== JSON.stringify(scope)) throw new Error("UPLOAD_OPERATION_IDENTITY_CONFLICT");
    },
    async observeOriginalUpload(value) {
      if (value.targetReference !== input.targetReference) throw new Error("UPLOAD_TARGET_MISMATCH");
      const row = await input.journal.read(key(value.operationId));
      if (!row) return { status: "missing" };
      const stored = assertStored(row.value, value.operationId);
      if (stored.state === "prepared") return { status: "missing" };
      if (!stored.files || !stored.authorization) throw new Error("UPLOAD_ORIGINAL_INTENT_INVALID");
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        for (const file of stored.files) if (!await readExact(file, signal)) return { status: "unknown", operationId: value.operationId };
        return { status: "complete", operationId: value.operationId, targetReference: stored.scope.targetReference, retentionDays: stored.scope.retentionDays, fileChecksums: stored.files.map(file => file.sha256), locationReference: `${server}/#${stored.scope.aggregateSha256}` };
      } catch { return { status: "unknown", operationId: value.operationId }; }
    },
    async uploadExact(value) {
      const row = await input.journal.read(key(value.operationId)); if (!row) throw new Error("UPLOAD_PERSISTENCE_REQUIRED");
      const stored = assertStored(row.value, value.operationId);
      if (value.targetReference !== stored.scope.targetReference || value.retentionDays !== stored.scope.retentionDays) throw new Error("UPLOAD_TARGET_MISMATCH");
      const files = value.files.map(file => ({ ...file, bytes: new Uint8Array(file.bytes) }));
      if (!files.length || files.length > 256 || files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > 16 * 1024 * 1024 || canonicalSealedDeployAggregate(files) !== stored.scope.aggregateSha256) throw new Error("UPLOAD_EXACT_BYTES_REQUIRED");
      const facts = files.map(({ bytes, ...file }) => { const fact = File.parse(file); if (fact.size !== bytes.byteLength || fact.sha256 !== digest(bytes)) throw new Error("UPLOAD_EXACT_BYTES_REQUIRED"); return fact; });
      if (new Set(facts.map(file => file.sha256)).size !== facts.length) throw new Error("UPLOAD_DUPLICATE_HASH");
      if (stored.state === "dispatching") throw new Error("UPLOAD_ORIGINAL_REQUIRES_OBSERVATION");
      const event = Event.parse(value.authorization);
      const expected = { kind: 24242, created_at: event.created_at, tags: [["t", "upload"], ...facts.map(file => ["x", file.sha256]), ["expiration", String(event.created_at + 3600)], ["client", "napplet"], ["server", serverUrl.hostname.toLowerCase()]], content: "Upload blobs via napplet" };
      const exactTemplate = (template: unknown) => JSON.stringify(template) === JSON.stringify(expected);
      const now = Math.floor(Date.now() / 1000);
      if (!verifyEvent(event) || event.pubkey !== ownerPubkey || event.created_at > now + 30 || event.created_at + 3600 <= now || !exactTemplate({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content })) throw new Error("UPLOAD_OWNER_AUTHORIZATION_INVALID");
      const claimed = await input.journal.compareAndSet(key(value.operationId), row.identitySha256, row.revision, { ...stored, state: "dispatching", files: facts, authorization: event });
      if (!claimed) throw new Error("UPLOAD_ORIGINAL_REQUIRES_OBSERVATION");
      const sent = new Set<string>(); const signal = AbortSignal.timeout(timeoutMs);
      const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
        if (options?.method === "HEAD") {
          const file = facts.find(file => String(url) === `${server}/${file.sha256}`); if (!file) throw new Error("UPLOAD_NETWORK_SCOPE_INVALID");
          // An upstream HEAD success otherwise skips upload without validating
          // bytes. Verify the content hash before returning that positive hit.
          return new Response(null, { status: await readExact(file, signal) ? 200 : 404 });
        }
        if (options?.method !== "PUT" || String(url) !== `${server}/upload` || !(options.body instanceof Blob)) throw new Error("UPLOAD_NETWORK_SCOPE_INVALID");
        const headers = new Headers(options.headers); const hash = headers.get("x-sha-256");
        const file = facts.find(file => file.sha256 === hash);
        const body = new Uint8Array(await options.body.arrayBuffer());
        if (!file || file.size !== body.byteLength || digest(body) !== file.sha256 || sent.has(file.sha256)) throw new Error("UPLOAD_ORIGINAL_REQUIRES_OBSERVATION");
        const expectedHeader = `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`;
        if (headers.get("authorization") !== expectedHeader) throw new Error("UPLOAD_OWNER_AUTHORIZATION_INVALID");
        sent.add(file.sha256);
        const response = await fetch(String(url), { ...options, redirect: "manual", signal });
        const responseBytes = await boundedBytes(response, 64 * 1024);
        return new Response(new Uint8Array(responseBytes).buffer, { status: response.status, headers: response.headers });
      }) as typeof fetch;
      const results = await upload(files.map(file => ({ candidateDir: "sealed", path: file.path, sha256: file.sha256, data: file.bytes, contentType: file.mimeType })), [server], { async sign(template) { if (!exactTemplate(template)) throw new Error("UPLOAD_AUTH_SCOPE_DOWNGRADE_DENIED"); return event; } }, { now: () => event.created_at, fetch: fetcher });
      if (results.length !== files.length || results.some(result => !result.success)) throw new Error("UPLOAD_OUTCOME_REQUIRES_OBSERVATION");
    },
  });
}
