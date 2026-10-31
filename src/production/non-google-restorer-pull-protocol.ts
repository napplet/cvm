import { createHash } from "node:crypto";
import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const Job = z.object({ originalId: Identifier, candidateSha256: Digest, topologySha256: Digest, roleCostBoundSha256: Digest, archive: z.object({ key: Identifier, generation: z.number().int().positive(), checksum: Digest, byteCount: z.number().int().positive().max(64 * 1024 * 1024) }).strict(), expiresAtMs: z.number().int().positive() }).strict();
export type NonGoogleRestorerJob = z.infer<typeof Job>;
export type NonGoogleRestorerResult = Readonly<{ backupSha256: string; sourceSystemIdentifier: string; freshSystemIdentifier: string }>;
export type NonGoogleRestorerPullStore = Readonly<{
  readJob(originalId: string): Promise<NonGoogleRestorerJob | undefined>;
  readArchive(input: Readonly<{ key: string; generation: number; checksum: string; start: number; end: number }>): Promise<Uint8Array | undefined>;
  readResult(originalId: string): Promise<NonGoogleRestorerResult | undefined>;
  recordResult(originalId: string, result: NonGoogleRestorerResult): Promise<NonGoogleRestorerResult>;
}>;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Closed, controller-owned private route handler. Routing accepts only exact
 * original IDs and bounded archive ranges; credentials and archive bytes never
 * appear in journal payloads or result JSON. */
export function createNonGoogleRestorerPullHandler(store: NonGoogleRestorerPullStore) {
  return Object.freeze({ async handle(request: Request): Promise<Response> {
    const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
    if (parts.slice(0, 4).join("/") !== "private/non-google-restorer/v1/jobs" || parts.length < 5) return new Response(null, { status: 404 });
    const originalId = Identifier.safeParse(parts[4]); if (!originalId.success) return new Response(null, { status: 404 });
    const job = await store.readJob(originalId.data); if (!job || job.expiresAtMs <= Date.now()) return new Response(null, { status: 404 });
    if (parts.length === 5 && request.method === "GET") return Response.json(job);
    if (parts.length === 6 && parts[5] === "result" && request.method === "GET") { const result = await store.readResult(originalId.data); return result ? Response.json(result) : new Response(null, { status: 404 }); }
    if (parts.length === 6 && parts[5] === "result" && request.method === "POST") { const result = z.object({ backupSha256: Digest, sourceSystemIdentifier: z.string().regex(/^[0-9]+$/u), freshSystemIdentifier: z.string().regex(/^[0-9]+$/u) }).strict().parse(await request.json()); return Response.json(await store.recordResult(originalId.data, result)); }
    if (parts.length === 6 && parts[5] === "archive" && request.method === "GET") {
      const range = request.headers.get("range"); const parsed = /^bytes=(\d+)-(\d+)$/u.exec(range ?? ""); if (!parsed) return new Response(null, { status: 416 });
      const start = Number(parsed[1]), end = Number(parsed[2]); if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > 384 * 1024 || end >= job.archive.byteCount) return new Response(null, { status: 416 });
      const bytes = await store.readArchive({ ...job.archive, start, end }); if (!bytes || bytes.byteLength !== end - start + 1) return new Response(null, { status: 404 });
      return new Response(Uint8Array.from(bytes).buffer, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${job.archive.byteCount}`, "x-napplet-archive-sha256": job.archive.checksum } });
    }
    return new Response(null, { status: 404 });
  } });
}

/** Restorer-side client. An acknowledged prior result is returned before a
 * caller can run pg_restore again; archive chunks have strict bounded ranges. */
export class NonGoogleRestorerPullClient {
  constructor(private readonly origin: string, private readonly fetcher: typeof fetch = fetch) { if (new URL(origin).protocol !== "https:") throw new Error("NON_GOOGLE_RESTORER_PRIVATE_ORIGIN_REQUIRED"); Object.freeze(this); }
  async readJob(originalId: string): Promise<NonGoogleRestorerJob> { const response = await this.fetcher(new URL(`/private/non-google-restorer/v1/jobs/${Identifier.parse(originalId)}`, this.origin)); if (!response.ok) throw new Error("NON_GOOGLE_RESTORER_JOB_UNAVAILABLE"); return Job.parse(await response.json()); }
  async readResult(originalId: string): Promise<NonGoogleRestorerResult | undefined> { const response = await this.fetcher(new URL(`/private/non-google-restorer/v1/jobs/${Identifier.parse(originalId)}/result`, this.origin)); if (response.status === 404) return undefined; if (!response.ok) throw new Error("NON_GOOGLE_RESTORER_RESULT_UNAVAILABLE"); return z.object({ backupSha256: Digest, sourceSystemIdentifier: z.string().regex(/^[0-9]+$/u), freshSystemIdentifier: z.string().regex(/^[0-9]+$/u) }).strict().parse(await response.json()); }
  async readArchive(job: NonGoogleRestorerJob): Promise<Uint8Array> { const pieces: Uint8Array[] = []; for (let start = 0; start < job.archive.byteCount; start += 384 * 1024) { const end = Math.min(job.archive.byteCount - 1, start + 384 * 1024 - 1); const response = await this.fetcher(new URL(`/private/non-google-restorer/v1/jobs/${job.originalId}/archive`, this.origin), { headers: { range: `bytes=${start}-${end}` } }); if (response.status !== 206 || response.headers.get("x-napplet-archive-sha256") !== job.archive.checksum) throw new Error("NON_GOOGLE_RESTORER_ARCHIVE_UNAVAILABLE"); pieces.push(new Uint8Array(await response.arrayBuffer())); } const bytes = new Uint8Array(pieces.reduce((size, part) => size + part.byteLength, 0)); let offset = 0; for (const part of pieces) { bytes.set(part, offset); offset += part.byteLength; } if (sha(bytes) !== job.archive.checksum) throw new Error("NON_GOOGLE_RESTORER_ARCHIVE_CHECKSUM_INVALID"); return bytes; }
}
