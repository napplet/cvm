import { sourceCapabilities } from "../../infra/dev-ui/source-capabilities";
import { PublicationHashtagsSchema } from "../dev-ui/publication-hashtags";
import { publicationScreenshot } from "./publication-media";
import { prepareZapstorePublication, createSiteManifestTemplate } from "../../infra/vendor/napplet-publication/bundle/entry.js";
import { publishOnUserRelays, type RelayReceipt } from "./publication-relays";
import { relayUrl } from "../dev-ui/destinations";
import { MIN_PUBLICATION_SERVERS, verifiedPublicationServers } from "../dev-ui/publication-copies";
import { suggestPublicationMetadata } from "./publication-suggestions";
import { CvmBlossom } from "./cvm-blossom";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { z } from "zod";
import { getEventHash, verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { naddrEncode } from "nostr-tools/nip19";
import { publishEventWithSimplePool, createUploadAuthorization } from "../../infra/vendor/napplet-cli/bundle/entry.js";
import { accountIdForPrincipal } from "../domain/account-command";
import { canonicalJson } from "../promotion/schema";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";
import type { LocalArtifactRepository, SealedArtifact } from "./local-artifact-repository";

const Hex = z.string().regex(/^[a-f0-9]{64}$/u);
const SignedEvent = z.object({ id: Hex, pubkey: Hex, sig: z.string().regex(/^[a-f0-9]{128}$/u), kind: z.literal(35129), created_at: z.number().int().positive(), tags: z.array(z.array(z.string().max(1024)).max(8)).max(512), content: z.string().max(4000) }).strict();
const ApplicationEvent = SignedEvent.extend({ kind: z.literal(32267), content: z.string().max(4000) });
const ServerUrl = z.string().url().max(512).refine(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"; });
const FileResult = z.object({ server: ServerUrl, file: z.string().max(512), state: z.enum(["checking", "signing", "mirroring", "uploading", "verified", "failed"]), detail: z.string().max(1000).optional() }).strict();
export const DevelopmentPublicationArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lookup"), sessionId: z.string().max(240), artifactId: z.string().max(100), publisher: Hex }).strict(),
  z.object({ action: z.literal("preview"), artifactId: z.string().max(100), sessionId: z.string().max(240) }).strict(),
  z.object({ action: z.literal("metadata"), artifactId: z.string().max(100), sessionId: z.string().max(240) }).strict(),
  z.object({ action: z.literal("prepare"), servers: z.array(ServerUrl).min(1).max(5), relays: z.array(z.string().max(512).transform(value => relayUrl(value))).min(1).max(5), artifactId: z.string().max(100), sessionId: z.string().max(240), publisher: Hex, requestKey: z.string().uuid(), title: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(500).optional(), hashtags: PublicationHashtagsSchema.optional(), replaces: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal("submit"), id: z.string().uuid(), event: SignedEvent }).strict(),
  z.object({ action: z.literal("save"), id: z.string().uuid(), event: SignedEvent, applicationEvent: ApplicationEvent.optional(), fileResults: z.array(FileResult).max(2560).optional() }).strict(),
  z.object({ action: z.enum(["status", "reconcile", "republish"]), id: z.string().uuid() }).strict(),
]);
type Republication = { attemptedAt: string; relayResults: RelayReceipt[] };
type Application = { template: EventTemplate; signedEvent?: Event; relayResults?: RelayReceipt[] };
type Prepared = { capabilitiesKnown?: boolean; application?: Application; screenshot?: string; republication?: Republication; supersededBy?: string; supersedes?: string; preview?: boolean; relays?: string[]; template: EventTemplate; expiresAt: number; files: SealedArtifact["files"]; version: number; title: string; description?: string; aggregate: string; dTag: string };
type Row = { file_results: z.infer<typeof FileResult>[]; published_at: Date | null; relay_results: RelayReceipt[]; id: string; account_id: string; session_id: string; artifact_id: string; publisher: string; fingerprint: string; prepared: Prepared; signed_event: Event | null; state: "prepared" | "publishing" | "published" | "unconfirmed" };
type Options = { pubkey: string; sign(template: EventTemplate): Promise<Event>; publicOrigin?: string; publicRelay?: string; pool: Pick<PostgresSqlClient, "query">; repository: LocalArtifactRepository; root: string; workerResultsRoot: string; relay: string; openTarget(target: string): Promise<string> };
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const mime = (path: string) => ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" } as Record<string,string>)[extname(path)] ?? "application/octet-stream";

/** Explicit development deployment: immutable local content-addressed files and
 * the real local relay. The promoted production publication gate is unchanged. */
export class LocalPublication {
  #server!: ReturnType<typeof Bun.serve>;
  #blossom!: CvmBlossom;
  #localOrigin = "";
  #active = new Map<string, Promise<unknown>>();
  #previews = new Map<string, Promise<string>>();
  origin = "";
  private constructor(private readonly options: Options) {}
  static async open(options: Options) {
    const service = new LocalPublication(options);
    await mkdir(resolve(options.root, "blobs"), { recursive: true, mode: 0o700 });
    const originPath = resolve(options.root, "origin.json"); let port = 0;
    try { port = z.object({ port: z.number().int().min(1).max(65535) }).strict().parse(JSON.parse(await readFile(originPath, "utf8"))).port; }
    catch (error) { if ((error as any).code !== "ENOENT") throw error; }
    service.#server = Bun.serve({ hostname: "127.0.0.1", port, fetch: request => service.asset(request) });
    service.#localOrigin = `http://127.0.0.1:${service.#server.port}`;
    service.origin = options.publicOrigin ? ServerUrl.parse(options.publicOrigin).replace(/\/$/, "") : service.#localOrigin;
    service.#blossom = new CvmBlossom(options.root, options.pubkey, () => service.origin);
    if (!port) await writeFile(originPath, JSON.stringify({ port: service.#server.port }), { flag: "wx", mode: 0o600 });
    // Upgrade earlier all-relay outcomes using their stored evidence only.
    // No network request, signature or publication is issued by this repair.
    const incomplete = await service.query<Row>("SELECT * FROM development_publications WHERE state='unconfirmed' AND signed_event IS NOT NULL AND prepared->>'supersededBy' IS NULL", []);
    for (const row of incomplete.rows) await service.restoreConfirmed(row);
    return service;
  }
  close() { this.#server.stop(true); }
  private async query<RowType extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[]) { return this.options.pool.query<RowType>(sql, values); }
  async handle(input: unknown, principal: string): Promise<unknown> {
    try {
      const command = DevelopmentPublicationArgumentsSchema.parse(input); const account = await accountIdForPrincipal({ pubkey: principal });
      if (command.action === "lookup") {
        // The publisher is a filter, never proof of ownership. Only the signed
        // CVM caller can read the session and its saved publication envelopes.
        const session = await this.query("SELECT id FROM metered_sessions WHERE id=$1 AND account_id=$2", [command.sessionId, account]);
        if (!session.rows.length) return { status: "denied" };
        const current = (await this.query<Row>(`SELECT * FROM development_publications
          WHERE account_id=$1 AND session_id=$2 AND artifact_id=$3 AND publisher=$4
            AND NOT coalesce((prepared->>'preview')::boolean,false) AND prepared->>'supersededBy' IS NULL
            AND (signed_event IS NOT NULL OR (prepared->>'expiresAt')::bigint > $5)
          ORDER BY (state='published') DESC,(signed_event IS NOT NULL) DESC,created_at DESC,id DESC LIMIT 1`, [account, command.sessionId, command.artifactId, command.publisher, Date.now()])).rows[0];
        if (current) await this.restoreConfirmed(current);
        const latest = (await this.query<Row>(`SELECT * FROM development_publications
          WHERE account_id=$1 AND session_id=$2 AND publisher=$3 AND state='published'
            AND NOT coalesce((prepared->>'preview')::boolean,false)
          ORDER BY published_at DESC NULLS LAST,id DESC LIMIT 1`, [account, command.sessionId, command.publisher])).rows[0];
        return { status: "ok", current: current ? this.projection(current) : null, latestPublished: latest ? this.projection(latest) : null };
      }
      if (command.action === "prepare" || command.action === "preview" || command.action === "metadata") {
        const artifact = await this.options.repository.get(command.artifactId);
        if (!artifact || artifact.accountId !== account || artifact.sessionId !== command.sessionId || artifact.ownerId !== principal) return { status: "denied" };
        if (command.action === "metadata") {
          const { tags, capabilitiesKnown } = await this.metadata(artifact);
          return { status: "ok", artifactId: artifact.artifactId, version: artifact.version, ...await this.suggestions(artifact, tags), tags, capabilitiesKnown, files: artifact.files };
        }
        if (command.action === "preview") return this.ensurePreview(artifact);
        const preview = await this.ensurePreview(artifact);
        if ((preview as any).status !== "published") return { status: "rejected", code: "CVM_PREVIEW_NOT_SHARED" };
        const fingerprint = hash(canonicalJson(command));
        const existing = (await this.query<Row>("SELECT * FROM development_publications WHERE account_id=$1 AND request_key=$2", [account, command.requestKey])).rows[0];
        if (existing) { if (existing.fingerprint !== fingerprint) return { status: "rejected", code: "PUBLICATION_REQUEST_CHANGED" }; if (existing.prepared.supersededBy) return { status: "rejected", code: "PUBLICATION_SUPERSEDED" }; return this.projection(existing); }
        const signed = (await this.query<Row>(`SELECT * FROM development_publications
          WHERE account_id=$1 AND session_id=$2 AND artifact_id=$3 AND publisher=$4 AND signed_event IS NOT NULL
            AND NOT coalesce((prepared->>'preview')::boolean,false) AND prepared->>'supersededBy' IS NULL
          ORDER BY (state='published') DESC,created_at DESC,id DESC LIMIT 1`, [account, artifact.sessionId, artifact.artifactId, command.publisher])).rows[0];
        if (signed && !command.replaces) return this.projection(signed);
        if (command.replaces && (!signed || signed.id !== command.replaces || !["prepared", "unconfirmed", "published"].includes(signed.state))) return { status: "rejected", code: "PUBLICATION_EDIT_UNAVAILABLE" };
        if (new Set(command.servers.map(server => new URL(server).origin)).size < MIN_PUBLICATION_SERVERS) return { status: "rejected", code: "PUBLICATION_NEEDS_TWO_SERVERS" };
        const { tags: metadata, capabilitiesKnown } = await this.metadata(artifact);
        const hashtags = command.hashtags ?? metadata.filter(tag => tag[0] === "t").map(tag => tag[1]!);
        const description = command.description ?? (await this.suggestions(artifact, metadata)).description;
        const id = crypto.randomUUID(); const dTag = `applet-${artifact.artifactId.slice(-20)}-${command.publisher.slice(0, 8)}`;
        const template = await createSiteManifestTemplate({ target: "named", dTag }, artifact.files.map(file => ({ path: `/${file.path}`, sha256: file.sha256 })), { createdAt: Math.max(Math.floor(Date.now() / 1000), (signed?.signed_event?.created_at ?? 0) + 1), servers: [...new Set(command.servers.map(server => new URL(server).origin))], metadataTags: [...metadata.filter(tag => !["title", "description", "t"].includes(tag[0]!)), ["title", command.title], ["description", description], ...hashtags.map(topic => ["t", topic])] });
        if (template.tags.find(tag => tag[0] === "x")?.[1] !== artifact.files.find(file => file.path === "index.html")?.sha256) throw new Error("PUBLICATION_ARTIFACT_HASH_MISMATCH");
        const screenshot = await publicationScreenshot(this.options.root, this.options.repository, artifact);
        await this.uploadCvmBlob(screenshot.file.sha256, "image/png", screenshot.bytes);
        const servers = [...new Set(command.servers.map(server => new URL(server).origin))];
        const address = naddrEncode({ kind: 35129, pubkey: command.publisher, identifier: dTag, relays: command.relays });
        // Use the exact CLI --zapstore implementation. Remote media URLs need
        // no filesystem access; all local bytes were captured in isolation.
        const listing = await prepareZapstorePublication({ version: 1, sourceDir: ".", defaultTarget: "named", relays: command.relays, blossomServers: servers,
          zapstore: { id: `applet-${hash(artifact.sessionId).slice(0, 32)}`, name: command.title, summary: description, description: `${description}\n\nOpen in a compatible napplet shell: nostr:${address}`, tags: hashtags, images: servers.map(server => `${server}/${screenshot.file.sha256}`) } }, servers, { enabled: true, cwd: "/", createdAt: template.created_at });
        if (!listing) throw new Error("PUBLICATION_APPLICATION_MISSING");
        const prepared: Prepared = { capabilitiesKnown, ...(command.replaces ? { supersedes: command.replaces } : {}), relays: [...new Set(command.relays)], template, expiresAt: Date.now() + 600000, files: [...artifact.files, screenshot.file], screenshot: screenshot.file.sha256, application: { template: listing.template }, version: artifact.version, title: command.title, description, aggregate: artifact.aggregateSha256, dTag };
        const parameters = [id, account, artifact.sessionId, artifact.artifactId, command.publisher, command.requestKey, fingerprint, JSON.stringify(prepared)];
        if (command.replaces) {
          // Replace the selected envelope while preserving its signed publication history. The conditional update races
          // safely against submit's own claim; the prior signature stays stored.
          await this.query(`WITH replaced AS (
            UPDATE development_publications SET prepared=jsonb_set(prepared,'{supersededBy}',to_jsonb($1::text)),updated_at=now()
            WHERE id=$9 AND account_id=$2 AND session_id=$3 AND artifact_id=$4 AND publisher=$5
              AND state IN ('prepared','unconfirmed','published') AND prepared->>'supersededBy' IS NULL
            RETURNING id
          ) INSERT INTO development_publications(id,account_id,session_id,artifact_id,publisher,request_key,fingerprint,prepared,state,file_results)
            SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,'prepared',$10::jsonb FROM replaced`, [...parameters, command.replaces, JSON.stringify((signed!.file_results ?? []).filter(receipt => command.servers.map(server => new URL(server).origin).includes(receipt.server)))]);
        } else await this.query("INSERT INTO development_publications(id,account_id,session_id,artifact_id,publisher,request_key,fingerprint,prepared,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared') ON CONFLICT(account_id,request_key) DO NOTHING", parameters);
        const row = (await this.query<Row>("SELECT * FROM development_publications WHERE account_id=$1 AND request_key=$2", [account, command.requestKey])).rows[0]!;
        if (!row) return { status: "rejected", code: "PUBLICATION_EDIT_UNAVAILABLE" };
        if (row.fingerprint !== fingerprint) return { status: "rejected", code: "PUBLICATION_REQUEST_CHANGED" };
        return this.projection(row);
      }
      const row = (await this.query<Row>("SELECT * FROM development_publications WHERE id=$1 AND account_id=$2", [command.id, account])).rows[0];
      if (!row) return { status: "denied" };
      if (row.prepared.supersededBy) return { status: "rejected", code: "PUBLICATION_SUPERSEDED" };
      await this.restoreConfirmed(row);
      if (command.action === "status") return this.projection(row);
      if (command.action === "reconcile") {
        if (row.prepared.application?.signedEvent) await this.publishApplication(row, false);
        if (row.state === "published") return this.projection(row);
        if (row.signed_event && await this.observe(row)) { await this.setState(row.id, "published"); return this.projection((await this.query<Row>("SELECT * FROM development_publications WHERE id=$1", [row.id])).rows[0]!); }
        return this.projection(row);
      }
      if (command.action === "republish") {
        if (row.state !== "published" || row.prepared.preview || !row.signed_event || !row.prepared.relays?.length) return { status: "rejected", code: "PUBLICATION_NOT_PUBLISHED" };
        const running = this.#active.get(row.id); if (running) return running;
        const operation = this.republish(row); this.#active.set(row.id, operation);
        try { return await operation; } finally { this.#active.delete(row.id); }
      }
      if (command.action !== "submit" && command.action !== "save") throw new Error("PUBLICATION_COMMAND_INVALID");
      const event = SignedEvent.parse(command.event);
      if (event.pubkey !== row.publisher || event.id !== getEventHash({ ...row.prepared.template, pubkey: row.publisher }) || !verifyEvent(event)) return { status: "rejected", code: "PUBLICATION_SIGNATURE_MISMATCH" };
      if (row.signed_event && row.signed_event.id !== event.id) return { status: "rejected", code: "PUBLICATION_EVENT_CHANGED" };
      if (row.state === "published") return this.projection(row);
      if (!row.signed_event && row.prepared.expiresAt < Date.now()) return { status: "expired", id: row.id };
      if (command.action === "save") {
        if (command.applicationEvent) {
          const application = row.prepared.application;
          if (!application || command.applicationEvent.pubkey !== row.publisher || command.applicationEvent.id !== getEventHash({ ...application.template, pubkey: row.publisher }) || !verifyEvent(command.applicationEvent)) return { status: "rejected", code: "PUBLICATION_APPLICATION_SIGNATURE_MISMATCH" };
          if (application.signedEvent && application.signedEvent.id !== command.applicationEvent.id) return { status: "rejected", code: "PUBLICATION_APPLICATION_CHANGED" };
        }
        const servers = row.prepared.template.tags.filter(tag => tag[0] === "server").map(tag => tag[1]);
        if (command.fileResults?.some(result => !servers.includes(result.server) || !row.prepared.files.some(file => file.path === result.file))) return { status: "rejected", code: "PUBLICATION_DESTINATION_CHANGED" };
        // Save before the browser begins copying. Resuming on another tab can
        // reuse this exact signature without re-signing or generating anything.
        const saved = await this.query("UPDATE development_publications SET signed_event=coalesce(signed_event,$2::jsonb),file_results=coalesce($3::jsonb,file_results),prepared=CASE WHEN $4::jsonb IS NULL THEN prepared ELSE jsonb_set(prepared,'{application,signedEvent}',$4::jsonb) END,updated_at=now() WHERE id=$1 AND prepared->>'supersededBy' IS NULL RETURNING id", [row.id, JSON.stringify(event), command.fileResults ? JSON.stringify(command.fileResults) : null, command.applicationEvent ? JSON.stringify(command.applicationEvent) : null]);
        if (!saved.rows.length) return { status: "rejected", code: "PUBLICATION_SUPERSEDED" };
        if (command.applicationEvent) row.prepared.application!.signedEvent = command.applicationEvent;
        row.signed_event ??= event; if (command.fileResults) row.file_results = command.fileResults;
        return this.projection(row);
      }
      if (row.prepared.application && !row.prepared.application.signedEvent) return { status: "rejected", code: "PUBLICATION_APPLICATION_SIGNATURE_REQUIRED" };
      // File verification happens in the client; do not turn destinations into
      // arbitrary server-side fetches. Require its durable complete-copy receipts.
      const servers = row.prepared.template.tags.filter(tag => tag[0] === "server").map(tag => tag[1]!);
      if (!row.prepared.preview && verifiedPublicationServers(row.prepared.files, servers, row.file_results ?? []).length < MIN_PUBLICATION_SERVERS) return { status: "rejected", code: "PUBLICATION_NEEDS_TWO_VERIFIED_SERVERS" };
      const running = this.#active.get(row.id); if (running) return running;
      const operation = this.publish(row, event); this.#active.set(row.id, operation);
      try { return await operation; } finally { this.#active.delete(row.id); }
    } catch (error) { const code = error instanceof Error && /^PUBLICATION_SCREENSHOT_(BUSY|FAILED|TOOLCHAIN_MISSING)$/.test(error.message) ? error.message : "PUBLICATION_UNAVAILABLE"; return { status: "rejected", code }; }
  }
  async ensurePreview(artifact: SealedArtifact): Promise<unknown> {
    const key = `cvm-preview-v2:${artifact.artifactId}:${hash(this.origin).slice(0, 16)}`;
    let row = (await this.query<Row>("SELECT * FROM development_publications WHERE account_id=$1 AND request_key=$2", [artifact.accountId, key])).rows[0];
    if (!row) {
      const { tags: metadata, capabilitiesKnown } = await this.metadata(artifact); const suggested = await this.suggestions(artifact, metadata); const id = crypto.randomUUID(); const dTag = `preview-${artifact.artifactId.slice(-32)}`;
      const template = await createSiteManifestTemplate({ target: "named", dTag }, artifact.files.map(file => ({ path: `/${file.path}`, sha256: file.sha256 })), { servers: [this.origin], metadataTags: metadata, content: suggested.description });
      if (template.tags.find(tag => tag[0] === "x")?.[1] !== artifact.files.find(file => file.path === "index.html")?.sha256) throw new Error("PUBLICATION_ARTIFACT_HASH_MISMATCH");
      const prepared: Prepared = { capabilitiesKnown, preview: true, template, expiresAt: Date.now() + 600000, files: artifact.files, version: artifact.version, title: "CVM preview", aggregate: artifact.aggregateSha256, dTag };
      const event = await this.options.sign(template);
      await this.query("INSERT INTO development_publications(id,account_id,session_id,artifact_id,publisher,request_key,fingerprint,prepared,signed_event,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared') ON CONFLICT(account_id,request_key) DO NOTHING", [id, artifact.accountId, artifact.sessionId, artifact.artifactId, this.options.pubkey, key, hash(key), JSON.stringify(prepared), JSON.stringify(event)]);
      row = (await this.query<Row>("SELECT * FROM development_publications WHERE account_id=$1 AND request_key=$2", [artifact.accountId, key])).rows[0]!;
    }
    if (row.state === "published") return this.projection(row);
    const active = this.#active.get(row.id); if (active) return active;
    const operation = this.publish(row, row.signed_event!); this.#active.set(row.id, operation);
    try { return await operation; } finally { this.#active.delete(row.id); }
  }
  private projection(row: Row) {
    return { status: row.state, capabilitiesKnown: row.prepared.capabilitiesKnown, application: row.prepared.application, screenshot: row.prepared.screenshot ? `${this.origin}/${row.prepared.screenshot}` : undefined, republication: row.prepared.republication, id: row.id, artifactId: row.artifact_id, publisher: row.publisher, version: row.prepared.version, title: row.prepared.title, description: row.prepared.description ?? row.prepared.template.tags.find(tag => tag[0] === "description")?.[1] ?? "", aggregate: row.prepared.aggregate, template: row.prepared.template, expiresAt: row.prepared.expiresAt, destination: row.prepared.preview ? "CVM preview" : "Your Blossom servers", relay: this.options.publicRelay ?? this.options.relay, relays: row.prepared.relays ?? [this.options.publicRelay ?? this.options.relay], relayResults: row.relay_results ?? [], fileResults: row.file_results ?? [], signedEvent: row.signed_event ?? undefined, publishedAt: row.published_at?.toISOString(), files: row.prepared.files.map(file => ({ ...file, url: `${this.origin}/${file.sha256}`, type: mime(file.path) })), servers: row.prepared.template.tags.filter(tag => tag[0] === "server").map(tag => tag[1]), preview: !!row.prepared.preview,
      ...(row.state === "published" && row.signed_event ? { eventId: row.signed_event.id, url: `${this.origin}/open/${row.id}`, address: naddrEncode({ identifier: row.prepared.dTag, pubkey: row.publisher, kind: 35129, relays: row.prepared.relays ?? [this.options.publicRelay ?? this.options.relay] }) } : {}) };
  }
  private async suggestions(artifact: SealedArtifact, tags: string[][]) {
    const project = (await this.query<{ title: string }>("SELECT title FROM development_projects WHERE id=$1 AND owner_pubkey=$2", [artifact.sessionId, artifact.ownerId])).rows[0];
    return suggestPublicationMetadata(tags, project?.title, artifact.version);
  }
  private async metadata(artifact: SealedArtifact): Promise<{ tags: string[][]; capabilitiesKnown: boolean }> {
    const row = (await this.query<{ request_sha256: string; manifest_sha256: string }>("SELECT request_sha256,manifest_sha256 FROM development_worker_results WHERE action_id=$1 AND account_id=$2 AND state='completed'", [artifact.actionId, artifact.accountId])).rows[0];
    if (!row || !Hex.safeParse(row.request_sha256).success) throw new Error("PUBLICATION_BUILD_EVIDENCE_MISSING");
    const bytes = await readFile(resolve(this.options.workerResultsRoot, row.request_sha256, "result.json"));
    if (hash(bytes) !== row.manifest_sha256) throw new Error("PUBLICATION_BUILD_EVIDENCE_CHANGED");
    const manifest = JSON.parse(bytes.toString());
    if (manifest.accountId !== artifact.accountId || manifest.actionId !== artifact.actionId || manifest.proposalSha256 !== artifact.proposalSha256) throw new Error("PUBLICATION_BUILD_EVIDENCE_MISMATCH");
    const dryRun = manifest.commandEvidence.find((item: any) => item.name === "dry-run" && item.exitCode === 0);
    const deploy = JSON.parse(dryRun.stdout);
    const site = deploy.manifests.find((item: any) => item.aggregateHash === artifact.aggregateSha256);
    if (!site || site.template.kind !== 15129) throw new Error("PUBLICATION_CLI_MANIFEST_MISSING");
    const tags = z.array(z.array(z.string()).min(1)).parse(site.template.tags).filter(tag => !["path", "x", "server", "d"].includes(tag[0]!));
    // Source declarations are data, bound to the same verified proposal and owner.
    const source = (await this.query<{ proposal_json: { files: { path: string; content: string }[] } }>("SELECT proposal_json FROM source_proposals WHERE proposal_sha256=$1 AND account_id=$2 AND action_id=$3", [artifact.proposalSha256, artifact.accountId, artifact.actionId])).rows[0];
    const files = source?.proposal_json.files;
    if (files && hash(canonicalJson({ files })) !== artifact.proposalSha256) throw new Error("PUBLICATION_SOURCE_CHANGED");
    const capabilities = files ? sourceCapabilities(files) : undefined;
    const normalized = tags.flatMap(tag => tag[0] === "requires" ? [["R", tag[1]!]] : tag[0] === "archetype" ? [["z", tag[1]!], ["i", tag[2]!]] : [tag]);
    if (!capabilities) return { tags: normalized, capabilitiesKnown: false }; // Old builds retain known requirements; never guess optional usage.
    return { tags: [...normalized.filter(tag => !["R", "O"].includes(tag[0]!)), ...capabilities.required.map(domain => ["R", domain]), ...capabilities.optional.map(domain => ["O", domain])], capabilitiesKnown: true };
  }
  private async publish(row: Row, event: Event) {
    // Durable signed envelope before any file/relay effect. Restarts may only
    // observe or replay this same event; they never create a new signature.
    const claimed = await this.query("UPDATE development_publications SET signed_event=$2,state='publishing',updated_at=now() WHERE id=$1 AND prepared->>'supersededBy' IS NULL AND (signed_event IS NULL OR signed_event=$2::jsonb) RETURNING id", [row.id, JSON.stringify(event)]);
    if (!claimed.rows.length) return { status: "rejected", code: "PUBLICATION_SUPERSEDED" };
    row.signed_event = event;
    try {
      if (row.prepared.preview) for (const file of row.prepared.files) {
        const stored = await this.options.repository.read({ artifactId: row.artifact_id, path: file.path });
        if (!stored || hash(stored.bytes) !== file.sha256) throw new Error("PUBLICATION_FILE_CHANGED");
        const authorization = await createUploadAuthorization({ sign: template => this.options.sign(template) }, [file.sha256], undefined, new URL(this.origin).hostname);
        const uploaded = await fetch(`${this.#localOrigin}/upload`, { method: "PUT", headers: { authorization, "x-sha-256": file.sha256, "content-type": mime(file.path) }, body: new Uint8Array(stored.bytes).buffer, signal: AbortSignal.timeout(15000) });
        if (!uploaded.ok || (await uploaded.json() as any).sha256 !== file.sha256) throw new Error("CVM_BLOB_UPLOAD_FAILED");
      }
      if (row.prepared.relays && !row.prepared.preview) {
        await this.publishApplication(row, true);
        row.relay_results = await publishOnUserRelays(row.prepared.relays, event, this.options.relay, true);
        await this.query("UPDATE development_publications SET relay_results=$2,updated_at=now() WHERE id=$1", [row.id, JSON.stringify(row.relay_results)]);
        row.state = row.relay_results.some(result => result.state === "published") ? "published" : "unconfirmed";
      } else {
        const published = await publishEventWithSimplePool([this.options.relay], event);
        row.state = published.every(result => result.success) && await this.observe(row) ? "published" : "unconfirmed";
      }
    } catch { row.state = "unconfirmed"; }
    await this.setState(row.id, row.state);
    const saved = (await this.query<Row>("SELECT * FROM development_publications WHERE id=$1", [row.id])).rows[0]!;
    return this.projection(saved);
  }
  private async republish(row: Row) {
    await this.publishApplication(row, "always");
    const relayResults = await publishOnUserRelays(row.prepared.relays!, row.signed_event!, this.options.relay, "always");
    // A resend does not undo a prior publication or its confirmation receipts.
    const known = new Map((row.relay_results ?? []).map(receipt => [receipt.relay, receipt]));
    for (const receipt of relayResults) if (known.get(receipt.relay)?.state !== "published") known.set(receipt.relay, receipt);
    const republication: Republication = { attemptedAt: new Date().toISOString(), relayResults };
    const saved = await this.query<Row>("UPDATE development_publications SET prepared=jsonb_set(prepared,'{republication}',$2::jsonb),relay_results=$3::jsonb,updated_at=now() WHERE id=$1 AND state='published' AND prepared->>'supersededBy' IS NULL RETURNING *", [row.id, JSON.stringify(republication), JSON.stringify([...known.values()])]);
    if (!saved.rows[0]) return { status: "rejected", code: "PUBLICATION_NOT_PUBLISHED" };
    return this.projection(saved.rows[0]);
  }
  private async uploadCvmBlob(digest: string, contentType: string, bytes: Uint8Array) {
    const authorization = await createUploadAuthorization({ sign: template => this.options.sign(template) }, [digest], undefined, new URL(this.origin).hostname);
    const response = await fetch(`${this.#localOrigin}/upload`, { method: "PUT", headers: { authorization, "x-sha-256": digest, "content-type": contentType }, body: new Uint8Array(bytes).buffer, signal: AbortSignal.timeout(15000) });
    if (!response.ok || (await response.json() as any).sha256 !== digest) throw new Error("CVM_BLOB_UPLOAD_FAILED");
  }
  private async publishApplication(row: Row, send: boolean | "always") {
    const application = row.prepared.application;
    if (!application?.signedEvent || !row.prepared.relays?.length) return;
    // Listing delivery never downgrades an applet's independently confirmed
    // publication. Preserve prior receipts when a later resend is unavailable.
    const results = await publishOnUserRelays(row.prepared.relays, application.signedEvent, this.options.relay, send);
    const known = new Map((application.relayResults ?? []).map(receipt => [receipt.relay, receipt]));
    for (const receipt of results) if (known.get(receipt.relay)?.state !== "published") known.set(receipt.relay, receipt);
    application.relayResults = [...known.values()];
    await this.query("UPDATE development_publications SET prepared=jsonb_set(prepared,'{application,relayResults}',$2::jsonb),updated_at=now() WHERE id=$1", [row.id, JSON.stringify(application.relayResults)]);
  }
  private async restoreConfirmed(row: Row) {
    if (row.state !== "unconfirmed" || row.prepared.preview || row.prepared.supersededBy || !row.signed_event) return;
    if (!row.relay_results?.some(receipt => receipt.state === "published" && row.prepared.relays?.includes(receipt.relay))) return;
    const servers = row.prepared.template.tags.filter(tag => tag[0] === "server").map(tag => tag[1]!);
    if (verifiedPublicationServers(row.prepared.files, servers, row.file_results ?? []).length < MIN_PUBLICATION_SERVERS) return;
    const saved = await this.query<Row>("UPDATE development_publications SET state='published',published_at=coalesce(published_at,updated_at),updated_at=now() WHERE id=$1 AND state='unconfirmed' AND prepared->>'supersededBy' IS NULL RETURNING *", [row.id]);
    if (saved.rows[0]) Object.assign(row, saved.rows[0]);
  }
  private setState(id: string, state: Row["state"]) { return this.query("UPDATE development_publications SET state=$2,published_at=CASE WHEN $2='published' THEN coalesce(published_at,now()) ELSE published_at END,updated_at=now() WHERE id=$1", [id, state]); }
  private async observe(row: Row): Promise<boolean> {
    if (!row.signed_event) return false;
    if (row.prepared.relays && !row.prepared.preview) {
      row.relay_results = await publishOnUserRelays(row.prepared.relays, row.signed_event, this.options.relay, false);
      await this.query("UPDATE development_publications SET relay_results=$2,updated_at=now() WHERE id=$1", [row.id, JSON.stringify(row.relay_results)]);
      return row.relay_results.some(result => result.state === "published");
    }
    const pool = new SimplePool();
    try {
      const found = await pool.get([this.options.relay], { ids: [row.signed_event.id] }, { maxWait: 8000 });
      if (!found || found.id !== row.signed_event.id || !verifyEvent(found)) return false;
      if (row.prepared.preview) for (const file of row.prepared.files) {
        const response = await fetch(`${this.#localOrigin}/${file.sha256}`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok || hash(new Uint8Array(await response.arrayBuffer())) !== file.sha256) return false;
      }
      return true;
    } catch { return false; } finally { pool.close([this.options.relay]); pool.destroy(); }
  }
  private async asset(request: Request): Promise<Response> {
    try {
      if (!["GET", "HEAD"].includes(request.method)) return this.#blossom.handle(request);
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== new URL(this.origin).hostname) return new Response("not found", { status: 404 });
      const open = /^\/open\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (open) {
        const row = (await this.query<Row>("SELECT * FROM development_publications WHERE id=$1 AND state='published'", [open[1]])).rows[0];
        if (!row) return new Response("not found", { status: 404 });
        if (!this.#previews.has(row.id)) this.#previews.set(row.id, this.options.openTarget(`${this.origin}/site/${row.id}/index.html`).catch(error => { this.#previews.delete(row.id); throw error; }));
        const target = new URL(await this.#previews.get(row.id)!); target.searchParams.set("presentation", "workspace");
        return Response.redirect(target.href, 302);
      }
      const site = /^\/site\/([a-f0-9-]{36})\/(.+)$/.exec(url.pathname);
      let digest: string | undefined; let contentType = "application/octet-stream";
      if (site) {
        const row = (await this.query<Row>("SELECT * FROM development_publications WHERE id=$1 AND state='published'", [site[1]])).rows[0];
        const file = row?.prepared.files.find(file => file.path === decodeURIComponent(site[2]!)); digest = file?.sha256; if (file) contentType = mime(file.path);
      }
      if (!digest) return this.#blossom.handle(request);
      const bytes = await readFile(resolve(this.options.root, "blobs", digest));
      if (hash(bytes) !== digest) return new Response("unavailable", { status: 503 });
      return new Response(request.method === "HEAD" ? null : bytes, { headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "content-security-policy": "sandbox allow-scripts; default-src 'self' blob: data:; connect-src 'none'", "referrer-policy": "no-referrer" } });
    } catch { return new Response("not found", { status: 404 }); }
  }
}
