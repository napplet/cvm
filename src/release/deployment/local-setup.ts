import { z } from "zod";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../../promotion/schema";
import {
  createOperatorFundingPrerequisiteController,
  validateOperatorFundingReadiness,
  type OperatorFundingRail,
  type OperatorFundingReadiness,
  type OperatorFundingReadinessStore,
} from "./operator-funding";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const OpaqueReferenceSchema = z.string().regex(/^os-secret-ref:[a-z][a-z0-9._-]{2,127}$/u);
const RailSchema = z.enum(["nwc_lightning", "cashu"]);

type LoopbackSubmission = Readonly<{
  state: string;
  csrf: string;
  rail: OperatorFundingRail;
  /** Native material arrives as binary directly to the secret-store writer.
   * It is never accepted from argv, env, JSON, a receipt, or a chat string. */
  material: Uint8Array;
}>;

export type LocalFundingLoopbackPort = Readonly<{
  listen(input: Readonly<{
    host: "127.0.0.1";
    state: string;
    csrf: string;
    expiresAtMs: number;
    submit(input: unknown): Promise<void>;
  }>): Promise<Readonly<{ url: string; close(): Promise<void> }>>;
}>;
export type LocalFundingBrowserPort = Readonly<{ open(url: string): Promise<void> }>;
export type OsSecretStorePort = Readonly<{
  store(input: Readonly<{ rail: OperatorFundingRail; material: Uint8Array }>): Promise<Readonly<{
    secretReference: string;
    capabilitySha256: string;
    accountScopeSha256: string;
  }>>;
}>;

export type LocalFundingSetupDescriptor = Readonly<{
  kind: "local_operator_funding_setup";
  status: "action_required";
  plan: "07-20";
  candidateSha256: string;
  authorizationRequestSha256?: string;
  rails: readonly OperatorFundingRail[];
}>;

export type LocalOperatorFundingSetupOptions = Readonly<{
  candidateSha256: string;
  authorizationRequestSha256?: string;
  loopback: LocalFundingLoopbackPort;
  browser: LocalFundingBrowserPort;
  secrets: OsSecretStorePort;
  readinessStore: OperatorFundingReadinessStore;
  now?: () => number;
  expiresInMs?: number;
}>;

function entropy(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function validTime(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function parseSubmission(input: unknown, state: string, csrf: string, expiresAtMs: number, now: () => number): LoopbackSubmission {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as Record<string, unknown>).some((key) => !["state", "csrf", "rail", "material"].includes(key))) {
    throw new Error("LOCAL_FUNDING_MATERIAL_REJECTED");
  }
  const value = input as Partial<LoopbackSubmission>;
  if (value.state !== state || value.csrf !== csrf) throw new Error("LOCAL_FUNDING_SESSION_REJECTED");
  if (!validTime(now()) || now() >= expiresAtMs) throw new Error("LOCAL_FUNDING_SESSION_EXPIRED");
  const rail = RailSchema.safeParse(value.rail);
  if (!rail.success || !(value.material instanceof Uint8Array) || value.material.byteLength === 0 || value.material.byteLength > 65_536) {
    throw new Error("LOCAL_FUNDING_MATERIAL_REJECTED");
  }
  return Object.freeze({ state, csrf, rail: rail.data, material: new Uint8Array(value.material) });
}

/**
 * Creates, but does not launch, the Plan 07-20 local wallet setup flow. It is
 * intentionally all-injected: this autonomous plan never opens a browser,
 * wallet, keychain, listener, or OS secret facility. On a real macOS launch,
 * Plan 07-20 supplies an OS-keychain-backed `secrets` port; unsupported
 * platforms must reject rather than fall back to a plaintext file.
 */
export async function createLocalOperatorFundingSetup(options: LocalOperatorFundingSetupOptions) {
  const candidate = DigestSchema.safeParse(options.candidateSha256);
  const request = options.authorizationRequestSha256 === undefined ? undefined : DigestSchema.safeParse(options.authorizationRequestSha256);
  if (!candidate.success || (request && !request.success) || !options.loopback || !options.browser || !options.secrets || !options.readinessStore) throw new Error("LOCAL_FUNDING_SETUP_INVALID");
  const now = options.now ?? Date.now;
  const expiresInMs = options.expiresInMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 10 * 60 * 1000 || !validTime(now())) throw new Error("LOCAL_FUNDING_SETUP_INVALID");
  const prerequisites = createOperatorFundingPrerequisiteController({ now });
  let active: Readonly<{ state: string; csrf: string; expiresAtMs: number; close: () => Promise<void> }> | undefined;
  const descriptor = (): LocalFundingSetupDescriptor => Object.freeze({
    kind: "local_operator_funding_setup", status: "action_required", plan: "07-20",
    candidateSha256: candidate.data, ...(request?.success ? { authorizationRequestSha256: request.data } : {}),
    rails: Object.freeze(["nwc_lightning", "cashu"] as const),
  });
  const submit = async (input: unknown): Promise<void> => {
    if (!active) throw new Error("LOCAL_FUNDING_SESSION_REJECTED");
    const submission = parseSubmission(input, active.state, active.csrf, active.expiresAtMs, now);
    let stored: Awaited<ReturnType<OsSecretStorePort["store"]>>;
    try { stored = await options.secrets.store(Object.freeze({ rail: submission.rail, material: submission.material })); }
    finally { submission.material.fill(0); }
    const reference = OpaqueReferenceSchema.safeParse(stored?.secretReference);
    const capabilitySha256 = DigestSchema.safeParse(stored?.capabilitySha256);
    const accountScopeSha256 = DigestSchema.safeParse(stored?.accountScopeSha256);
    if (!reference.success || !capabilitySha256.success || !accountScopeSha256.success) throw new Error("LOCAL_FUNDING_SECRET_STORE_REJECTED");
    await prerequisites.capture({
      rail: submission.rail, secretReference: reference.data, capabilitySha256: capabilitySha256.data,
      accountScopeSha256: accountScopeSha256.data, expiresAtMs: active.expiresAtMs, status: "ready",
    });
    const readiness = await prerequisites.readiness();
    await options.readinessStore.write(readiness);
    if (readiness.status === "ready") {
      await active.close();
      active = undefined;
    }
  };
  return Object.freeze({
    descriptor,
    async launch(): Promise<void> {
      if (active) throw new Error("LOCAL_FUNDING_SESSION_ACTIVE");
      const state = entropy(); const csrf = entropy(); const expiresAtMs = now() + expiresInMs;
      if (!validTime(expiresAtMs)) throw new Error("LOCAL_FUNDING_SETUP_INVALID");
      const listener = await options.loopback.listen(Object.freeze({ host: "127.0.0.1", state, csrf, expiresAtMs, submit }));
      active = Object.freeze({ state, csrf, expiresAtMs, close: listener.close });
      const url = new URL(listener.url);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.searchParams.get("state") !== state) throw new Error("LOCAL_FUNDING_LOOPBACK_REJECTED");
      await options.browser.open(listener.url);
    },
    async readiness(): Promise<OperatorFundingReadiness> { return prerequisites.readiness(); },
  });
}

/** Explicitly reject implicit cross-platform fallback. A real production port
 * is supplied only by the authorized Plan 07-20 macOS launcher. */
export function requireMacOsSecretStore(): void {
  if (process.platform !== "darwin") throw new Error("LOCAL_FUNDING_OS_SECRET_STORE_UNSUPPORTED");
}

async function sha256Bytes(label: string, material: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`${label}\0`);
  const bytes = new Uint8Array(prefix.byteLength + material.byteLength);
  bytes.set(prefix); bytes.set(material, prefix.byteLength);
  try {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally { bytes.fill(0); prefix.fill(0); }
}

/** macOS Keychain writer. Native wallet bytes cross only the subprocess stdin
 * pipe; argv contains a fixed service/account label and stdout/stderr are
 * discarded. */
export function createMacOsKeychainSecretStore(): OsSecretStorePort {
  requireMacOsSecretStore();
  return Object.freeze({
    async store(input) {
      const rail = RailSchema.parse(input.rail);
      if (!(input.material instanceof Uint8Array) || input.material.byteLength === 0 || input.material.byteLength > 65_536) throw new Error("LOCAL_FUNDING_MATERIAL_REJECTED");
      const service = `napplet-cvm.operator-funding.${rail}`;
      const child = Bun.spawn(["security", "add-generic-password", "-a", "operator", "-s", service, "-U", "-w"], {
        stdin: "pipe", stdout: "ignore", stderr: "ignore",
      });
      child.stdin.write(input.material);
      child.stdin.end();
      if (await child.exited !== 0) throw new Error("LOCAL_FUNDING_SECRET_STORE_REJECTED");
      return Object.freeze({
        secretReference: `os-secret-ref:napplet-cvm-${rail.replace("_", "-")}`,
        capabilitySha256: await sha256Bytes(`capability:${rail}`, input.material),
        accountScopeSha256: await sha256Bytes(`account:${rail}`, input.material),
      });
    },
  });
}

export function createMacOsBrowserPort(): LocalFundingBrowserPort {
  if (process.platform !== "darwin") throw new Error("LOCAL_FUNDING_BROWSER_UNSUPPORTED");
  return Object.freeze({ async open(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") throw new Error("LOCAL_FUNDING_LOOPBACK_REJECTED");
    const child = Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (await child.exited !== 0) throw new Error("LOCAL_FUNDING_BROWSER_LAUNCH_FAILED");
  } });
}

const page = (state: string, csrf: string, message = "Connect both service wallets. Values go directly to macOS Keychain and are never written to this repository.") => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer">
<title>napplet-cvm funding setup</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;background:#10151d;color:#edf3fa}form{margin:1.5rem 0;padding:1.25rem;border:1px solid #334155;border-radius:.75rem}input,button{box-sizing:border-box;width:100%;padding:.75rem;margin-top:.6rem}button{cursor:pointer}code{color:#93c5fd}</style>
<h1>Local funding setup</h1><p>${message}</p>
${(["nwc_lightning", "cashu"] as const).map((rail) => `<form method="post" action="/napplet-cvm/funding-setup"><input type="hidden" name="state" value="${state}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="rail" value="${rail}"><label>${rail === "nwc_lightning" ? "NWC connection string" : "Funded Cashu wallet material"}<input required autocomplete="off" type="password" name="material"></label><button type="submit">Store ${rail === "nwc_lightning" ? "NWC" : "Cashu"} securely</button></form>`).join("")}
<p>This page expires in ten minutes. You may close it after both entries are stored.</p></html>`;

/** A single-use loopback-only browser surface. It accepts bounded form bytes,
 * never logs requests, serves no external assets, and delays shutdown just
 * long enough for the final success response to reach the browser. */
export function createBunLocalFundingLoopbackPort(): LocalFundingLoopbackPort {
  return Object.freeze({ async listen(input) {
    let server: ReturnType<typeof Bun.serve>;
    server = Bun.serve({ hostname: input.host, port: 0, development: false, async fetch(request) {
      const url = new URL(request.url);
      const headers = { "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
      if (url.pathname !== "/napplet-cvm/funding-setup") return new Response("Not found", { status: 404, headers });
      if (Date.now() >= input.expiresAtMs) return new Response("Setup session expired.", { status: 410, headers });
      if (request.method === "GET") {
        if (url.searchParams.get("state") !== input.state) return new Response("Invalid setup session.", { status: 403, headers });
        return new Response(page(input.state, input.csrf), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
      }
      if (request.method !== "POST" || Number(request.headers.get("content-length") ?? "0") > 70_000) return new Response("Rejected.", { status: 400, headers });
      try {
        const form = await request.formData();
        const materialValue = form.get("material");
        if (typeof materialValue !== "string") throw new Error("LOCAL_FUNDING_MATERIAL_REJECTED");
        const material = new TextEncoder().encode(materialValue);
        try { await input.submit({ state: form.get("state"), csrf: form.get("csrf"), rail: form.get("rail"), material }); }
        finally { material.fill(0); }
        return new Response(page(input.state, input.csrf, "Stored securely. Submit the other rail if it is still missing."), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
      } catch { return new Response("The value was rejected. Reload the original setup page and try again.", { status: 400, headers }); }
    } });
    const url = `http://127.0.0.1:${server.port}/napplet-cvm/funding-setup?state=${input.state}`;
    return Object.freeze({ url, async close() { setTimeout(() => server.stop(true), 100); } });
  } });
}

export function createFileOperatorFundingReadinessStore(path: string): OperatorFundingReadinessStore {
  return Object.freeze({ async write(value) {
    const parsed = await validateOperatorFundingReadiness(value);
    const directory = dirname(path); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalJson(parsed)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path); await chmod(path, 0o600);
  } });
}
