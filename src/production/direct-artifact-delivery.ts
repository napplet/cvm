import { z } from "zod";
import { unpackEventFromToken, validateEvent } from "nostr-tools/nip98";
import { DirectArtifactDeliverySchema } from "../publication/direct-delivery";
import { ProductionOwnedDirectArtifacts } from "./owned-direct-artifacts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Auth = z.object({ kind: z.literal(27235), id: Digest, pubkey: Digest, sig: z.string().regex(/^[a-f0-9]{128}$/u),
  created_at: z.number().int().positive(), content: z.literal(""), tags: z.array(z.array(z.string().max(4096)).length(2)).length(2) }).strict();
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "access-control-allow-origin": "*", vary: "Authorization" };
const unavailable = (status: number) => new Response(JSON.stringify({ code: status === 401 ? "SIGNED_ARTIFACT_READ_REQUIRED" : "ARTIFACT_NOT_AVAILABLE" }), { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
const sandboxCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function origin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/") throw new Error("PRODUCTION_ARTIFACT_ORIGIN_REQUIRED");
  return url.origin;
}

/** Concrete GET-only, signed delivery. The signature audience comes from
 * configuration, never Host/forwarded headers. No token/key enters the HTML. */
export class ProductionDirectArtifactDelivery {
  readonly #origins: Readonly<{ preview: string; artifacts: string }>;
  constructor(private readonly input: Readonly<{ artifacts: ProductionOwnedDirectArtifacts; previewOrigin: string; artifactOrigin: string }>) {
    if (!(input.artifacts instanceof ProductionOwnedDirectArtifacts)) throw new Error("PRODUCTION_OWNED_ARTIFACT_READER_REQUIRED");
    this.#origins = Object.freeze({ preview: origin(input.previewOrigin), artifacts: origin(input.artifactOrigin) });
  }
  readonly preview = (request: Request) => this.#handle("preview", request);
  readonly artifact = (request: Request) => this.#handle("artifacts", request);

  async #handle(kind: "preview" | "artifacts", request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`/${kind}/nip5d-direct-v1/`)) return new Response(JSON.stringify({ code: kind === "preview" ? "PREVIEW_NOT_CONFIGURED" : "ARTIFACT_NOT_CONFIGURED" }), { status: 404, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
      const route = /^\/(preview|artifacts)\/nip5d-direct-v1\/([^/]+)\/(artifact:[a-f0-9]{64})(\/index\.html)?$/u.exec(url.pathname);
      if (!route || route[1] !== kind || Boolean(route[4]) !== (kind === "artifacts") || url.search || url.hash) return unavailable(404);
      const sessionId = decodeURIComponent(route[2]!);
      if (!sessionId || sessionId.length > 256 || encodeURIComponent(sessionId) !== route[2]) return unavailable(404);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET", "access-control-allow-headers": "Authorization", "access-control-max-age": "0" } });
      if (request.method !== "GET" || request.body || request.headers.has("transfer-encoding") || ![null, "0"].includes(request.headers.get("content-length"))) return unavailable(404);
      const token = request.headers.get("authorization");
      if (!token || token.length > 8192 || !/^Nostr [A-Za-z0-9+/]+={0,2}$/u.test(token)) return unavailable(401);
      let event: z.infer<typeof Auth>;
      try {
        event = Auth.parse(await unpackEventFromToken(token));
        const age = Date.now() / 1000 - event.created_at, publicUrl = `${this.#origins[kind]}${url.pathname}`;
        if (age < -5 || age >= 60 || event.tags.filter(tag => tag[0] === "u").length !== 1 || event.tags.filter(tag => tag[0] === "method").length !== 1
          || !event.tags.some(tag => tag[0] === "u" && tag[1] === publicUrl) || !event.tags.some(tag => tag[0] === "method" && tag[1] === "GET")
          || !await validateEvent(event, publicUrl, "GET")) return unavailable(401);
      } catch { return unavailable(401); }
      const owned = await this.input.artifacts.readVerified({ principal: { pubkey: event.pubkey }, sessionId, artifactId: route[3] });
      if (!owned) return unavailable(404);
      const file = owned.archive.files[0]!, bytes = Buffer.from(file.bytesBase64, "base64");
      if (kind === "artifacts") return new Response(bytes, { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": sandboxCsp, "x-napplet-artifact-contract": "nip5d-direct-v1", "x-napplet-artifact-sha256": file.sha256 } });
      const value = DirectArtifactDeliverySchema.parse({ version: "direct-artifact-delivery-v1", artifactContract: owned.archive.artifactContract,
        artifact: { sessionId, artifactId: owned.artifactId, artifactVersion: owned.artifactVersion, artifactHash: owned.archive.artifactHash, archiveSha256: owned.archive.checksum,
          verificationEvidenceSha256: owned.archive.verificationEvidenceSha256, conformanceReceiptSha256: owned.archive.receipts.conformance.sha256,
          manifestReceiptSha256: owned.archive.receipts.manifest.sha256, policyVersion: owned.policyVersion, toolchainSha256: owned.archive.build.toolchainSha256 },
        entrypoint: { path: "/index.html", mimeType: "text/html", sha256: file.sha256, size: bytes.length, bytesBase64: file.bytesBase64 },
        capabilities: owned.archive.declaration, ownerManifestTemplate: owned.archive.manifest });
      return new Response(JSON.stringify(value), { headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
    } catch { return unavailable(404); }
  }
}
