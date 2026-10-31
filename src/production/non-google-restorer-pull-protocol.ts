import { createHash } from "node:crypto";
import { z } from "zod";
import type { ObjectStorePort } from "../continuity/object-store";
import { NonGoogleCoreJournal } from "./non-google-native-runtime";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const ObjectKey = z.string().min(1).max(2048);
const Job = z.object({ originalId: Identifier, candidateSha256: Digest, topologySha256: Digest, roleCostBoundSha256: Digest, capabilitySha256: Digest, archive: z.object({ key: ObjectKey, generation: z.number().int().positive(), checksum: Digest, byteCount: z.number().int().positive().max(64 * 1024 * 1024) }).strict(), expiresAtMs: z.number().int().positive() }).strict();
export type NonGoogleRestorerJob = z.infer<typeof Job>;
export type NonGoogleRestorerResult = Readonly<{ backupSha256: string; sourceSystemIdentifier: string; freshSystemIdentifier: string }>;
export type NonGoogleRestorerPullStore = Readonly<{
  readJob(originalId: string): Promise<NonGoogleRestorerJob | undefined>;
  readArchive(input: Readonly<{ key: string; generation: number; checksum: string; start: number; end: number }>): Promise<Uint8Array | undefined>;
  readResult(originalId: string): Promise<NonGoogleRestorerResult | undefined>;
  recordResult(originalId: string, result: NonGoogleRestorerResult): Promise<NonGoogleRestorerResult>;
}>;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type StoredJob = NonGoogleRestorerJob & Readonly<{ result?: NonGoogleRestorerResult }>;
/** Durable original-only store over the existing restricted journal and
 * generation-pinned object store. It does not allocate a table or accept
 * callback reports. Result acknowledgement loss is reconciled by this exact
 * original record before a restorer can repeat pg_restore. */
export class PostgresRestorerPullStore implements NonGoogleRestorerPullStore {
  constructor(private readonly journal: NonGoogleCoreJournal, private readonly objects: ObjectStorePort) { Object.freeze(this); }
  #key(originalId: string) { return `restorer-job:${Identifier.parse(originalId)}`; }
  async claimJob(raw: NonGoogleRestorerJob): Promise<NonGoogleRestorerJob> {
    const job = Job.parse(raw);
    const claimed = await this.journal.claim(this.#key(job.originalId), sha(new TextEncoder().encode(JSON.stringify(job))), job);
    const stored = Job.parse(claimed.record.value);
    if (JSON.stringify(stored) !== JSON.stringify(job)) throw new Error("NON_GOOGLE_RESTORER_JOB_CONFLICT");
    return stored;
  }
  async readJob(originalId: string): Promise<NonGoogleRestorerJob | undefined> { const record = await this.journal.read<StoredJob>(this.#key(originalId)); return record && Job.parse(record.value); }
  async readArchive(input: Readonly<{ key: string; generation: number; checksum: string; start: number; end: number }>): Promise<Uint8Array | undefined> {
    const full = await this.objects.readExact({ key: ObjectKey.parse(input.key), generation: z.number().int().positive().parse(input.generation), checksum: Digest.parse(input.checksum) });
    if (!full || sha(full) !== input.checksum || input.start < 0 || input.end < input.start || input.end >= full.byteLength) return undefined;
    return full.slice(input.start, input.end + 1);
  }
  async readResult(originalId: string): Promise<NonGoogleRestorerResult | undefined> { const record = await this.journal.read<StoredJob>(this.#key(originalId)); return record?.value.result; }
  async recordResult(originalId: string, raw: NonGoogleRestorerResult): Promise<NonGoogleRestorerResult> {
    const result = z.object({ backupSha256: Digest, sourceSystemIdentifier: z.string().regex(/^[0-9]+$/u), freshSystemIdentifier: z.string().regex(/^[0-9]+$/u) }).strict().parse(raw);
    const record = await this.journal.read<StoredJob>(this.#key(originalId)); if (!record) throw new Error("NON_GOOGLE_RESTORER_JOB_REQUIRED");
    if (record.value.result) { if (JSON.stringify(record.value.result) !== JSON.stringify(result)) throw new Error("NON_GOOGLE_RESTORER_RESULT_CONFLICT"); return record.value.result; }
    const saved = await this.journal.replace(this.#key(originalId), record.identitySha256, record.revision, Object.freeze({ ...record.value, result }));
    if (saved) return result;
    const recovered = await this.readResult(originalId); if (!recovered) throw new Error("NON_GOOGLE_RESTORER_RESULT_RECONCILIATION_PENDING");
    if (JSON.stringify(recovered) !== JSON.stringify(result)) throw new Error("NON_GOOGLE_RESTORER_RESULT_CONFLICT"); return recovered;
  }
}

/** Closed, controller-owned private route handler. Routing accepts only exact
 * original IDs and bounded archive ranges; credentials and archive bytes never
 * appear in journal payloads or result JSON. */
export function createNonGoogleRestorerPullHandler(input: Readonly<{ store: NonGoogleRestorerPullStore; readCapability: (originalId: string) => Promise<string> }>) {
  return Object.freeze({ async handle(request: Request): Promise<Response> {
    const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
    if (parts.slice(0, 4).join("/") !== "private/non-google-restorer/v1/jobs" || parts.length < 5) return new Response(null, { status: 404 });
    const originalId = Identifier.safeParse(parts[4]); if (!originalId.success) return new Response(null, { status: 404 });
    const job = await input.store.readJob(originalId.data); if (!job || job.expiresAtMs <= Date.now()) return new Response(null, { status: 404 });
    const capability = request.headers.get("authorization")?.replace(/^Bearer /u, "");
    const expected = await input.readCapability(originalId.data);
    if (!capability || sha(new TextEncoder().encode(capability)) !== job.capabilitySha256 || capability !== expected) return new Response(null, { status: 404 });
    if (parts.length === 5 && request.method === "GET") return Response.json(job);
    if (parts.length === 6 && parts[5] === "result" && request.method === "GET") { const result = await input.store.readResult(originalId.data); return result ? Response.json(result) : new Response(null, { status: 404 }); }
    if (parts.length === 6 && parts[5] === "result" && request.method === "POST") { const result = z.object({ backupSha256: Digest, sourceSystemIdentifier: z.string().regex(/^[0-9]+$/u), freshSystemIdentifier: z.string().regex(/^[0-9]+$/u) }).strict().parse(await request.json()); return Response.json(await input.store.recordResult(originalId.data, result)); }
    if (parts.length === 6 && parts[5] === "archive" && request.method === "GET") {
      const range = request.headers.get("range"); const parsed = /^bytes=(\d+)-(\d+)$/u.exec(range ?? ""); if (!parsed) return new Response(null, { status: 416 });
      const start = Number(parsed[1]), end = Number(parsed[2]); if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > 384 * 1024 || end >= job.archive.byteCount) return new Response(null, { status: 416 });
      const bytes = await input.store.readArchive({ ...job.archive, start, end }); if (!bytes || bytes.byteLength !== end - start + 1) return new Response(null, { status: 404 });
      return new Response(Uint8Array.from(bytes).buffer, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${job.archive.byteCount}`, "x-napplet-archive-sha256": job.archive.checksum } });
    }
    return new Response(null, { status: 404 });
  } });
}

/** Restorer-side client. An acknowledged prior result is returned before a
 * caller can run pg_restore again; archive chunks have strict bounded ranges. */
export class NonGoogleRestorerPullClient {
  constructor(private readonly origin: string, private readonly capability: string, private readonly fetcher: typeof fetch = fetch) { if (new URL(origin).protocol !== "https:") throw new Error("NON_GOOGLE_RESTORER_PRIVATE_ORIGIN_REQUIRED"); if (capability.length < 32) throw new Error("NON_GOOGLE_RESTORER_CAPABILITY_REQUIRED"); Object.freeze(this); }
  #headers() { return { authorization: `Bearer ${this.capability}` }; }
  async readJob(originalId: string): Promise<NonGoogleRestorerJob> { const response = await this.fetcher(new URL(`/private/non-google-restorer/v1/jobs/${Identifier.parse(originalId)}`, this.origin), { headers: this.#headers() }); if (!response.ok) throw new Error("NON_GOOGLE_RESTORER_JOB_UNAVAILABLE"); return Job.parse(await response.json()); }
  async readResult(originalId: string): Promise<NonGoogleRestorerResult | undefined> { const response = await this.fetcher(new URL(`/private/non-google-restorer/v1/jobs/${Identifier.parse(originalId)}/result`, this.origin), { headers: this.#headers() }); if (response.status === 404) return undefined; if (!response.ok) throw new Error("NON_GOOGLE_RESTORER_RESULT_UNAVAILABLE"); return z.object({ backupSha256: Digest, sourceSystemIdentifier: z.string().regex(/^[0-9]+$/u), freshSystemIdentifier: z.string().regex(/^[0-9]+$/u) }).strict().parse(await response.json()); }
  async readArchive(job: NonGoogleRestorerJob): Promise<Uint8Array> { const pieces: Uint8Array[] = []; for (let start = 0; start < job.archive.byteCount; start += 384 * 1024) { const end = Math.min(job.archive.byteCount - 1, start + 384 * 1024 - 1); const response = await this.fetcher(new URL(`/private/non-google-restorer/v1/jobs/${job.originalId}/archive`, this.origin), { headers: { ...this.#headers(), range: `bytes=${start}-${end}` } }); if (response.status !== 206 || response.headers.get("x-napplet-archive-sha256") !== job.archive.checksum) throw new Error("NON_GOOGLE_RESTORER_ARCHIVE_UNAVAILABLE"); pieces.push(new Uint8Array(await response.arrayBuffer())); } const bytes = new Uint8Array(pieces.reduce((size, part) => size + part.byteLength, 0)); let offset = 0; for (const part of pieces) { bytes.set(part, offset); offset += part.byteLength; } if (sha(bytes) !== job.archive.checksum) throw new Error("NON_GOOGLE_RESTORER_ARCHIVE_CHECKSUM_INVALID"); return bytes; }
}
