import { z } from "zod";
import {
  createOperatorFundingPrerequisiteController,
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
  }>): Promise<Readonly<{ close(): Promise<void> }>>;
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
  authorizationRequestSha256: string;
  rails: readonly OperatorFundingRail[];
}>;

export type LocalOperatorFundingSetupOptions = Readonly<{
  candidateSha256: string;
  authorizationRequestSha256: string;
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
  if (!RailSchema.safeParse(value.rail).success || !(value.material instanceof Uint8Array) || value.material.byteLength === 0 || value.material.byteLength > 65_536) {
    throw new Error("LOCAL_FUNDING_MATERIAL_REJECTED");
  }
  return Object.freeze({ state, csrf, rail: value.rail, material: new Uint8Array(value.material) });
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
  const request = DigestSchema.safeParse(options.authorizationRequestSha256);
  if (!candidate.success || !request.success || !options.loopback || !options.browser || !options.secrets || !options.readinessStore) throw new Error("LOCAL_FUNDING_SETUP_INVALID");
  const now = options.now ?? Date.now;
  const expiresInMs = options.expiresInMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 10 * 60 * 1000 || !validTime(now())) throw new Error("LOCAL_FUNDING_SETUP_INVALID");
  const prerequisites = createOperatorFundingPrerequisiteController({ now });
  let active: Readonly<{ state: string; csrf: string; expiresAtMs: number; close: () => Promise<void> }> | undefined;
  const descriptor = (): LocalFundingSetupDescriptor => Object.freeze({
    kind: "local_operator_funding_setup", status: "action_required", plan: "07-20",
    candidateSha256: candidate.data, authorizationRequestSha256: request.data,
    rails: Object.freeze(["nwc_lightning", "cashu"]),
  });
  const submit = async (input: unknown): Promise<void> => {
    if (!active) throw new Error("LOCAL_FUNDING_SESSION_REJECTED");
    const submission = parseSubmission(input, active.state, active.csrf, active.expiresAtMs, now);
    const stored = await options.secrets.store(Object.freeze({ rail: submission.rail, material: submission.material }));
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
      await options.browser.open(`http://127.0.0.1:0/napplet-cvm/funding-setup?state=${state}`);
    },
    async readiness(): Promise<OperatorFundingReadiness> { return prerequisites.readiness(); },
  });
}

/** Explicitly reject implicit cross-platform fallback. A real production port
 * is supplied only by the authorized Plan 07-20 macOS launcher. */
export function requireMacOsSecretStore(): void {
  if (process.platform !== "darwin") throw new Error("LOCAL_FUNDING_OS_SECRET_STORE_UNSUPPORTED");
}
