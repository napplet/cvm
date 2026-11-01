import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { hkdfSync } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

/** Fixed container mounts. Hosts differ by inventory, not by code paths. */
export const SERVICE_CONFIG_PATH = "/etc/napplet-cvm/service.json";
export const SERVICE_SECRETS_DIR = "/run/secrets/napplet-cvm";

const https = z.string().url().refine((value) => new URL(value).protocol === "https:" && !new URL(value).search && !new URL(value).hash, "https origin required");
const wsUrl = z.string().url().refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol), "websocket URL required");
const absolute = z.string().regex(/^\/[A-Za-z0-9._/-]{1,511}$/u);

/**
 * Non-secret deployment configuration. Each concern names one concrete
 * adapter; there is no provider fallback or ambient default.
 *
 * - `realm: "test"` is an ordinary deployment whose balances are test credits.
 * - `realm: "real"` holds real money. It requires TLS wallet relays, public
 *   HTTPS mints without private routes, a configured paid model, and a
 *   database that was initialized for the real realm.
 */
export const ServiceConfigSchema = z.object({
  version: z.literal(1),
  realm: z.enum(["test", "real"]),
  listen: z.object({ port: z.number().int().min(1).max(65535) }).strict(),
  origins: z.object({ public: https, preview: https, blobs: https, relay: wsUrl }).strict(),
  /** Relay the service subscribes to for ContextVM requests (often private to the stack). */
  relay: z.object({ url: wsUrl }).strict(),
  database: z.object({ adapter: z.literal("postgresql"), maxConnections: z.number().int().min(2).max(64).default(10), statementTimeoutMs: z.number().int().min(1000).max(60_000).default(5000) }).strict(),
  storage: z.object({ adapter: z.literal("filesystem"), root: absolute }).strict(),
  funding: z.object({
    nwc: z.object({ adapter: z.literal("nip47-receive-only") }).strict(),
    cashu: z.object({ mintPolicyVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,63}$/u), /** The Cashu mint policy requires at least two independent mints. */
    mints: z.array(z.object({ url: https, route: z.string().url().optional() }).strict()).min(2).max(8) }).strict(),
    reserveSat: z.string().regex(/^[1-9][0-9]{0,8}$/u).default("3750"),
  }).strict(),
  model: z.object({
    adapter: z.literal("openai-responses"),
    /** Mounted, non-secret pricing document: model, profile, priceCard, priceSources. */
    pricingFile: absolute,
  }).strict(),
  worker: z.object({
    adapter: z.literal("docker"),
    image: z.string().min(3).max(256),
    /** OCI runtime used for untrusted builds, e.g. `runsc` (gVisor). */
    runtime: z.string().regex(/^[a-z][a-z0-9_.-]{1,31}$/u),
  }).strict(),
  policy: z.object({ version: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,63}$/u) }).strict(),
}).strict().superRefine((config, ctx) => {
  if (config.realm !== "real") return;
  if (new URL(config.origins.relay).protocol !== "wss:") ctx.addIssue({ code: "custom", path: ["origins", "relay"], message: "real realm requires wss" });
  if (config.funding.cashu.mints.some((mint) => mint.route)) ctx.addIssue({ code: "custom", path: ["funding", "cashu", "mints"], message: "real realm mints cannot be privately routed" });
  if (config.worker.runtime === "runc") ctx.addIssue({ code: "custom", path: ["worker", "runtime"], message: "real realm requires a sandboxed OCI runtime" });
});

export type ServiceConfig = Readonly<z.infer<typeof ServiceConfigSchema>>;

export function parseServiceConfig(value: unknown): ServiceConfig {
  const parsed = ServiceConfigSchema.parse(value);
  const serialized = JSON.stringify(parsed).toLowerCase();
  if (parsed.realm === "real" && ["fakewallet", "faucet", "fixture", "development-only", ".invalid"].some((marker) => serialized.includes(marker))) throw new Error("SERVICE_REAL_REALM_TEST_MARKER");
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); }
  return value;
}

/** Reads a regular, non-symlinked mounted file with a size bound. */
export async function readMountedFile(path: string, maxBytes: number, options: Readonly<{ private?: boolean }> = {}): Promise<Uint8Array> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error(`SERVICE_MOUNT_UNAVAILABLE:${path}`); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error(`SERVICE_MOUNT_INVALID:${path}`);
    if (options.private && (stat.mode & 0o007) !== 0) throw new Error(`SERVICE_SECRET_WORLD_READABLE:${path}`);
    return new Uint8Array(await handle.readFile());
  } finally { await handle.close(); }
}

export async function loadServiceConfig(path = SERVICE_CONFIG_PATH): Promise<ServiceConfig> {
  const raw = await readMountedFile(path, 64_000);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new Error("SERVICE_CONFIG_INVALID_JSON"); }
  return parseServiceConfig(value);
}

/** Secret files mounted by the deployment. Values never enter config or logs. */
export const SERVICE_SECRET_NAMES = ["database_url", "service_seed", "nwc_uri", "openai_api_key"] as const;
export type ServiceSecretName = typeof SERVICE_SECRET_NAMES[number];

export class ServiceSecrets {
  constructor(private readonly directory = SERVICE_SECRETS_DIR) {}
  async text(name: ServiceSecretName): Promise<string> {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(await readMountedFile(join(this.directory, name), 8192, { private: true })).trim();
    if (!value) throw new Error(`SERVICE_SECRET_EMPTY:${name}`);
    return value;
  }
}

export type ServiceIdentity = Readonly<{ signerPrivateKey: string; admissionSecret: Uint8Array; cursorSecret: Uint8Array; fundingKey: Uint8Array; pendingActionKey: Uint8Array }>;

/**
 * One persistent 32-byte seed defines the service's Nostr identity and its
 * independent server-side keys. Preserving this secret preserves identity.
 */
export function deriveServiceIdentity(seedHex: string): ServiceIdentity {
  if (!/^[a-f0-9]{64}$/u.test(seedHex)) throw new Error("SERVICE_SEED_INVALID");
  const seed = Buffer.from(seedHex, "hex");
  const derive = (purpose: string) => new Uint8Array(hkdfSync("sha256", seed, "napplet-cvm/service/v1", purpose, 32));
  try {
    const signer = derive("nostr-signer");
    const signerPrivateKey = Buffer.from(signer).toString("hex");
    signer.fill(0);
    const scalar = BigInt(`0x${signerPrivateKey}`);
    if (scalar === 0n || scalar >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n) throw new Error("SERVICE_SEED_SCALAR_INVALID");
    return Object.freeze({ signerPrivateKey, admissionSecret: derive("admission-receipt"), cursorSecret: derive("session-status-cursor"), fundingKey: derive("protected-rail-material"), pendingActionKey: derive("pending-action-checkpoint") });
  } finally { seed.fill(0); }
}
