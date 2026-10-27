import { z } from "zod";
import { GoogleAuth } from "google-auth-library";

const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const TokenSchema = z.string().regex(/^[A-Za-z0-9._~-]{20,8192}$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());

/** gcloud ADC normally yields this broad platform scope; IAM roles, fixed
 * origins, and receipt-bound identity narrow authority. It is not presented as
 * a caller-selected or narrower OAuth grant. */
export const GOOGLE_CONTROL_PLANE_SCOPES = Object.freeze(["https://www.googleapis.com/auth/cloud-platform"] as const);

export type GoogleAccessToken = Readonly<{
  token: string;
  projectId: string;
  quotaProjectId: string;
  /** Receipt-bound service-account or operator principal, never a token. */
  principal: string;
  scopes: readonly string[];
  accountScopeSha256: string;
  expiresAtMs: number;
}>;
export type GoogleTokenSource = Readonly<{ getAccessToken(): Promise<GoogleAccessToken> }>;
export type GoogleAuthFetch = (url: string, init: RequestInit) => Promise<Response>;
export type GoogleAdcCommand = (argv: readonly string[]) => Promise<Readonly<{ exitCode: number; stdout: string }>>;
export type GoogleAdcIdentity = () => Promise<Readonly<{ projectId: string; principal: string }>>;

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A token is bound to its project, quota project, principal and permitted scope;
 * the digest can be compared to the controller receipt without ever recording
 * bearer material. */
export async function googleAccountScopeSha256(input: Readonly<{ projectId: string; quotaProjectId: string; principal: string; scopes?: readonly string[] }>): Promise<string> {
  const projectId = ProjectIdSchema.parse(input.projectId);
  const quotaProjectId = ProjectIdSchema.parse(input.quotaProjectId);
  const principal = z.string().regex(/^[A-Za-z0-9@._:/-]{3,255}$/u).parse(input.principal);
  const scopes = [...(input.scopes ?? GOOGLE_CONTROL_PLANE_SCOPES)].sort();
  if (scopes.length === 0 || scopes.some((scope) => scope !== "https://www.googleapis.com/auth/cloud-platform")) {
    throw new Error("GOOGLE_ADC_SCOPE_INVALID");
  }
  return sha256(JSON.stringify({ projectId, quotaProjectId, principal, scopes }));
}

async function runGcloud(argv: readonly string[]): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  try {
    const process = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    return Object.freeze({ exitCode: await process.exited, stdout: await new Response(process.stdout).text() });
  } catch {
    return Object.freeze({ exitCode: 127, stdout: "" });
  }
}

/**
 * Bounded ADC broker for the deployment control plane. It intentionally keeps
 * the token in request memory: no logger, digest, return value outside this
 * module, or error message contains bearer material. Local operators use the
 * documented `gcloud auth application-default` credential cache; Cloud Run
 * uses its attached-service-account metadata endpoint when gcloud is absent.
 */
export function createGoogleAdcTokenSource(input: Readonly<{
  projectId: string;
  quotaProjectId: string;
  principal: string;
  accountScopeSha256?: string;
  fetch?: GoogleAuthFetch;
  command?: GoogleAdcCommand;
  /** Local ADC must prove its selected identity through an operator-owned port;
   * Cloud Run derives it directly from protected metadata instead. */
  identity?: GoogleAdcIdentity;
  now?: () => number;
  expiryMarginMs?: number;
}>): GoogleTokenSource {
  const projectId = ProjectIdSchema.parse(input.projectId);
  const quotaProjectId = ProjectIdSchema.parse(input.quotaProjectId);
  const principal = z.string().regex(/^[A-Za-z0-9@._:/-]{3,255}$/u).parse(input.principal);
  const now = input.now ?? Date.now;
  const margin = input.expiryMarginMs ?? 60_000;
  if (!Number.isSafeInteger(margin) || margin < 10_000 || margin > 10 * 60_000) throw new Error("GOOGLE_ADC_EXPIRY_MARGIN_INVALID");
  const fetcher = input.fetch ?? fetch;
  const command = input.command ?? runGcloud;
  const libraryAuth = !input.fetch && !input.command && !input.identity
    ? new GoogleAuth({ projectId, scopes: GOOGLE_CONTROL_PLANE_SCOPES, clientOptions: { quotaProjectId } })
    : undefined;
  let cached: GoogleAccessToken | undefined;

  return Object.freeze({
    async getAccessToken(): Promise<GoogleAccessToken> {
      const expectedScope = await googleAccountScopeSha256({ projectId, quotaProjectId, principal });
      const configuredScope = input.accountScopeSha256 === undefined ? expectedScope : DigestSchema.parse(input.accountScopeSha256);
      if (configuredScope !== expectedScope) throw new Error("GOOGLE_ADC_ACCOUNT_SCOPE_INVALID");
      if (cached && cached.expiresAtMs - margin > now()) return cached;

      let token = ""; let expiresAtMs = 0;
      if (libraryAuth) {
        try {
          const [resolvedProject, credentials, client] = await Promise.all([libraryAuth.getProjectId(), libraryAuth.getCredentials(), libraryAuth.getClient()]);
          const credential = credentials as Readonly<{ client_email?: unknown; quota_project_id?: unknown }>;
          if (resolvedProject !== projectId || credential.client_email !== principal || (credential.quota_project_id !== undefined && credential.quota_project_id !== quotaProjectId)) throw new Error("GOOGLE_ADC_IDENTITY_INVALID");
          const access = await client.getAccessToken();
          const expiry = client.credentials.expiry_date;
          if (typeof access.token === "string" && TokenSchema.safeParse(access.token).success && Number.isSafeInteger(expiry) && expiry > now() + margin) { token = access.token; expiresAtMs = expiry; }
        } catch (error) { if (error instanceof Error && error.message === "GOOGLE_ADC_IDENTITY_INVALID") throw error; }
      }
      /* Metadata is accepted only after the attached Cloud Run project and
       * service-account email exactly match the receipt-bound identity. */
      if (!token) try {
        const headers = { "Metadata-Flavor": "Google" };
        const [metadataProject, metadataPrincipal] = await Promise.all([
          fetcher("http://metadata.google.internal/computeMetadata/v1/project/project-id", { method: "GET", headers, redirect: "error" }),
          fetcher("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", { method: "GET", headers, redirect: "error" }),
        ]);
        if (metadataProject.ok && metadataPrincipal.ok && (await metadataProject.text()).trim() === projectId && (await metadataPrincipal.text()).trim() === principal) {
          const response = await fetcher("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { method: "GET", headers, redirect: "error" });
          const value = response.ok ? z.object({ access_token: z.string(), expires_in: z.number().int().positive().max(3600) }).strict().safeParse(await response.json()) : undefined;
          if (value?.success && TokenSchema.safeParse(value.data.access_token).success) { token = value.data.access_token; expiresAtMs = now() + value.data.expires_in * 1000; }
        }
      } catch { /* metadata is optional; fail closed unless local proof succeeds */ }
      if (!token) {
        const identity = input.identity ? await input.identity() : undefined;
        if (!identity || ProjectIdSchema.safeParse(identity.projectId).data !== projectId || identity.principal !== principal) throw new Error("GOOGLE_ADC_IDENTITY_INVALID");
        const local = await command(["gcloud", "auth", "application-default", "print-access-token"]);
        if (local.exitCode === 0 && TokenSchema.safeParse(local.stdout.trim()).success) {
          token = local.stdout.trim();
          // gcloud does not expose expiry; read every time rather than guess.
          expiresAtMs = now() + margin + 1;
        }
      }
      if (!TokenSchema.safeParse(token).success || expiresAtMs - margin <= now()) throw new Error("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
      cached = Object.freeze({ token, projectId, quotaProjectId, principal, scopes: GOOGLE_CONTROL_PLANE_SCOPES, accountScopeSha256: expectedScope, expiresAtMs });
      return cached;
    },
  });
}
