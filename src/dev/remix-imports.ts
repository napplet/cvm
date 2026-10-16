import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { canonicalJson } from "../promotion/schema";
import { RemixContextSchema, type RemixContext } from "../remix/context";
import { REMIX_HTML_CONTEXT_LIMIT, RemixEventSchema, RemixReferenceSchema, remixManifest, verifiedRemixAsset } from "../remix/manifest";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";
import type { LocalRemixSourceImporter } from "./remix-source-import";

const Command = z.object({ naddr: z.string().max(4096), event: RemixEventSchema, assetUploaded: z.boolean().optional() }).strict();
export class DevelopmentRemixImports {
  #active = new Map<string, Promise<unknown>>();
  constructor(private readonly pool: Pick<PostgresSqlClient,"query">, private readonly source: Pick<LocalRemixSourceImporter,"import">, private readonly progress: (state: "running" | "completed") => void = () => {}) {}
  async prepare(input: unknown, verifiedPubkey: string) {
    const account = await accountIdForPrincipal({ pubkey: verifiedPubkey });
    if ((input as { action?: unknown })?.action === "asset_part") {
      const part = z.object({ action: z.literal("asset_part"), eventId: z.string().regex(/^[a-f0-9]{64}$/u), artifactHash: z.string().regex(/^[a-f0-9]{64}$/u), index: z.number().int().min(0).max(15), total: z.number().int().min(1).max(16), data: z.string().min(1).max(10668).regex(/^[A-Za-z0-9+/]+={0,2}$/u) }).strict().parse(input);
      if (part.index >= part.total || Buffer.from(part.data, "base64").length > 8000 || Buffer.from(part.data, "base64").toString("base64") !== part.data) throw new Error("REMIX_PART_INVALID");
      await this.pool.query("DELETE FROM development_remix_parts WHERE created_at < now() - interval '1 hour'");
      const count = Number((await this.pool.query("SELECT count(*) AS count FROM development_remix_parts WHERE account_id=$1", [account])).rows[0]?.count);
      if (count >= 192) throw new Error("REMIX_IMPORT_LIMIT");
      await this.pool.query("INSERT INTO development_remix_parts(account_id,event_id,artifact_hash,part_index,part_count,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [account,part.eventId,part.artifactHash,part.index,part.total,part.data]);
      return { status: "part_saved" };
    }
    const command = Command.parse(input); const manifest = remixManifest(command.event, command.naddr);
    const saved = (await this.pool.query("SELECT reference,context_json FROM development_remix_imports WHERE account_id=$1 AND event_id=$2", [account, manifest.event.id])).rows[0];
    const summary = (reference: string, context: RemixContext) => ({ status: "ready", reference, title: manifest.title, naddr: manifest.naddr, basis: context.basis.kind, ...(context.basis.kind === "source" ? { commit: context.basis.commit } : {}), detail: context.basis.kind === "source" ? "Using the linked source. It may differ from the published applet." : manifest.source ? "Source wasn’t available in a supported form. Using the verified applet file." : "Using the verified applet file." });
    if (saved) return summary(String(saved.reference), RemixContextSchema.parse(saved.context_json));
    let html: string | undefined;
    if (command.assetUploaded) {
      const parts = (await this.pool.query("SELECT part_index,part_count,data FROM development_remix_parts WHERE account_id=$1 AND event_id=$2 AND artifact_hash=$3 ORDER BY part_index", [account,manifest.event.id,manifest.artifactHash])).rows;
      if (!parts.length || parts.length !== parts[0]!.part_count || parts.some((part,index) => part.part_index !== index || part.part_count !== parts.length)) throw new Error("REMIX_ASSET_INCOMPLETE");
      const bytes = Buffer.concat(parts.map(part => Buffer.from(String(part.data), "base64")));
      if (bytes.length > REMIX_HTML_CONTEXT_LIMIT) throw new Error("REMIX_ASSET_LIMIT");
      html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      await verifiedRemixAsset(html, manifest.artifactHash);
    }
    if (this.#active.has(account) || this.#active.size >= 2) throw new Error("REMIX_IMPORT_BUSY");
    const work = (async () => {
      this.progress("running");
      const origin = { eventId: manifest.event.id, author: manifest.event.pubkey, artifactHash: manifest.artifactHash };
      const imported = manifest.source ? await this.source.import(manifest.source, AbortSignal.timeout(60000)).catch(() => undefined) : undefined;
      if (!imported && !html) throw new Error("REMIX_SOURCE_UNAVAILABLE");
      const context = RemixContextSchema.parse({ origin, basis: imported ? { kind: "source", ...imported } : { kind: "html", html } });
      if (Buffer.byteLength(JSON.stringify(context)) > 140000) throw new Error("REMIX_CONTEXT_TOO_LARGE");
      const reference = `remix:${new Bun.CryptoHasher("sha256").update(canonicalJson({ account, context })).digest("hex")}`;
      await this.pool.query("INSERT INTO development_remix_imports(reference,account_id,event_id,artifact_hash,manifest_json,context_json) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,event_id) DO NOTHING", [reference, account, manifest.event.id, manifest.artifactHash, JSON.stringify(manifest.event), JSON.stringify(context)]);
      const row = (await this.pool.query("SELECT reference,context_json FROM development_remix_imports WHERE account_id=$1 AND event_id=$2", [account, manifest.event.id])).rows[0]!;
      this.progress("completed"); return summary(String(row.reference), RemixContextSchema.parse(row.context_json));
    })().finally(() => this.#active.delete(account));
    this.#active.set(account, work); return work;
  }
  async load(accountId: string, reference: string): Promise<RemixContext | undefined> {
    const row = (await this.pool.query("SELECT context_json FROM development_remix_imports WHERE account_id=$1 AND reference=$2", [accountId, RemixReferenceSchema.parse(reference)])).rows[0];
    return row ? RemixContextSchema.parse(row.context_json) : undefined;
  }
}
