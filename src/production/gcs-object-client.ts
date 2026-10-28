import { z } from "zod";
import type { VersionedObjectClientPort } from "../continuity/object-store";
import type { GoogleTokenSource } from "../release/deployment/google-auth";

const Bucket = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u);
const ObjectKey = z.string().min(1).max(1024).refine(value => !value.startsWith("/") && !value.split("/").some(part => part === "" || part === "." || part === ".."));
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Generation = z.number().int().positive();
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

type StorageMetadata = Readonly<{ generation: number; metadata: Readonly<Record<string, string>> }>;

async function boundedBytes(response: Response, ceiling = MAX_RESPONSE_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error("GCS_RESPONSE_BODY_REQUIRED");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > ceiling) { await reader.cancel(new Error("GCS_RESPONSE_TOO_LARGE")); throw new Error("GCS_RESPONSE_TOO_LARGE"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(new ArrayBuffer(size)); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function metadata(response: Response): Promise<StorageMetadata | undefined> {
  if (!response.ok) return undefined;
  try {
    const parsed = z.object({ generation: z.union([z.string().regex(/^\d+$/u), z.number().int().positive()]), metadata: z.record(z.string(), z.string()).optional() }).passthrough().parse(JSON.parse(new TextDecoder().decode(await boundedBytes(response, 128 * 1024))));
    const generation = Number(parsed.generation);
    if (!Number.isSafeInteger(generation)) return undefined;
    return Object.freeze({ generation: Generation.parse(generation), metadata: Object.freeze({ ...(parsed.metadata ?? {}) }) });
  } catch { return undefined; }
}

/**
 * The only production GCS data-plane client.  It uses ADC for every request,
 * never lists objects, and pins every read/mutation to a generation.  Object
 * deletion is scheduled by writing the exact retained-generation's immutable
 * deletion marker; the 30-day lifecycle controller consumes that marker.
 */
export function createProductionGcsObjectClient(input: Readonly<{
  bucket: string;
  tokenSource: GoogleTokenSource;
  fetch?: typeof globalThis.fetch;
}>): VersionedObjectClientPort {
  const bucket = Bucket.parse(input.bucket);
  if (!input.tokenSource || typeof input.tokenSource.getAccessToken !== "function") throw new Error("PRODUCTION_GCS_ADC_REQUIRED");
  const request = async (url: URL, init: RequestInit) => {
    const access = await input.tokenSource.getAccessToken();
    const response = await (input.fetch ?? fetch)(url, {
      ...init, redirect: "error",
      headers: { authorization: `Bearer ${access.token}`, ...(init.headers ?? {}) },
    });
    return response;
  };
  const objectUrl = (key: string, query: Readonly<Record<string, string>> = {}) => {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  };
  const readMetadata = async (key: string, generation?: number) => {
    const response = await request(objectUrl(key, generation === undefined ? {} : { generation: String(generation) }), { method: "GET" });
    const result = await metadata(response);
    if (!result && response.body) await response.body.cancel().catch(() => undefined);
    return result;
  };
  return Object.freeze({
    async createIfAbsent(input: Readonly<{ key: string; bytes: Uint8Array; checksum: string }>) {
      const key = ObjectKey.parse(input.key); const checksum = Digest.parse(input.checksum);
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("GCS_OBJECT_BYTES_INVALID");
      const upload = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
      const boundary = `napplet-cvm-${crypto.randomUUID()}`;
      upload.searchParams.set("uploadType", "multipart"); upload.searchParams.set("ifGenerationMatch", "0");
      const header = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: key, metadata: { sha256: checksum } })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const trailer = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      const body = new Uint8Array(new ArrayBuffer(header.byteLength + input.bytes.byteLength + trailer.byteLength));
      body.set(header, 0); body.set(input.bytes, header.byteLength); body.set(trailer, header.byteLength + input.bytes.byteLength);
      const response = await request(upload, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
      if (response.status === 412) {
        await response.body?.cancel().catch(() => undefined);
        // The precondition failed: observe the fixed object name and only
        // adopt it if its controller-written content digest matches exactly.
        const current = await readMetadata(key).catch(() => undefined);
        if (!current || current.metadata.sha256 !== checksum) throw new Error("GCS_OBJECT_IMMUTABLE_CONFLICT");
        return Object.freeze({ generation: current.generation, checksum });
      }
      const created = await metadata(response);
      if (!created || created.metadata.sha256 !== checksum) throw new Error("GCS_OBJECT_CREATE_UNVERIFIED");
      return Object.freeze({ generation: created.generation, checksum });
    },
    async findExactByKey(input: Readonly<{ key: string; checksum: string }>) {
      const key = ObjectKey.parse(input.key); const checksum = Digest.parse(input.checksum);
      const current = await readMetadata(key);
      return current?.metadata.sha256 === checksum ? Object.freeze({ generation: current.generation, checksum }) : undefined;
    },
    async readGeneration(input: Readonly<{ key: string; generation: number; expectedChecksum: string }>) {
      const key = ObjectKey.parse(input.key); const generation = Generation.parse(input.generation); const expectedChecksum = Digest.parse(input.expectedChecksum);
      const current = await readMetadata(key, generation);
      if (!current || current.generation !== generation || current.metadata.sha256 !== expectedChecksum) return undefined;
      const response = await request(objectUrl(key, { generation: String(generation), alt: "media" }), { method: "GET" });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined; }
      const headerGeneration = response.headers.get("x-goog-generation");
      if (headerGeneration !== null && Number(headerGeneration) !== generation) { await response.body?.cancel().catch(() => undefined); return undefined; }
      return Object.freeze({ generation, checksum: expectedChecksum, bytes: await boundedBytes(response) });
    },
    async scheduleGenerationDeletion(input: Readonly<{ key: string; generation: number; expectedChecksum: string; deleteAfter: string }>) {
      const key = ObjectKey.parse(input.key); const generation = Generation.parse(input.generation); const expectedChecksum = Digest.parse(input.expectedChecksum);
      const deleteAt = Date.parse(input.deleteAfter);
      if (!Number.isFinite(deleteAt)) throw new Error("GCS_DELETE_TIME_INVALID");
      const current = await readMetadata(key, generation);
      if (!current || current.generation !== generation || current.metadata.sha256 !== expectedChecksum) throw new Error("GCS_OBJECT_EXACT_GENERATION_REQUIRED");
      // Cloud Storage has no per-object future-delete API.  Never label an
      // object deleted with metadata. The retention reconciler calls this only
      // after the deadline, at which point generation-pinned DELETE is the
      // real provider effect and a 404 is an observed prior completion.
      if (Date.now() < deleteAt) throw new Error("GCS_DELETE_NOT_DUE");
      const response = await request(objectUrl(key, { generation: String(generation), ifGenerationMatch: String(generation) }), { method: "DELETE" });
      if (!response.ok && response.status !== 404) { await response.body?.cancel().catch(() => undefined); throw new Error("GCS_EXACT_DELETE_UNCONFIRMED"); }
      await response.body?.cancel().catch(() => undefined);
      return Object.freeze({ generation, checksum: expectedChecksum });
    },
  });
}
