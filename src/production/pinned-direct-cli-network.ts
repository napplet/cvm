import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Event, EventTemplate } from "nostr-tools/pure";

export const DIRECT_CLI_NETWORK_IDENTITY = Object.freeze({ version: "0.13.0", sourceCommit: "3c6e3ae33fea425b2f151740c0bd8c02f509ef7b",
  bundleSha256: "2e50a73810bf8017b9569dd771842326b8ecc254dd912e92aaf9a43ab3a1a756" });
const sourceFiles = {
  "blossom-upload.ts": "05200f167d295900c7e5d12e6e5c2791f352c379290feeb095f0e6da1eb9ac50", "path.ts": "0672896e4ca1004047e7e41a94e9947ec1a0fbe33daa0247eb0e3e42a0594eb9",
  "types.ts": "ba999952df90a35649caf3fe7b989b17595116c9884adb72111a676c645a2675", "signing.ts": "be5bbc8205227ae09447e87fb0e7d6f0da5f12da6b94601e8609f98b991ef858",
  "deploy-network.ts": "5e40bd4674554cedfc67c2b922d04ff930dde0aa7ec0556c83ca28c1a42392ba",
};
const Provenance = z.object({ schemaVersion: z.literal(1), status: z.literal("prepared-source-helper-not-promoted"), artifactContract: z.literal("nip5d-direct-v1"),
  version: z.literal(DIRECT_CLI_NETWORK_IDENTITY.version), sourceCommit: z.literal(DIRECT_CLI_NETWORK_IDENTITY.sourceCommit), bundleSha256: z.literal(DIRECT_CLI_NETWORK_IDENTITY.bundleSha256),
  sourceLockSha256: z.literal("7b08677e37bbfedfde17343a3612d223a547b8bf058df7e6c9c73881f9e7c0eb"), buildLockSha256: z.literal("363cebbc9a8ca0cf5ef7cc7c81ccf2f598bb49ef0dfb6ae696b4a529cdc6f06d"),
  sourceFiles: z.record(z.string(), z.string()), runtimeVersion: z.literal("2.9.6"), runtimeBinarySha256: z.literal("bceb5b6a6239b0b010418406d8c77a508f67cf4337d94288f1c19fe71304aab0"),
  exports: z.tuple([z.literal("createUploadAuthorization"), z.literal("publishEventWithSimplePool"), z.literal("uploadFilesToServers")]),
  build: z.literal("scripts/rebuild-napplet-upload-helper.ts --profile capabilities"), productionEvidence: z.literal(false), selected: z.literal(false),
}).strict().refine(value => Object.keys(value.sourceFiles).length === Object.keys(sourceFiles).length && Object.entries(sourceFiles).every(([file, hash]) => value.sourceFiles[file] === hash), "DIRECT_CLI_SOURCE_FILES_MISMATCH");
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const UploadResult = z.array(z.object({ server: z.string().url().max(512), file: z.string().min(1).max(1024), sha256: Digest, success: z.boolean(), skipped: z.boolean(), error: z.string().max(4096).optional() }).strict()).max(256);
const RelayResult = z.array(z.object({ relay: z.string().url().max(512), eventId: Digest, success: z.boolean(), error: z.string().max(4096).optional() }).strict()).max(16);
type Signer = Readonly<{ sign(template: EventTemplate): Promise<Event> }>;
type File = Readonly<{ candidateDir: string; path: string; sha256: string; data: Uint8Array; contentType: string }>;

/** Distinct direct source provenance and closed surface, never a promoted CLI
 * binary identity. Check the same in-memory bytes before importing them to
 * prevent a file replacement between validation and execution. No caller path. */
export async function loadPinnedDirectCliNetworkHelpers() {
  Provenance.parse(JSON.parse(await readFile(new URL("../../vendor/napplet-cli-3c6e3ae3/provenance.json", import.meta.url), "utf8")));
  const bytes = await readFile(new URL("../../vendor/napplet-cli-3c6e3ae3/network-helpers.mjs", import.meta.url));
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== DIRECT_CLI_NETWORK_IDENTITY.bundleSha256) throw new Error("DIRECT_CLI_NETWORK_SOURCE_MISMATCH");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/javascript" }));
  let module: Record<string, unknown>;
  try { module = await import(url); } finally { URL.revokeObjectURL(url); }
  const auth = module.createUploadAuthorization, upload = module.uploadFilesToServers, publish = module.publishEventWithSimplePool;
  if (Object.keys(module).sort().join() !== "createUploadAuthorization,publishEventWithSimplePool,uploadFilesToServers" || typeof auth !== "function" || typeof upload !== "function" || typeof publish !== "function") throw new Error("DIRECT_CLI_NETWORK_SURFACE_INVALID");
  return Object.freeze({
    identity: DIRECT_CLI_NETWORK_IDENTITY,
    async createUploadAuthorization(signer: Signer, hashes: readonly string[], nowSeconds: number, serverHost: string) {
      const approved = z.array(Digest).min(1).max(256).parse(hashes);
      const server = new URL(`https://${serverHost}`);
      if (new Set(approved).size !== approved.length || !Number.isSafeInteger(nowSeconds) || nowSeconds <= 0 || serverHost.length > 253
        || server.origin !== `https://${serverHost}` || server.hostname !== serverHost || server.pathname !== "/" || server.search || server.hash) throw new Error("DIRECT_CLI_AUTHORIZATION_SCOPE_REQUIRED");
      const value: unknown = await auth(signer, approved, () => nowSeconds, serverHost);
      return z.string().min(1).max(65536).regex(/^Nostr [A-Za-z0-9_-]+$/u).parse(value);
    },
    async uploadFilesToServers(files: readonly File[], servers: readonly string[], signer: Signer, options: Readonly<{ now(): number; fetch: typeof fetch }>) {
      const value: unknown = await upload(files, servers, signer, options);
      return UploadResult.parse(value);
    },
    async publishEventWithSimplePool(relays: readonly string[], event: Event) {
      const value: unknown = await publish(relays, event);
      return RelayResult.parse(value);
    },
  });
}
