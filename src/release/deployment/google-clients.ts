import { CloudRunResourceRequirementsSchema, CloudRunRevisionScalingSchema, CloudRunServiceScalingSchema, PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE, PRODUCTION_CLOUD_RUN_RESOURCES, PRODUCTION_CLOUD_RUN_SERVICE_SCALING } from "./cloud-run-resource-profile";
import { z } from "zod";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGoogleAdcTokenSource, googleAccountScopeSha256, type GoogleAccessToken, type GoogleTokenSource } from "./google-auth";
import type { PreparedCollectorOciUpload } from "../collector-image";

export type { GoogleAccessToken, GoogleTokenSource } from "./google-auth";
export type GoogleFetch = (url: string, init: RequestInit) => Promise<Response>;

const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
/** Provider labels carry the operation ownership marker, so deployment IDs are
 * deliberately bounded to Google label-value limits. */
/* A Google label value permits 63 characters. Cleanup IDs append "-cleanup"
 * (8 chars), so caller-supplied operation IDs are limited separately to 55. */
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,62}$/u);
const DeploymentOperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,54}$/u);
const RegionSchema = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u);
const ServiceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{2,48}[a-z0-9]$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ImageReferenceSchema = z.string().regex(/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/iu, "immutable registry image reference required");
const ArtifactRegistryImagePattern = /^([a-z]+-docker\.pkg\.dev)\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/([a-z0-9][a-z0-9._/-]{1,250})@sha256:([a-f0-9]{64})$/iu;
const ArtifactRegistryImageSchema = z.string().regex(ArtifactRegistryImagePattern);
const BucketSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u);
const ObjectSchema = z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes(".."), "object path required");
const InstanceSchema = z.string().regex(/^[a-z][a-z0-9-]{2,96}[a-z0-9]$/u);

export const GOOGLE_API_ORIGINS = Object.freeze({ cloudRun: "https://run.googleapis.com", storage: "https://storage.googleapis.com", cloudSql: "https://sqladmin.googleapis.com", collector: "https://run.googleapis.com", vertex: "https://aiplatform.googleapis.com" } as const);
type ApiName = keyof typeof GOOGLE_API_ORIGINS;
type SafeStatus = Readonly<{ status: "completed" | "missing" | "pending" | "unknown" | "blocked" }>;
export type GoogleOperationRecord = Readonly<{
  operationId: string; resource: string; requestSha256: string; contentSha256: string;
  state: "claimed" | "dispatching" | "dispatched" | "completed" | "unknown";
  operationName?: string; generation?: string; ownershipMarker?: string; resourceUid?: string; createTime?: string; owned: boolean;
}>;
/** Implementations must give claim/write methods durable compare-and-set
 * semantics. A second process seeing dispatching/dispatched reconciles the
 * original resource/LRO and must never issue a second create request. */
export type GoogleOperationJournal = Readonly<{
  claim(input: Omit<GoogleOperationRecord, "state" | "operationName" | "generation">): Promise<Readonly<{ claimed: boolean; record: GoogleOperationRecord }>>;
  read(operationId: string): Promise<GoogleOperationRecord | undefined>;
  markDispatching(input: Readonly<{ operationId: string; requestSha256: string }>): Promise<GoogleOperationRecord>;
  markDispatched(input: Readonly<{ operationId: string; requestSha256: string; operationName?: string }>): Promise<GoogleOperationRecord>;
  markCompleted(input: Readonly<{ operationId: string; requestSha256: string; generation?: string; resourceUid?: string; createTime?: string; owned?: boolean }>): Promise<GoogleOperationRecord>;
}>;

/** A restart-safe contract-test implementation. Production composition must
 * supply a transactional database implementation of the same CAS interface. */
export function createMemoryGoogleOperationJournal(seed: readonly GoogleOperationRecord[] = []): GoogleOperationJournal {
  const records = new Map(seed.map((record) => [record.operationId, Object.freeze({ ...record })]));
  const update = (operationId: string, requestSha256: string, patch: Partial<GoogleOperationRecord>) => {
    const current = records.get(operationId);
    if (!current || current.requestSha256 !== requestSha256) throw new Error("GOOGLE_JOURNAL_CAS_CONFLICT");
    const next = Object.freeze({ ...current, ...patch }); records.set(operationId, next); return next;
  };
  return Object.freeze({
    async claim(input) { const prior = records.get(input.operationId); if (prior) return Object.freeze({ claimed: false, record: prior }); const record = Object.freeze({ ...input, state: "claimed" as const }); records.set(record.operationId, record); return Object.freeze({ claimed: true, record }); },
    async read(operationId) { return records.get(operationId); },
    async markDispatching(input) { return update(input.operationId, input.requestSha256, { state: "dispatching" }); },
    async markDispatched(input) { return update(input.operationId, input.requestSha256, { state: "dispatched", ...(input.operationName ? { operationName: input.operationName } : {}) }); },
    async markCompleted(input) { return update(input.operationId, input.requestSha256, { state: "completed", ...(input.generation ? { generation: input.generation } : {}), ...(input.resourceUid ? { resourceUid: input.resourceUid } : {}), ...(input.createTime ? { createTime: input.createTime } : {}), ...(input.owned === true ? { owned: true } : {}) }); },
  });
}

/** Durable local journal for a mounted persistent control-plane volume. Claiming
 * uses exclusive creates and mutation holds a short exclusive lock, so a fresh
 * process observes the original dispatch record instead of issuing a second
 * mutation. Production may provide a database-backed journal with identical
 * compare-and-set semantics. */
export function createFileGoogleOperationJournal(root: string): GoogleOperationJournal {
  const directory = z.string().min(1).parse(root);
  const recordPath = (operationId: string) => join(directory, `${OperationIdSchema.parse(operationId)}.json`);
  const decode = (text: string): GoogleOperationRecord => z.object({ operationId: OperationIdSchema, resource: z.string().min(1), requestSha256: DigestSchema, contentSha256: DigestSchema, state: z.enum(["claimed", "dispatching", "dispatched", "completed", "unknown"]), operationName: z.string().min(1).optional(), generation: z.string().min(1).optional(), ownershipMarker: z.string().min(1).optional(), resourceUid: z.string().min(1).optional(), createTime: z.string().min(1).optional(), owned: z.boolean() }).parse(JSON.parse(text));
  async function read(operationId: string): Promise<GoogleOperationRecord | undefined> { try { return Object.freeze(decode(await readFile(recordPath(operationId), "utf8"))); } catch (error) { if ((error as { code?: string }).code === "ENOENT") return undefined; throw new Error("GOOGLE_JOURNAL_READ_FAILED"); } }
  async function locked<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true }); const lock = `${recordPath(operationId)}.lock`;
    for (let attempts = 0; attempts < 100; attempts += 1) {
      try { const handle = await open(lock, "wx"); await handle.close(); try { return await action(); } finally { await unlink(lock).catch(() => undefined); } }
      catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw new Error("GOOGLE_JOURNAL_LOCK_FAILED"); await Bun.sleep(5); }
    }
    throw new Error("GOOGLE_JOURNAL_LOCK_TIMEOUT");
  }
  async function update(operationId: string, requestSha256: string, patch: Partial<GoogleOperationRecord>): Promise<GoogleOperationRecord> {
    return locked(operationId, async () => { const current = await read(operationId); if (!current || current.requestSha256 !== requestSha256) throw new Error("GOOGLE_JOURNAL_CAS_CONFLICT"); const next = Object.freeze({ ...current, ...patch }); const temporary = `${recordPath(operationId)}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, recordPath(operationId)); return next; });
  }
  return Object.freeze({
    async claim(input) { return locked(input.operationId, async () => { const prior = await read(input.operationId); if (prior) return Object.freeze({ claimed: false, record: prior }); const record = Object.freeze({ ...input, state: "claimed" as const }); const handle = await open(recordPath(input.operationId), "wx", 0o600); try { await handle.writeFile(JSON.stringify(record)); } finally { await handle.close(); } return Object.freeze({ claimed: true, record }); }); },
    read,
    async markDispatching(input) { return update(input.operationId, input.requestSha256, { state: "dispatching" }); },
    async markDispatched(input) { return update(input.operationId, input.requestSha256, { state: "dispatched", ...(input.operationName ? { operationName: input.operationName } : {}) }); },
    async markCompleted(input) { return update(input.operationId, input.requestSha256, { state: "completed", ...(input.generation ? { generation: input.generation } : {}), ...(input.resourceUid ? { resourceUid: input.resourceUid } : {}), ...(input.createTime ? { createTime: input.createTime } : {}), ...(input.owned === true ? { owned: true } : {}) }); },
  });
}

type GoogleClientOptions = Readonly<{
  projectId: string; quotaProjectId: string; principal: string; accountScopeSha256?: string;
  tokenSource?: GoogleTokenSource; fetch?: GoogleFetch; origins?: Partial<Record<ApiName, string>>;
  journal: GoogleOperationJournal; now?: () => number; timeoutMs?: number;
}>;

function statusFor(status: number): Readonly<{ status: "missing" | "unknown" | "blocked" }> {
  if (status === 404) return Object.freeze({ status: "missing" });
  if ([401, 403, 400, 409, 412].includes(status)) return Object.freeze({ status: "blocked" });
  if (status === 408 || status === 429 || status >= 500) return Object.freeze({ status: "unknown" });
  return Object.freeze({ status: "blocked" });
}
function origin(value: string, expected: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== expected) throw new Error("GOOGLE_CLIENT_ORIGIN_INVALID");
  return parsed.origin;
}
async function sha256(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Bytes(value: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", value as BufferSource);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function crc32cBase64(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  return btoa(String.fromCharCode((crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255));
}
function multipartObjectUpload(object: string, checksum: string, contentSha256: string, operationId: string, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const boundary = "napplet-cvm-google-json-upload";
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: object, crc32c: checksum, metadata: { "napplet-cvm-content-sha256": contentSha256, "napplet-cvm-operation": operationId } })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const output = new Uint8Array(prefix.byteLength + bytes.byteLength + suffix.byteLength); output.set(prefix); output.set(bytes, prefix.byteLength); output.set(suffix, prefix.byteLength + bytes.byteLength); return output;
}
async function readBoundedBytes(response: Response, timeoutMs = 5_000): Promise<Uint8Array> {
  const claimed = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(claimed) || claimed < 0 || claimed > 1_000_000) throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID");
  if (!response.body) throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0; const deadline = Date.now() + timeoutMs;
  const nextWithin = async (milliseconds: number) => { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("GOOGLE_CLIENT_TIMEOUT")), milliseconds); })]); } finally { if (timer !== undefined) clearTimeout(timer); } };
  let complete = false;
  try { for (;;) { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("GOOGLE_CLIENT_TIMEOUT"); const next = await nextWithin(remaining); if (next.done) { complete = true; break; } length += next.value.byteLength; if (length > 1_000_000) throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID"); chunks.push(next.value); } }
  finally { if (!complete) void reader.cancel(); reader.releaseLock(); }
  if (length === 0) throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID");
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function body(response: Response, timeoutMs = 5_000): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID");
  const bytes = await readBoundedBytes(response, timeoutMs);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("GOOGLE_CLIENT_RESPONSE_INVALID"); }
}

/** Official HTTPS control-plane transports. Defaults are actual ADC and fetch;
 * callers may inject deterministic ports only for local contract tests. */
export function createGoogleDeploymentClients(options: GoogleClientOptions) {
  const projectId = ProjectIdSchema.parse(options.projectId); const quotaProjectId = ProjectIdSchema.parse(options.quotaProjectId); const principal = z.string().regex(/^[A-Za-z0-9@._:/-]{3,255}$/u).parse(options.principal);
  const now = options.now ?? Date.now; const fetcher = options.fetch ?? fetch; const timeoutMs = options.timeoutMs ?? 5_000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("GOOGLE_CLIENT_TIMEOUT_INVALID");
  const origins = Object.freeze(Object.fromEntries((Object.keys(GOOGLE_API_ORIGINS) as ApiName[]).map((name) => [name, origin(options.origins?.[name] ?? GOOGLE_API_ORIGINS[name], GOOGLE_API_ORIGINS[name])])) as Record<ApiName, string>);
  /* Do not pass the transport fetch port into ADC construction: absence of an
   * explicit test port selects the official google-auth-library ADC chain. */
  const tokenSource = options.tokenSource ?? createGoogleAdcTokenSource({ projectId, quotaProjectId, principal, accountScopeSha256: options.accountScopeSha256, now });
  async function request(api: ApiName, path: string, method: "GET" | "POST" | "DELETE", payload?: unknown, headers: Record<string, string> = {}, rawBody?: BodyInit): Promise<Readonly<{ response: Response; payload?: unknown }>> {
    const token = await tokenSource.getAccessToken(); const scope = await googleAccountScopeSha256({ projectId, quotaProjectId, principal, scopes: token.scopes });
    if (token.projectId !== projectId || token.quotaProjectId !== quotaProjectId || token.principal !== principal || token.accountScopeSha256 !== scope || token.expiresAtMs - 60_000 <= now()) throw new Error("GOOGLE_CLIENT_ADC_SCOPE_INVALID");
    let response: Response; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { response = await Promise.race([fetcher(`${origins[api]}${path}`, { method, redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${token.token}`, "x-goog-user-project": quotaProjectId, accept: "application/json", ...(payload === undefined && rawBody === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(rawBody !== undefined ? { body: rawBody } : payload === undefined ? {} : { body: JSON.stringify(payload) }) }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("GOOGLE_CLIENT_TIMEOUT")); }, timeoutMs); })]); }
    catch { return Object.freeze({ response: new Response(null, { status: 503 }) }); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    if (!response.ok || response.status === 204 || response.headers.get("content-length") === "0") return Object.freeze({ response });
    try { return Object.freeze({ response, payload: await body(response, timeoutMs) }); }
    catch { controller.abort(); return Object.freeze({ response: new Response(null, { status: 503 }) }); }
  }
  /** Registry inspection is read-only and invoked only after the separate
   * authorized upload boundary. It cannot make an upload or deploy a service. */
  async function observeArtifactRegistryManifest(input: Readonly<{ imageReference: string; manifestDigest: string; configDigest: string; platform: Readonly<{ os: "linux"; architecture: "amd64" }> }>) {
    const image = ArtifactRegistryImagePattern.exec(ArtifactRegistryImageSchema.parse(input.imageReference));
    if (!image) throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID");
    const host = image[1]!.toLowerCase(), imageProject = image[2]!, repositoryPath = image[3]!, referenceDigest = `sha256:${image[4]!.toLowerCase()}`;
    if (imageProject !== projectId) throw new Error("GOOGLE_ARTIFACT_REGISTRY_PROJECT_SCOPE_INVALID");
    if (referenceDigest !== input.manifestDigest.toLowerCase()) throw new Error("GOOGLE_ARTIFACT_REGISTRY_MANIFEST_BINDING_INVALID");
    if (!/^sha256:[a-f0-9]{64}$/iu.test(input.configDigest) || input.platform.os !== "linux" || input.platform.architecture !== "amd64") throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID");
    const token = await tokenSource.getAccessToken(); const scope = await googleAccountScopeSha256({ projectId, quotaProjectId, principal, scopes: token.scopes });
    if (token.projectId !== projectId || token.quotaProjectId !== quotaProjectId || token.principal !== principal || token.accountScopeSha256 !== scope || token.expiresAtMs - 60_000 <= now()) throw new Error("GOOGLE_CLIENT_ADC_SCOPE_INVALID");
    const headers = { authorization: `Bearer ${token.token}`, "x-goog-user-project": quotaProjectId };
    const registryGet = async (path: string, accept: string) => {
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([fetcher(`https://${host}${path}`, { method: "GET", redirect: "error", signal: controller.signal, headers: { ...headers, accept } }), new Promise<Response>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("GOOGLE_CLIENT_TIMEOUT")); }, timeoutMs); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    };
    let manifestResponse: Response;
    try { manifestResponse = await registryGet(`/v2/${imageProject}/${repositoryPath}/manifests/${referenceDigest}`, "application/vnd.oci.image.manifest.v1+json"); }
    catch { throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_UNAVAILABLE"); }
    if (!manifestResponse.ok || manifestResponse.headers.get("docker-content-digest")?.toLowerCase() !== referenceDigest) throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_UNAVAILABLE");
    let manifest: unknown; let manifestBytes: Uint8Array;
    try { manifestBytes = await readBoundedBytes(manifestResponse, timeoutMs); manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch { throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID"); }
    if (`sha256:${await sha256Bytes(manifestBytes)}` !== referenceDigest) throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID");
    const parsedManifest = z.object({ schemaVersion: z.literal(2), mediaType: z.literal("application/vnd.oci.image.manifest.v1+json"), config: z.object({ mediaType: z.literal("application/vnd.oci.image.config.v1+json"), digest: z.literal(input.configDigest.toLowerCase()), size: z.number().int().nonnegative() }).strict() }).passthrough().safeParse(manifest);
    if (!parsedManifest.success) throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID");
    let configResponse: Response;
    try { configResponse = await registryGet(`/v2/${imageProject}/${repositoryPath}/blobs/${input.configDigest.toLowerCase()}`, "application/vnd.oci.image.config.v1+json"); }
    catch { throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_UNAVAILABLE"); }
    if (!configResponse.ok || configResponse.headers.get("docker-content-digest")?.toLowerCase() !== input.configDigest.toLowerCase()) throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_UNAVAILABLE");
    let config: unknown; let configBytes: Uint8Array;
    try { configBytes = await readBoundedBytes(configResponse, timeoutMs); config = JSON.parse(new TextDecoder().decode(configBytes)); } catch { throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID"); }
    if (`sha256:${await sha256Bytes(configBytes)}` !== input.configDigest.toLowerCase() || configBytes.byteLength !== parsedManifest.data.config.size) throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID");
    if (!z.object({ os: z.literal("linux"), architecture: z.literal("amd64") }).passthrough().safeParse(config).success) throw new Error("GOOGLE_ARTIFACT_REGISTRY_OBSERVATION_INVALID");
    return Object.freeze({ imageReference: input.imageReference, manifestDigest: input.manifestDigest.toLowerCase(), configDigest: input.configDigest.toLowerCase(), platform: Object.freeze({ os: "linux" as const, architecture: "amd64" as const }), observedAtMs: now() });
  }
  async function uploadArtifactRegistryImage(input: Readonly<{ operationId: string; image: PreparedCollectorOciUpload; expiresAtMs: number }>): Promise<Readonly<{ status: "completed" | "unknown" }>> {
    const operationId = DeploymentOperationIdSchema.parse(input.operationId);
    const image = input.image;
    const parsed = ArtifactRegistryImagePattern.exec(ArtifactRegistryImageSchema.parse(image.imageReference));
    if (!parsed || image.manifestDigest !== `sha256:${parsed[4]!.toLowerCase()}` || image.configDigest !== image.blobs[0]?.digest || image.platform.os !== "linux" || image.platform.architecture !== "amd64") throw new Error("GOOGLE_ARTIFACT_REGISTRY_UPLOAD_INVALID");
    const host = parsed[1]!.toLowerCase(), imageProject = parsed[2]!, repositoryPath = parsed[3]!;
    if (imageProject !== projectId || image.blobs.length < 1 || image.blobs.some(blob => !/^sha256:[a-f0-9]{64}$/iu.test(blob.digest) || blob.bytes.byteLength > 268_435_456)) throw new Error("GOOGLE_ARTIFACT_REGISTRY_UPLOAD_INVALID");
    if (`sha256:${await sha256Bytes(image.manifest)}` !== image.manifestDigest || (await Promise.all(image.blobs.map(async blob => `sha256:${await sha256Bytes(blob.bytes)}` === blob.digest))).some(valid => !valid)) throw new Error("GOOGLE_ARTIFACT_REGISTRY_UPLOAD_INVALID");
    const resource = `artifactregistry://${host}/${imageProject}/${repositoryPath}@${image.manifestDigest}`;
    const intent = { imageReference: image.imageReference, manifestDigest: image.manifestDigest, configDigest: image.configDigest, blobs: image.blobs.map(blob => ({ digest: blob.digest, mediaType: blob.mediaType, size: blob.bytes.byteLength })) };
    const claimed = await claim(operationId, resource, intent);
    const observe = async () => {
      try { await observeArtifactRegistryManifest({ imageReference: image.imageReference, manifestDigest: image.manifestDigest, configDigest: image.configDigest, platform: image.platform }); return true; }
      catch { return false; }
    };
    if (!claimed.claimed) {
      if (await observe()) { await options.journal.markCompleted({ operationId, requestSha256: claimed.requestSha256, resourceUid: image.manifestDigest, owned: true }); return Object.freeze({ status: "completed" as const }); }
      return Object.freeze({ status: "unknown" as const });
    }
    const assertCurrent = () => { if (!Number.isSafeInteger(input.expiresAtMs) || now() >= input.expiresAtMs) throw new Error("COLLECTOR_UPLOAD_AUTHORIZATION_EXPIRED"); };
    assertCurrent();
    await options.journal.markDispatching({ operationId, requestSha256: claimed.requestSha256 });
    const token = await tokenSource.getAccessToken(); const scope = await googleAccountScopeSha256({ projectId, quotaProjectId, principal, scopes: token.scopes });
    if (token.projectId !== projectId || token.quotaProjectId !== quotaProjectId || token.principal !== principal || token.accountScopeSha256 !== scope || token.expiresAtMs - 60_000 <= now()) throw new Error("GOOGLE_CLIENT_ADC_SCOPE_INVALID");
    const headers = { authorization: `Bearer ${token.token}`, "x-goog-user-project": quotaProjectId };
    const registryRequest = async (url: string, init: RequestInit) => {
      assertCurrent();
      const controller = new AbortController();
      const duration = Math.min(timeoutMs, input.expiresAtMs - now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([fetcher(url, { ...init, redirect: "error", signal: controller.signal }), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("GOOGLE_CLIENT_TIMEOUT")); }, duration); })]); }
      finally { clearTimeout(timer); }
    };
    const put = async (url: string, body: BodyInit, contentType: string) => registryRequest(url, { method: "PUT", headers: { ...headers, "content-type": contentType }, body });
    try {
      for (const blob of image.blobs) {
        const base = `https://${host}/v2/${imageProject}/${repositoryPath}`;
        const existing = await registryRequest(`${base}/blobs/${blob.digest}`, { method: "HEAD", headers });
        if (existing.status === 200) continue;
        if (existing.status !== 404) throw new Error("GOOGLE_ARTIFACT_REGISTRY_UPLOAD_UNAVAILABLE");
        const begin = await registryRequest(`${base}/blobs/uploads/`, { method: "POST", headers });
        const location = begin.headers.get("location");
        if (![201, 202].includes(begin.status) || !location) throw new Error("GOOGLE_ARTIFACT_REGISTRY_UPLOAD_UNAVAILABLE");
        const target = new URL(location, base);
        if (target.protocol !== "https:" || target.host !== host) throw new Error("GOOGLE_ARTIFACT_REGISTRY_UPLOAD_LOCATION_INVALID");
        target.searchParams.set("digest", blob.digest);
        const uploaded = await put(target.toString(), new Uint8Array(blob.bytes).buffer, blob.mediaType);
        if (![201, 202].includes(uploaded.status) || uploaded.headers.get("docker-content-digest")?.toLowerCase() !== blob.digest) throw new Error("GOOGLE_ARTIFACT_REGISTRY_UPLOAD_UNAVAILABLE");
      }
      const manifest = await put(`https://${host}/v2/${imageProject}/${repositoryPath}/manifests/${image.manifestDigest}`, new Uint8Array(image.manifest).buffer, image.manifestMediaType);
      if (![200, 201].includes(manifest.status) || manifest.headers.get("docker-content-digest")?.toLowerCase() !== image.manifestDigest) throw new Error("GOOGLE_ARTIFACT_REGISTRY_UPLOAD_UNAVAILABLE");
    } catch {
      return Object.freeze({ status: "unknown" as const });
    }
    await options.journal.markDispatched({ operationId, requestSha256: claimed.requestSha256 });
    if (!await observe()) return Object.freeze({ status: "unknown" as const });
    await options.journal.markCompleted({ operationId, requestSha256: claimed.requestSha256, resourceUid: image.manifestDigest, owned: true });
    return Object.freeze({ status: "completed" as const });
  }
  async function claim(operationId: string, resource: string, payload: unknown, content: unknown = payload) {
    const requestSha256 = await sha256(payload); const contentSha256 = await sha256(content);
    const claimed = await options.journal.claim({ operationId, resource, requestSha256, contentSha256, ownershipMarker: operationId, owned: false });
    if (!claimed.claimed && (claimed.record.resource !== resource || claimed.record.requestSha256 !== requestSha256 || claimed.record.contentSha256 !== contentSha256)) throw new Error("GOOGLE_JOURNAL_IDENTITY_CONFLICT");
    return Object.freeze({ ...claimed, requestSha256 });
  }

  const cloudRun = Object.freeze({ projectId,
    async deploy(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string; imageReference: string; serviceAccountReference: string; environmentReferenceSha256: string; secretReferences: readonly Readonly<{ name: string; secret: string; version: string }>[]; minimumInstances: 3; ingress: "internal-and-cloud-load-balancing"; concurrency: number; admissionRefusal: "capacity_unavailable"; containerPort?: number }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); if (ProjectIdSchema.parse(input.projectId) !== projectId) throw new Error("GOOGLE_CLIENT_PROJECT_SCOPE_INVALID");
      const region = RegionSchema.parse(input.region); const serviceName = ServiceNameSchema.parse(input.serviceName); const resource = `projects/${projectId}/locations/${region}/services/${serviceName}`;
      const secrets = z.array(z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]{1,62}$/u), secret: z.string().min(3).max(255), version: z.string().regex(/^[1-9][0-9]*$/u) })).min(1).parse(input.secretReferences);
      if (new Set(secrets.map((secret) => secret.name)).size !== secrets.length) throw new Error("GOOGLE_CLOUD_RUN_SECRET_CONFIG_INVALID");
      const imageReference = ImageReferenceSchema.parse(input.imageReference); const containerPort = input.containerPort === undefined ? undefined : z.number().int().min(1).max(65_535).parse(input.containerPort);
      const env = [{ name: "GOOGLE_CLOUD_PROJECT", value: projectId }, { name: "NAPPLET_CVM_ENVIRONMENT_SHA256", value: DigestSchema.parse(input.environmentReferenceSha256) }, ...secrets.map((secret) => ({ name: secret.name, valueSource: { secretKeyRef: { secret: secret.secret, version: secret.version } } }))];
      const service = { labels: { "napplet-cvm-operation": operationId }, ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", scaling: PRODUCTION_CLOUD_RUN_SERVICE_SCALING, template: { scaling: { minInstanceCount: z.literal(3).parse(input.minimumInstances), maxInstanceCount: PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.maximumInstances }, maxInstanceRequestConcurrency: z.number().int().min(1).max(1000).parse(input.concurrency), serviceAccount: z.string().min(3).max(255).parse(input.serviceAccountReference), containers: [{ image: imageReference, resources: PRODUCTION_CLOUD_RUN_RESOURCES, ...(containerPort === undefined ? {} : { ports: [{ containerPort }] }), env }] } };
      const prior = await options.journal.read(operationId); if (prior && prior.requestSha256 !== await sha256(service)) return Object.freeze({ status: "blocked" });
      const observed = await request("cloudRun", `/v2/${resource}`, "GET");
      if (observed.response.ok) {
        const matching = z.object({ name: z.literal(resource), uid: z.string().min(1), createTime: z.string().min(1), generation: z.string().min(1), observedGeneration: z.string().min(1), reconciling: z.literal(false), terminalCondition: z.object({ state: z.literal("CONDITION_SUCCEEDED") }).passthrough(), labels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough(), ingress: z.literal("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"), scaling: CloudRunServiceScalingSchema, template: z.object({ scaling: CloudRunRevisionScalingSchema, maxInstanceRequestConcurrency: z.literal(input.concurrency), serviceAccount: z.literal(input.serviceAccountReference), containers: z.array(z.object({ image: z.literal(imageReference), resources: CloudRunResourceRequirementsSchema, ...(containerPort === undefined ? {} : { ports: z.array(z.object({ containerPort: z.literal(containerPort) }).passthrough()).length(1) }), env: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough()).length(1) }).passthrough() }).passthrough().safeParse(observed.payload);
        if (matching.success) {
          const observedEnv = (matching.data.template.containers[0]?.env ?? []) as readonly Readonly<{ name?: string; value?: string; valueSource?: { secretKeyRef?: { secret?: string; version?: string } } }> [];
          const required = new Map(env.map((entry) => [entry.name, entry]));
          const configMatches = observedEnv.length === required.size && new Set(observedEnv.map((entry) => entry.name)).size === observedEnv.length && [...required.entries()].every(([name, expected]) => observedEnv.some((actual) => actual.name === name && ("value" in expected ? actual.value === expected.value : actual.valueSource?.secretKeyRef?.secret === expected.valueSource.secretKeyRef.secret && actual.valueSource?.secretKeyRef?.version === expected.valueSource.secretKeyRef.version)));
          const priorIdentityMatches = !prior?.owned || (prior.resourceUid === matching.data.uid && prior.createTime === matching.data.createTime);
          return configMatches && priorIdentityMatches && matching.data.generation === matching.data.observedGeneration ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
        }
        return Object.freeze({ status: "unknown" });
      }
      if (observed.response.status !== 404) return statusFor(observed.response.status);
      const claimed = await claim(operationId, resource, service);
      if (!claimed.claimed) return Object.freeze({ status: "unknown" });
      await options.journal.markDispatching({ operationId, requestSha256: claimed.requestSha256 });
      const created = await request("cloudRun", `/v2/projects/${projectId}/locations/${region}/services?serviceId=${encodeURIComponent(serviceName)}`, "POST", service);
      if (!created.response.ok) return statusFor(created.response.status);
      const operation = z.object({ name: z.string().startsWith(`projects/${projectId}/locations/${region}/operations/`) }).passthrough().safeParse(created.payload);
      if (!operation.success) return Object.freeze({ status: "unknown" });
      await options.journal.markDispatched({ operationId, requestSha256: claimed.requestSha256, operationName: operation.data.name });
      return Object.freeze({ status: "pending" });
    },
    async observe(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string; imageReference: string; serviceAccountReference: string; environmentReferenceSha256: string; secretReferences: readonly Readonly<{ name: string; secret: string; version: string }>[]; concurrency: number; containerPort?: number }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); if (ProjectIdSchema.safeParse(input.projectId).data !== projectId) return Object.freeze({ status: "blocked" });
      const region = RegionSchema.safeParse(input.region); const serviceName = ServiceNameSchema.safeParse(input.serviceName); if (!region.success || !serviceName.success) return Object.freeze({ status: "blocked" });
      const resource = `projects/${projectId}/locations/${region.data}/services/${serviceName.data}`;
      const original = await options.journal.read(operationId); if (!original || original.resource !== resource) return Object.freeze({ status: "blocked" });
      if (original.operationName) {
        const operation = await request("cloudRun", `/v2/${original.operationName}`, "GET");
        if (!operation.response.ok) return statusFor(operation.response.status);
        const terminal = z.object({ done: z.boolean().optional(), error: z.unknown().optional() }).passthrough().safeParse(operation.payload);
        if (!terminal.success || terminal.data.error !== undefined) return Object.freeze({ status: "unknown" });
        if (terminal.data.done !== true) return Object.freeze({ status: "pending" });
      }
      const reconciled = await cloudRun.deploy({ operationId, projectId, region: region.data, serviceName: serviceName.data, imageReference: input.imageReference, serviceAccountReference: input.serviceAccountReference, environmentReferenceSha256: input.environmentReferenceSha256, secretReferences: input.secretReferences, minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: input.concurrency, admissionRefusal: "capacity_unavailable", ...(input.containerPort === undefined ? {} : { containerPort: input.containerPort }) });
      if (reconciled.status === "completed") {
        const service = await request("cloudRun", `/v2/${resource}`, "GET"); const identity = z.object({ uid: z.string().min(1), createTime: z.string().min(1) }).passthrough().safeParse(service.payload);
        if (!identity.success || (original.owned && (!original.resourceUid || !original.createTime || original.resourceUid !== identity.data.uid || original.createTime !== identity.data.createTime))) return Object.freeze({ status: "unknown" });
        if (original.owned) return Object.freeze({ status: "completed" });
        if (original.state === "completed") return Object.freeze({ status: "unknown" });
        await options.journal.markCompleted({ operationId, requestSha256: original.requestSha256, resourceUid: identity.data.uid, createTime: identity.data.createTime, owned: true });
      }
      return reconciled;
    },
    /** Reconcile cleanup without claiming or dispatching it.  In particular, a
     * caller recovering after a lost DELETE acknowledgement may only inspect
     * the original identity, the recorded deletion LRO, and the resource. */
    async observeCleanup(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const region = RegionSchema.parse(input.region); const serviceName = ServiceNameSchema.parse(input.serviceName); if (ProjectIdSchema.parse(input.projectId) !== projectId) throw new Error("GOOGLE_CLIENT_PROJECT_SCOPE_INVALID");
      const resource = `projects/${projectId}/locations/${region}/services/${serviceName}`;
      const original = await options.journal.read(operationId);
      if (!original?.owned || !original.resourceUid || !original.createTime || original.resource !== resource) throw new Error("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
      const current = await request("cloudRun", `/v2/${resource}`, "GET");
      /* A service absent after a recorded, owned original operation is the
       * only terminal cleanup proof.  Do not require a cleanup journal record:
       * the process may have died between provider completion and its ACK. */
      if (current.response.status === 404) return Object.freeze({ status: "completed" });
      if (!current.response.ok) return statusFor(current.response.status);
      const ownedService = z.object({ name: z.literal(resource), uid: z.literal(original.resourceUid), createTime: z.literal(original.createTime), labels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough().safeParse(current.payload);
      /* A same-name recreation is never ours to delete and can never become a
       * cleaned result merely because an earlier name was removed. */
      if (!ownedService.success) return Object.freeze({ status: "unknown" });
      const cleanup = await options.journal.read(`${operationId}-cleanup`);
      if (!cleanup) return Object.freeze({ status: "missing" });
      if (!cleanup.operationName) return cleanup.state === "completed" ? Object.freeze({ status: "pending" }) : Object.freeze({ status: "unknown" });
      const deletion = await request("cloudRun", `/v2/${cleanup.operationName}`, "GET");
      if (!deletion.response.ok) return statusFor(deletion.response.status);
      const terminal = z.object({ done: z.boolean().optional(), error: z.unknown().optional() }).passthrough().safeParse(deletion.payload);
      if (!terminal.success || terminal.data.error !== undefined) return Object.freeze({ status: "unknown" });
      if (terminal.data.done !== true) return Object.freeze({ status: "pending" });
      const absent = await request("cloudRun", `/v2/${resource}`, "GET");
      if (absent.response.status === 404) return Object.freeze({ status: "completed" });
      return absent.response.ok ? Object.freeze({ status: "pending" }) : statusFor(absent.response.status);
    },
    async cleanup(input: Readonly<{ operationId: string; projectId: string; region: string; serviceName: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const region = RegionSchema.parse(input.region); const serviceName = ServiceNameSchema.parse(input.serviceName); if (ProjectIdSchema.parse(input.projectId) !== projectId) throw new Error("GOOGLE_CLIENT_PROJECT_SCOPE_INVALID");
      const resource = `projects/${projectId}/locations/${region}/services/${serviceName}`; const original = await options.journal.read(operationId); if (!original?.owned || !original.resourceUid || !original.createTime || original.resource !== resource) throw new Error("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
      const before = await request("cloudRun", `/v2/${resource}`, "GET"); if (before.response.status === 404) return Object.freeze({ status: "completed" }); if (!before.response.ok) return statusFor(before.response.status);
      const ownedService = z.object({ name: z.literal(resource), etag: z.string().min(1), uid: z.literal(original.resourceUid), createTime: z.literal(original.createTime), labels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough().safeParse(before.payload); if (!ownedService.success) return Object.freeze({ status: "unknown" });
      const cleanupId = `${operationId}-cleanup`; const priorCleanup = await options.journal.read(cleanupId);
      if (priorCleanup) {
        /* A completed local record is not proof that a same-name service is
         * absent: provider observation is the only completion authority. */
        if (!priorCleanup.operationName) return priorCleanup.state === "completed" ? Object.freeze({ status: "pending" }) : Object.freeze({ status: "unknown" });
        const deletion = await request("cloudRun", `/v2/${priorCleanup.operationName}`, "GET"); if (!deletion.response.ok) return statusFor(deletion.response.status);
        const terminal = z.object({ done: z.boolean().optional(), error: z.unknown().optional() }).passthrough().safeParse(deletion.payload); if (!terminal.success || terminal.data.error !== undefined) return Object.freeze({ status: "unknown" }); if (terminal.data.done !== true) return Object.freeze({ status: "pending" });
        const absent = await request("cloudRun", `/v2/${resource}`, "GET"); if (absent.response.status !== 404) return absent.response.ok ? Object.freeze({ status: "pending" }) : statusFor(absent.response.status); await options.journal.markCompleted({ operationId: cleanupId, requestSha256: priorCleanup.requestSha256 }); return Object.freeze({ status: "completed" });
      }
      const cleanup = await claim(cleanupId, resource, { method: "delete", etag: ownedService.data.etag });
      if (!cleanup.claimed) {
        if (cleanup.record.state === "completed") return Object.freeze({ status: "pending" });
        if (!cleanup.record.operationName) return Object.freeze({ status: "unknown" });
        const deletion = await request("cloudRun", `/v2/${cleanup.record.operationName}`, "GET"); if (!deletion.response.ok) return statusFor(deletion.response.status);
        const terminal = z.object({ done: z.boolean().optional(), error: z.unknown().optional() }).passthrough().safeParse(deletion.payload); if (!terminal.success || terminal.data.error !== undefined) return Object.freeze({ status: "unknown" }); if (terminal.data.done !== true) return Object.freeze({ status: "pending" });
        const absent = await request("cloudRun", `/v2/${resource}`, "GET"); if (absent.response.status !== 404) return absent.response.ok ? Object.freeze({ status: "pending" }) : statusFor(absent.response.status);
        await options.journal.markCompleted({ operationId: cleanupId, requestSha256: cleanup.requestSha256 }); return Object.freeze({ status: "completed" });
      }
      await options.journal.markDispatching({ operationId: cleanupId, requestSha256: cleanup.requestSha256 }); const deleted = await request("cloudRun", `/v2/${resource}?etag=${encodeURIComponent(ownedService.data.etag)}`, "DELETE");
      if (!deleted.response.ok) return statusFor(deleted.response.status);
      const deletionOperation = z.object({ name: z.string().startsWith(`projects/${projectId}/locations/${region}/operations/`) }).passthrough().safeParse(deleted.payload); if (!deletionOperation.success) return Object.freeze({ status: "unknown" }); await options.journal.markDispatched({ operationId: cleanupId, requestSha256: cleanup.requestSha256, operationName: deletionOperation.data.name });
      const observed = await request("cloudRun", `/v2/${resource}`, "GET");
      if (observed.response.status === 404) { await options.journal.markCompleted({ operationId: cleanupId, requestSha256: cleanup.requestSha256 }); return Object.freeze({ status: "completed" }); }
      return observed.response.ok ? Object.freeze({ status: "pending" }) : statusFor(observed.response.status);
    },
  });

  const gcs = Object.freeze({ projectId,
    async observeBucketPolicy(input: Readonly<{ bucket: string; encryptionKeyReference: string }>): Promise<SafeStatus> {
      const bucket = BucketSchema.parse(input.bucket); const response = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}`, "GET"); if (!response.response.ok) return statusFor(response.response.status);
      const policy = z.object({ location: z.literal("NAM4"), versioning: z.object({ enabled: z.literal(true) }), encryption: z.object({ defaultKmsKeyName: z.literal(input.encryptionKeyReference) }), retentionPolicy: z.object({ retentionPeriod: z.literal("2592000"), isLocked: z.boolean().optional() }), softDeletePolicy: z.object({ retentionDurationSeconds: z.literal("0") }).optional(), lifecycle: z.object({ rule: z.array(z.object({ action: z.object({ type: z.literal("Delete") }), condition: z.object({ age: z.number().int().optional(), numNewerVersions: z.number().int().positive().optional() }).passthrough() }).passthrough()).min(2) }) }).passthrough().safeParse(response.payload);
      if (!policy.success || policy.data.retentionPolicy.isLocked === true) return Object.freeze({ status: "blocked" });
      const rules = policy.data.lifecycle.rule;
      const exactExpiry = rules.some((rule) => rule.condition.age === 30 && JSON.stringify(Object.keys(rule.condition).sort()) === JSON.stringify(["age"]));
      const exactOldVersionExpiry = rules.some((rule) => rule.condition.numNewerVersions === 1 && JSON.stringify(Object.keys(rule.condition).sort()) === JSON.stringify(["numNewerVersions"]));
      return exactExpiry && exactOldVersionExpiry ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "blocked" });
    },
    async provisionBucket(input: Readonly<{ operationId: string; bucket: string; encryptionKeyReference: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const bucket = BucketSchema.parse(input.bucket);
      const resource = `b/${bucket}`;
      const policy = { name: bucket, labels: { "napplet-cvm-operation": operationId }, location: "NAM4", versioning: { enabled: true }, encryption: { defaultKmsKeyName: input.encryptionKeyReference }, retentionPolicy: { retentionPeriod: "2592000" }, softDeletePolicy: { retentionDurationSeconds: "0" }, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 30 } }, { action: { type: "Delete" }, condition: { numNewerVersions: 1 } }] } };
      const claimed = await claim(operationId, resource, policy);
      const existing = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}`, "GET");
      if (existing.response.ok) {
        const owned = z.object({ timeCreated: z.string().min(1), labels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough().safeParse(existing.payload);
        const policyStatus = await gcs.observeBucketPolicy({ bucket, encryptionKeyReference: input.encryptionKeyReference });
        /* A fresh local claim does not prove a pre-existing same-label bucket
         * is ours. Only a prior dispatched run or an already owned record may
         * bind provider identity and become cleanup-authorized. */
        const priorMutation = claimed.record.state === "dispatching" || claimed.record.state === "dispatched";
        if (owned.success && policyStatus.status === "completed" && claimed.record.owned) return claimed.record.createTime === owned.data.timeCreated ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
        if (owned.success && policyStatus.status === "completed" && priorMutation) { await options.journal.markCompleted({ operationId, requestSha256: claimed.requestSha256, createTime: owned.data.timeCreated, owned: true }); return Object.freeze({ status: "completed" }); }
        return Object.freeze({ status: "blocked" });
      }
      if (existing.response.status !== 404) return statusFor(existing.response.status);
      if (!claimed.claimed) return Object.freeze({ status: "unknown" });
      await options.journal.markDispatching({ operationId, requestSha256: claimed.requestSha256 });
      const created = await request("storage", `/storage/v1/b?project=${encodeURIComponent(projectId)}`, "POST", policy);
      if (!created.response.ok) return statusFor(created.response.status);
      const verified = await gcs.observeBucketPolicy({ bucket, encryptionKeyReference: input.encryptionKeyReference });
      if (verified.status !== "completed") return verified;
      const current = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}`, "GET");
      const identity = z.object({ timeCreated: z.string().min(1), labels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough().safeParse(current.payload);
      if (!current.response.ok || !identity.success) return current.response.ok ? Object.freeze({ status: "unknown" }) : statusFor(current.response.status);
      await options.journal.markCompleted({ operationId, requestSha256: claimed.requestSha256, createTime: identity.data.timeCreated, owned: true });
      return Object.freeze({ status: "completed" });
    },
    async cleanupBucket(input: Readonly<{ operationId: string; bucket: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const bucket = BucketSchema.parse(input.bucket); const resource = `b/${bucket}`; const original = await options.journal.read(operationId); if (!original?.owned || !original.createTime || original.resource !== resource) throw new Error("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
      const before = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}`, "GET"); if (before.response.status === 404) return Object.freeze({ status: "completed" }); if (!before.response.ok) return statusFor(before.response.status);
      const owned = z.object({ timeCreated: z.literal(original.createTime), metageneration: z.string().regex(/^\d+$/u), labels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough().safeParse(before.payload); if (!owned.success) return Object.freeze({ status: "unknown" });
      const cleanupId = `${operationId}-cleanup`; const cleanup = await claim(cleanupId, resource, { method: "delete", timeCreated: owned.data.timeCreated, metageneration: owned.data.metageneration }); if (!cleanup.claimed) return cleanup.record.state === "completed" ? Object.freeze({ status: "pending" }) : Object.freeze({ status: "unknown" });
      await options.journal.markDispatching({ operationId: cleanupId, requestSha256: cleanup.requestSha256 }); const deleted = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}?ifMetagenerationMatch=${encodeURIComponent(owned.data.metageneration)}`, "DELETE"); if (!deleted.response.ok && deleted.response.status !== 404) return statusFor(deleted.response.status);
      const absent = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}`, "GET"); if (absent.response.status !== 404) return absent.response.ok ? Object.freeze({ status: "pending" }) : statusFor(absent.response.status); await options.journal.markCompleted({ operationId: cleanupId, requestSha256: cleanup.requestSha256 }); return Object.freeze({ status: "completed" });
    },
    async writeArtifact(input: Readonly<{ operationId: string; bucket: string; object: string; bytesBase64: string; checksum: string; encryptionKeyReference: string; location: "nam4"; versioning: true; retentionDays: 30 }>) {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const bucket = BucketSchema.parse(input.bucket); const object = ObjectSchema.parse(input.object);
      if (input.location !== "nam4" || input.versioning !== true || input.retentionDays !== 30 || !/^[A-Za-z0-9+/]{6,}={0,2}$/u.test(input.checksum)) throw new Error("GOOGLE_GCS_POLICY_INVALID");
      if ((await gcs.observeBucketPolicy({ bucket, encryptionKeyReference: input.encryptionKeyReference })).status !== "completed") throw new Error("GOOGLE_GCS_BUCKET_POLICY_INVALID");
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(input.bytesBase64), (character) => character.charCodeAt(0)); } catch { throw new Error("GOOGLE_GCS_BYTES_INVALID"); }
      if (bytes.byteLength === 0 || bytes.byteLength > 1_000_000) throw new Error("GOOGLE_GCS_BYTES_INVALID");
      if (crc32cBase64(bytes) !== input.checksum) throw new Error("GOOGLE_GCS_CHECKSUM_INVALID");
      const contentSha256 = await sha256([...bytes]); const resource = `b/${bucket}/o/${object}`;
      const claimed = await claim(operationId, resource, { object, checksum: input.checksum, encryptionKeyReference: input.encryptionKeyReference, contentSha256 }, bytes);
      const existing = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`, "GET");
      if (existing.response.ok) { const observed = z.object({ generation: z.string(), crc32c: z.literal(input.checksum), kmsKeyName: z.literal(input.encryptionKeyReference), metadata: z.object({ "napplet-cvm-content-sha256": z.literal(contentSha256), "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough().safeParse(existing.payload); if (observed.success && (!claimed.record.generation || claimed.record.generation === observed.data.generation)) { await options.journal.markCompleted({ operationId, requestSha256: claimed.requestSha256, generation: observed.data.generation, owned: true }); return Object.freeze({ status: "completed" as const, generation: observed.data.generation, checksum: observed.data.crc32c }); } return Object.freeze({ status: "blocked" as const }); }
      if (existing.response.status !== 404) return Object.freeze(statusFor(existing.response.status));
      if (!claimed.claimed) {
        const prior = claimed.record.generation ? await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?generation=${encodeURIComponent(claimed.record.generation)}`, "GET") : undefined;
        if (prior?.response.ok && z.object({ generation: z.literal(claimed.record.generation), crc32c: z.literal(input.checksum), kmsKeyName: z.literal(input.encryptionKeyReference) }).passthrough().safeParse(prior.payload).success) return Object.freeze({ status: "completed" as const, generation: claimed.record.generation!, checksum: input.checksum });
        return Object.freeze({ status: "unknown" as const });
      }
      await options.journal.markDispatching({ operationId, requestSha256: claimed.requestSha256 });
      const uploaded = await request("storage", `/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=multipart&ifGenerationMatch=0&kmsKeyName=${encodeURIComponent(input.encryptionKeyReference)}`, "POST", undefined, { "content-type": "multipart/related; boundary=napplet-cvm-google-json-upload" }, multipartObjectUpload(object, input.checksum, contentSha256, operationId, bytes));
      if (!uploaded.response.ok) return Object.freeze(statusFor(uploaded.response.status)); const stored = z.object({ generation: z.string().regex(/^\d+$/u), crc32c: z.literal(input.checksum), kmsKeyName: z.literal(input.encryptionKeyReference) }).passthrough().safeParse(uploaded.payload);
      if (!stored.success) return Object.freeze({ status: "unknown" as const });
      const exact = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?generation=${encodeURIComponent(stored.data.generation)}`, "GET");
      if (!exact.response.ok) return Object.freeze(statusFor(exact.response.status));
      const observed = z.object({ generation: z.literal(stored.data.generation), crc32c: z.literal(input.checksum), kmsKeyName: z.literal(input.encryptionKeyReference), metadata: z.object({ "napplet-cvm-content-sha256": z.literal(contentSha256), "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough().safeParse(exact.payload);
      if (!observed.success) return Object.freeze({ status: "unknown" as const });
      await options.journal.markCompleted({ operationId, requestSha256: claimed.requestSha256, generation: observed.data.generation, owned: true });
      return Object.freeze({ status: "completed" as const, generation: observed.data.generation, checksum: observed.data.crc32c });
    },
    async cleanupArtifact(input: Readonly<{ operationId: string; bucket: string; object: string; generation: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const bucket = BucketSchema.parse(input.bucket); const object = ObjectSchema.parse(input.object); const generation = z.string().regex(/^\d+$/u).parse(input.generation); const resource = `b/${bucket}/o/${object}`;
      const original = await options.journal.read(operationId); if (!original?.owned || original.resource !== resource || original.generation !== generation) throw new Error("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
      const current = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?generation=${encodeURIComponent(generation)}`, "GET"); if (current.response.status === 404) return Object.freeze({ status: "completed" }); if (!current.response.ok) return statusFor(current.response.status);
      const cleanupId = `${operationId}-cleanup`; const cleanup = await claim(cleanupId, resource, { method: "delete", generation }); if (!cleanup.claimed) return cleanup.record.state === "completed" ? Object.freeze({ status: "pending" }) : Object.freeze({ status: "unknown" });
      await options.journal.markDispatching({ operationId: cleanupId, requestSha256: cleanup.requestSha256 }); const deleted = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?generation=${encodeURIComponent(generation)}&ifGenerationMatch=${encodeURIComponent(generation)}`, "DELETE");
      if (!deleted.response.ok && deleted.response.status !== 404) return statusFor(deleted.response.status);
      const observed = await request("storage", `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?generation=${encodeURIComponent(generation)}`, "GET"); if (observed.response.status !== 404) return observed.response.ok ? Object.freeze({ status: "pending" }) : statusFor(observed.response.status);
      await options.journal.markCompleted({ operationId: cleanupId, requestSha256: cleanup.requestSha256 }); return Object.freeze({ status: "completed" });
    },
  });

  const cloudSqlPostgres = Object.freeze({ projectId,
    /** Read-only address observation for an already-owned restore instance.
     * The returned RFC1918 address is never accepted from configuration. */
    async observePrivateAddress(input: Readonly<{ instanceId: string }>): Promise<Readonly<{ status: "completed"; privateAddress: string }> | SafeStatus> {
      const instanceId = InstanceSchema.parse(input.instanceId);
      const instance = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "GET");
      if (!instance.response.ok) return statusFor(instance.response.status);
      const observed = z.object({ name: z.literal(instanceId), state: z.literal("RUNNABLE"), ipAddresses: z.array(z.object({ type: z.literal("PRIVATE"), ipAddress: z.string().regex(/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[0-1])\.)/u) }).passthrough()).min(1) }).passthrough().safeParse(instance.payload);
      if (!observed.success) return Object.freeze({ status: "unknown" });
      const addresses = [...new Set(observed.data.ipAddresses.map(item => item.ipAddress))];
      return addresses.length === 1 ? Object.freeze({ status: "completed" as const, privateAddress: addresses[0]! }) : Object.freeze({ status: "unknown" });
    },
    async provision(input: Readonly<{ operationId: string; instanceId: string; region: string; databaseVersion: "POSTGRES_17"; availabilityType: "REGIONAL"; tier: string; privateNetwork: string; storageGb?: number; requireSsl: true; serializablePolicy: true }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const instanceId = InstanceSchema.parse(input.instanceId); const region = RegionSchema.parse(input.region); const storageGb = input.storageGb === undefined ? undefined : z.number().int().min(10).max(65_536).parse(input.storageGb); if (input.databaseVersion !== "POSTGRES_17" || input.availabilityType !== "REGIONAL" || input.serializablePolicy !== true || !/^db-custom-[1-9][0-9]*-[1-9][0-9]*$/u.test(input.tier) || !/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/global\/networks\/[a-z][a-z0-9-]{0,62}$/u.test(input.privateNetwork) || input.requireSsl !== true) throw new Error("GOOGLE_CLOUD_SQL_AUTHORITY_INVALID");
      const resource = `projects/${projectId}/instances/${instanceId}`;
      const instance = { name: instanceId, region, databaseVersion: "POSTGRES_17", settings: { tier: input.tier, availabilityType: "REGIONAL", ...(storageGb === undefined ? {} : { dataDiskSizeGb: storageGb }), userLabels: { "napplet-cvm-operation": operationId }, backupConfiguration: { enabled: true }, ipConfiguration: { privateNetwork: input.privateNetwork, ipv4Enabled: false, requireSsl: true }, databaseFlags: [{ name: "default_transaction_isolation", value: "serializable" }] } };
      /* Claim and compare intent before considering an existing resource
       * complete. This prevents a same-name, same-label instance from
       * satisfying a later request with altered authority settings. */
      const claimed = await claim(operationId, resource, instance);
      const existing = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "GET");
      if (existing.response.ok) {
        const matching = z.object({ name: z.literal(instanceId), createTime: z.string().min(1), region: z.literal(region), databaseVersion: z.literal("POSTGRES_17"), state: z.literal("RUNNABLE"), settings: z.object({ availabilityType: z.literal("REGIONAL"), tier: z.literal(input.tier), ...(storageGb === undefined ? {} : { dataDiskSizeGb: z.literal(storageGb) }), userLabels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough(), backupConfiguration: z.object({ enabled: z.literal(true) }).passthrough(), ipConfiguration: z.object({ privateNetwork: z.literal(input.privateNetwork), ipv4Enabled: z.literal(false), requireSsl: z.literal(true) }).passthrough(), databaseFlags: z.array(z.object({ name: z.literal("default_transaction_isolation"), value: z.literal("serializable") })).min(1) }).passthrough() }).passthrough().safeParse(existing.payload);
        const priorMutation = claimed.record.state === "dispatching" || claimed.record.state === "dispatched";
        if (!matching.success) return Object.freeze({ status: "unknown" });
        if (claimed.record.owned) return claimed.record.createTime === matching.data.createTime ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
        if (!priorMutation) return Object.freeze({ status: "unknown" });
        await options.journal.markCompleted({ operationId, requestSha256: claimed.requestSha256, createTime: matching.data.createTime, owned: true });
        return Object.freeze({ status: "completed" });
      }
      if (existing.response.status !== 404) return statusFor(existing.response.status);
      if (!claimed.claimed) return Object.freeze({ status: "unknown" }); await options.journal.markDispatching({ operationId, requestSha256: claimed.requestSha256 });
      const created = await request("cloudSql", `/v1/projects/${projectId}/instances`, "POST", instance); if (!created.response.ok) return statusFor(created.response.status); const operation = z.object({ name: z.string().min(1) }).passthrough().safeParse(created.payload); if (!operation.success) return Object.freeze({ status: "unknown" }); await options.journal.markDispatched({ operationId, requestSha256: claimed.requestSha256, operationName: operation.data.name }); return Object.freeze({ status: "pending" });
    },
    /** Cloud SQL clone is a fresh, independent copy of the source.  A clone
     * response is never enough to adopt a destination: the original journal
     * operation and its LRO must both agree before it becomes owned. */
    async clone(input: Readonly<{ operationId: string; sourceInstanceId: string; destinationInstanceId: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const sourceInstanceId = InstanceSchema.parse(input.sourceInstanceId); const destinationInstanceId = InstanceSchema.parse(input.destinationInstanceId);
      if (sourceInstanceId === destinationInstanceId) throw new Error("GOOGLE_CLOUD_SQL_CLONE_SOURCE_DESTINATION_INVALID");
      const resource = `projects/${projectId}/instances/${destinationInstanceId}`;
      const intent = { cloneContext: { kind: "sql#cloneContext", destinationInstanceName: destinationInstanceId } };
      const claimed = await claim(operationId, resource, { sourceInstanceId, destinationInstanceId, intent });
      const destination = await request("cloudSql", `/v1/projects/${projectId}/instances/${destinationInstanceId}`, "GET");
      if (destination.response.ok) {
        const observed = z.object({ name: z.literal(destinationInstanceId), createTime: z.string().min(1), state: z.literal("RUNNABLE") }).passthrough().safeParse(destination.payload);
        if (!observed.success || !(claimed.record.state === "dispatching" || claimed.record.state === "dispatched" || claimed.record.state === "completed")) return Object.freeze({ status: "unknown" });
        if (claimed.record.owned) return claimed.record.createTime === observed.data.createTime ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
        await options.journal.markCompleted({ operationId, requestSha256: claimed.requestSha256, createTime: observed.data.createTime, owned: true }); return Object.freeze({ status: "completed" });
      }
      if (destination.response.status !== 404) return statusFor(destination.response.status);
      if (!claimed.claimed) return Object.freeze({ status: "unknown" });
      await options.journal.markDispatching({ operationId, requestSha256: claimed.requestSha256 });
      const created = await request("cloudSql", `/v1/projects/${projectId}/instances/${sourceInstanceId}/clone`, "POST", intent);
      if (!created.response.ok) return statusFor(created.response.status);
      const operation = z.object({ name: z.string().min(1) }).passthrough().safeParse(created.payload); if (!operation.success) return Object.freeze({ status: "unknown" });
      await options.journal.markDispatched({ operationId, requestSha256: claimed.requestSha256, operationName: operation.data.name }); return Object.freeze({ status: "pending" });
    },
    async observeClone(input: Readonly<{ operationId: string; sourceInstanceId: string; destinationInstanceId: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const sourceInstanceId = InstanceSchema.parse(input.sourceInstanceId); const destinationInstanceId = InstanceSchema.parse(input.destinationInstanceId);
      const original = await options.journal.read(operationId); const resource = `projects/${projectId}/instances/${destinationInstanceId}`;
      const intent = { sourceInstanceId, destinationInstanceId, intent: { cloneContext: { kind: "sql#cloneContext", destinationInstanceName: destinationInstanceId } } };
      if (!original || original.resource !== resource || original.requestSha256 !== await sha256(intent)) return Object.freeze({ status: "blocked" });
      if (original.operationName) { const operation = await request("cloudSql", `/v1/projects/${projectId}/operations/${encodeURIComponent(original.operationName)}`, "GET"); const terminal = operation.response.ok && z.object({ status: z.enum(["PENDING", "RUNNING", "DONE"]), error: z.unknown().optional() }).passthrough().safeParse(operation.payload); if (!terminal || !terminal.success || terminal.data.error !== undefined) return operation.response.ok ? Object.freeze({ status: "unknown" }) : statusFor(operation.response.status); if (terminal.data.status !== "DONE") return Object.freeze({ status: "pending" }); }
      const destination = await request("cloudSql", `/v1/projects/${projectId}/instances/${destinationInstanceId}`, "GET"); if (!destination.response.ok) return statusFor(destination.response.status);
      const observed = z.object({ name: z.literal(destinationInstanceId), createTime: z.string().min(1), state: z.literal("RUNNABLE") }).passthrough().safeParse(destination.payload); if (!observed.success) return Object.freeze({ status: "unknown" });
      if (original.owned) return original.createTime === observed.data.createTime ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
      if (original.state !== "dispatched") return Object.freeze({ status: "unknown" }); await options.journal.markCompleted({ operationId, requestSha256: original.requestSha256, createTime: observed.data.createTime, owned: true }); return Object.freeze({ status: "completed" });
    },
    async observe(input: Readonly<{ operationId: string; instanceId: string; region: string; tier: string; privateNetwork: string; storageGb?: number }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const instanceId = InstanceSchema.parse(input.instanceId); const region = RegionSchema.parse(input.region); const tier = z.string().regex(/^db-custom-[1-9][0-9]*-[1-9][0-9]*$/u).parse(input.tier); const privateNetwork = z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/global\/networks\/[a-z][a-z0-9-]{0,62}$/u).parse(input.privateNetwork); const storageGb = input.storageGb === undefined ? undefined : z.number().int().min(10).max(65_536).parse(input.storageGb); const resource = `projects/${projectId}/instances/${instanceId}`;
      const original = await options.journal.read(operationId); if (!original || original.resource !== resource) return Object.freeze({ status: "blocked" });
      const intent = { name: instanceId, region, databaseVersion: "POSTGRES_17", settings: { tier, availabilityType: "REGIONAL", ...(storageGb === undefined ? {} : { dataDiskSizeGb: storageGb }), userLabels: { "napplet-cvm-operation": operationId }, backupConfiguration: { enabled: true }, ipConfiguration: { privateNetwork, ipv4Enabled: false, requireSsl: true }, databaseFlags: [{ name: "default_transaction_isolation", value: "serializable" }] } };
      if (await sha256(intent) !== original.requestSha256) return Object.freeze({ status: "blocked" });
      if (original.operationName) {
        const operation = await request("cloudSql", `/v1/projects/${projectId}/operations/${encodeURIComponent(original.operationName)}`, "GET"); if (!operation.response.ok) return statusFor(operation.response.status);
        const terminal = z.object({ status: z.enum(["PENDING", "RUNNING", "DONE"]), error: z.unknown().optional() }).passthrough().safeParse(operation.payload);
        if (!terminal.success || terminal.data.error !== undefined) return Object.freeze({ status: "unknown" }); if (terminal.data.status !== "DONE") return Object.freeze({ status: "pending" });
      }
      const instance = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "GET"); if (!instance.response.ok) return statusFor(instance.response.status);
      const ready = z.object({ name: z.literal(instanceId), createTime: z.string().min(1), region: z.literal(region), databaseVersion: z.literal("POSTGRES_17"), state: z.literal("RUNNABLE"), settings: z.object({ tier: z.literal(tier), availabilityType: z.literal("REGIONAL"), ...(storageGb === undefined ? {} : { dataDiskSizeGb: z.literal(storageGb) }), userLabels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough(), backupConfiguration: z.object({ enabled: z.literal(true) }).passthrough(), ipConfiguration: z.object({ privateNetwork: z.literal(privateNetwork), ipv4Enabled: z.literal(false), requireSsl: z.literal(true) }).passthrough(), databaseFlags: z.array(z.object({ name: z.literal("default_transaction_isolation"), value: z.literal("serializable") })).min(1) }).passthrough() }).passthrough().safeParse(instance.payload); if (!ready.success) return Object.freeze({ status: "unknown" });
      if (original.owned) return original.createTime === ready.data.createTime ? Object.freeze({ status: "completed" }) : Object.freeze({ status: "unknown" });
      if (original.state === "completed") return Object.freeze({ status: "unknown" });
      await options.journal.markCompleted({ operationId, requestSha256: original.requestSha256, createTime: ready.data.createTime, owned: true }); return Object.freeze({ status: "completed" });
    },
    async observeCleanup(input: Readonly<{ operationId: string; instanceId: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId), instanceId = InstanceSchema.parse(input.instanceId);
      const resource = `projects/${projectId}/instances/${instanceId}`;
      const original = await options.journal.read(operationId);
      if (!original?.owned || !original.createTime || original.resource !== resource) throw new Error("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
      const current = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "GET");
      if (current.response.status === 404) return Object.freeze({ status: "completed" });
      if (!current.response.ok) return statusFor(current.response.status);
      const owned = z.object({ name: z.literal(instanceId), createTime: z.literal(original.createTime), settings: z.object({ userLabels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough() }).passthrough().safeParse(current.payload);
      if (!owned.success) return Object.freeze({ status: "unknown" });
      const cleanup = await options.journal.read(`${operationId}-cleanup`);
      if (!cleanup) return Object.freeze({ status: "missing" });
      if (cleanup.resource !== resource || !cleanup.operationName) return Object.freeze({ status: "unknown" });
      const deletion = await request("cloudSql", `/v1/projects/${projectId}/operations/${encodeURIComponent(cleanup.operationName)}`, "GET");
      if (!deletion.response.ok) return statusFor(deletion.response.status);
      const terminal = z.object({ status: z.enum(["PENDING", "RUNNING", "DONE"]), error: z.unknown().optional() }).passthrough().safeParse(deletion.payload);
      if (!terminal.success || terminal.data.error !== undefined) return Object.freeze({ status: "unknown" });
      if (terminal.data.status !== "DONE") return Object.freeze({ status: "pending" });
      const absent = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "GET");
      return absent.response.status === 404 ? Object.freeze({ status: "completed" }) : absent.response.ok ? Object.freeze({ status: "pending" }) : statusFor(absent.response.status);
    },
    async cleanup(input: Readonly<{ operationId: string; instanceId: string }>): Promise<SafeStatus> {
      const operationId = DeploymentOperationIdSchema.parse(input.operationId); const instanceId = InstanceSchema.parse(input.instanceId); const resource = `projects/${projectId}/instances/${instanceId}`;
      const original = await options.journal.read(operationId); if (!original?.owned || !original.createTime || original.resource !== resource) throw new Error("GOOGLE_CLEANUP_RUN_OWNERSHIP_REQUIRED");
      const before = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "GET"); if (before.response.status === 404) return Object.freeze({ status: "completed" }); if (!before.response.ok) return statusFor(before.response.status);
      const owned = z.object({ name: z.literal(instanceId), createTime: z.literal(original.createTime), settings: z.object({ userLabels: z.object({ "napplet-cvm-operation": z.literal(operationId) }).passthrough() }).passthrough() }).passthrough().safeParse(before.payload); if (!owned.success) return Object.freeze({ status: "unknown" });
      const cleanupId = `${operationId}-cleanup`; const cleanup = await claim(cleanupId, resource, { method: "delete", createTime: owned.data.createTime });
      if (!cleanup.claimed) {
        if (cleanup.record.state === "completed") return Object.freeze({ status: "pending" }); if (!cleanup.record.operationName) return Object.freeze({ status: "unknown" });
        const operation = await request("cloudSql", `/v1/projects/${projectId}/operations/${encodeURIComponent(cleanup.record.operationName)}`, "GET"); if (!operation.response.ok) return statusFor(operation.response.status);
        const terminal = z.object({ status: z.enum(["PENDING", "RUNNING", "DONE"]), error: z.unknown().optional() }).passthrough().safeParse(operation.payload); if (!terminal.success || terminal.data.error !== undefined) return Object.freeze({ status: "unknown" }); if (terminal.data.status !== "DONE") return Object.freeze({ status: "pending" });
        const absent = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "GET"); if (absent.response.status !== 404) return absent.response.ok ? Object.freeze({ status: "pending" }) : statusFor(absent.response.status);
        await options.journal.markCompleted({ operationId: cleanupId, requestSha256: cleanup.requestSha256 }); return Object.freeze({ status: "completed" });
      }
      await options.journal.markDispatching({ operationId: cleanupId, requestSha256: cleanup.requestSha256 });
      const deleted = await request("cloudSql", `/v1/projects/${projectId}/instances/${instanceId}`, "DELETE"); if (!deleted.response.ok) return statusFor(deleted.response.status); const deletion = z.object({ name: z.string().min(1) }).passthrough().safeParse(deleted.payload); if (!deletion.success) return Object.freeze({ status: "unknown" }); await options.journal.markDispatched({ operationId: cleanupId, requestSha256: cleanup.requestSha256, operationName: deletion.data.name }); return Object.freeze({ status: "pending" });
    },
  });
  /* Collector deployment is Cloud Run. Vertex generation has no durable
   * operation lookup: Plan 65 owns its query-only reconciliation, so this
   * lower-level boundary deliberately returns unknown instead of inventing one. */
  const collector = Object.freeze({ projectId, deploy: cloudRun.deploy, observeUploadedManifest: observeArtifactRegistryManifest, uploadOciImage: uploadArtifactRegistryImage });
  const vertex = Object.freeze({ projectId, async predict(_input: Readonly<{ operationId: string; region: string; modelReference: string; requestDigest: string }>): Promise<SafeStatus> { return Object.freeze({ status: "unknown" }); } });
  return Object.freeze({ projectId, quotaProjectId, cloudRun, gcs, cloudSqlPostgres, collector, vertex });
}
