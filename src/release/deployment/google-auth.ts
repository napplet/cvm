import { z } from "zod";
import { GoogleAuth } from "google-auth-library";

const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const TokenSchema = z.string().regex(/^[A-Za-z0-9._~-]{20,8192}$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());

/** gcloud ADC normally yields this broad platform scope; IAM roles, fixed
 * origins, and receipt-bound identity narrow authority. It is not presented as
 * a caller-selected or narrower OAuth grant. */
export const GOOGLE_CONTROL_PLANE_SCOPES = Object.freeze(["https://www.googleapis.com/auth/cloud-platform"] as const);
const GOOGLE_ADC_AUXILIARY_SCOPES = new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]);

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
type GoogleAuthPort = Readonly<{ getProjectId(): Promise<string>; getCredentials(): Promise<unknown>; getClient(): Promise<Readonly<{ credentials: Readonly<{ expiry_date?: number }>; getAccessToken(): Promise<Readonly<{ token?: string }>>; getTokenInfo?(token: string): Promise<Readonly<{ scopes: readonly string[]; expiry_date: number; email?: string }>> }>> }>;

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
  const scopes = [...new Set(input.scopes ?? GOOGLE_CONTROL_PLANE_SCOPES)].sort();
  if (!scopes.includes(GOOGLE_CONTROL_PLANE_SCOPES[0]) || scopes.some((scope) => scope !== GOOGLE_CONTROL_PLANE_SCOPES[0] && !GOOGLE_ADC_AUXILIARY_SCOPES.has(scope))) {
    throw new Error("GOOGLE_ADC_SCOPE_INVALID");
  }
  return sha256(JSON.stringify({ projectId, quotaProjectId, principal, scopes }));
}

async function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("GOOGLE_ADC_TIMEOUT")), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function limitedText(response: Response, limit = 16_384, timeoutMs = 5_000): Promise<string> {
  if (!response.body) throw new Error("GOOGLE_ADC_RESPONSE_INVALID");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; const deadline = Date.now() + timeoutMs;
  let complete = false;
  try { for (;;) { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("GOOGLE_ADC_TIMEOUT"); const part = await within(reader.read(), remaining); if (part.done) { complete = true; break; } total += part.value.byteLength; if (total > limit) throw new Error("GOOGLE_ADC_RESPONSE_INVALID"); chunks.push(part.value); } }
  finally { if (!complete) void reader.cancel(); reader.releaseLock(); }
  const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return new TextDecoder().decode(result);
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
  /** Test seam for documented ADC behavior; production uses GoogleAuth. */
  auth?: GoogleAuthPort;
  now?: () => number;
  expiryMarginMs?: number;
  timeoutMs?: number;
}>): GoogleTokenSource {
  const projectId = ProjectIdSchema.parse(input.projectId);
  const quotaProjectId = ProjectIdSchema.parse(input.quotaProjectId);
  const principal = z.string().regex(/^[A-Za-z0-9@._:/-]{3,255}$/u).parse(input.principal);
  const now = input.now ?? Date.now;
  const margin = input.expiryMarginMs ?? 60_000;
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(margin) || margin < 10_000 || margin > 10 * 60_000) throw new Error("GOOGLE_ADC_EXPIRY_MARGIN_INVALID");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("GOOGLE_ADC_TIMEOUT_INVALID");
  const fetcher = input.fetch ?? fetch;
  const libraryAuth: GoogleAuthPort | undefined = input.auth ?? (!input.fetch ? new GoogleAuth({ projectId, scopes: GOOGLE_CONTROL_PLANE_SCOPES, clientOptions: { quotaProjectId } }) : undefined);
  let cached: GoogleAccessToken | undefined;

  return Object.freeze({
    async getAccessToken(): Promise<GoogleAccessToken> {
      if (cached && cached.expiresAtMs - margin > now()) return cached;

      let token = ""; let expiresAtMs = 0; let actualScopes: readonly string[] = [];
      if (libraryAuth) {
        try {
          const [resolvedProject, credentials, client] = await within(Promise.all([libraryAuth.getProjectId(), libraryAuth.getCredentials(), libraryAuth.getClient()]), timeoutMs);
          const credential = credentials as Readonly<{ client_email?: unknown; quota_project_id?: unknown }>;
          if (resolvedProject !== projectId || (credential.quota_project_id !== undefined && credential.quota_project_id !== quotaProjectId)) throw new Error("GOOGLE_ADC_IDENTITY_INVALID");
          const access = await within(client.getAccessToken(), timeoutMs);
          const expiry = client.credentials.expiry_date;
          const tokenInfo = typeof access.token === "string" && typeof client.getTokenInfo === "function" ? await within(client.getTokenInfo(access.token), timeoutMs) : undefined;
          const discoveredPrincipal = credential.client_email ?? tokenInfo?.email;
          if (discoveredPrincipal !== principal) throw new Error("GOOGLE_ADC_IDENTITY_INVALID");
          const scopeMatches = tokenInfo !== undefined && await googleAccountScopeSha256({ projectId, quotaProjectId, principal, scopes: tokenInfo.scopes }).then(() => true).catch(() => false);
          const tokenExpiry = tokenInfo?.expiry_date;
          if (typeof access.token === "string" && TokenSchema.safeParse(access.token).success && scopeMatches && Number.isSafeInteger(expiry) && expiry > now() + margin && Number.isSafeInteger(tokenExpiry) && tokenExpiry > now() + margin) { token = access.token; expiresAtMs = Math.min(expiry, tokenExpiry); actualScopes = tokenInfo!.scopes; }
        } catch (error) { if (error instanceof Error && error.message === "GOOGLE_ADC_IDENTITY_INVALID") throw error; }
      }
      /* Metadata is accepted only after the attached Cloud Run project and
       * service-account email exactly match the receipt-bound identity. */
      if (!token) try {
        const headers = { "Metadata-Flavor": "Google" };
        const controller = new AbortController();
        try {
          const metadataGet = (path: string) => within(fetcher(`http://metadata.google.internal/computeMetadata/v1/${path}`, { method: "GET", headers, redirect: "error", signal: controller.signal }), timeoutMs).catch((error) => { controller.abort(); throw error; });
          const [metadataProject, metadataPrincipal, metadataScopes] = await Promise.all([
            metadataGet("project/project-id"), metadataGet("instance/service-accounts/default/email"), metadataGet("instance/service-accounts/default/scopes"),
          ]);
          const metadataScopeSet = metadataScopes.ok ? (await limitedText(metadataScopes, 16_384, timeoutMs)).split(/\s+/u).filter(Boolean) : [];
          const scopeValid = await googleAccountScopeSha256({ projectId, quotaProjectId, principal, scopes: metadataScopeSet }).then(() => true).catch(() => false);
          if (metadataProject.ok && metadataPrincipal.ok && scopeValid && (await limitedText(metadataProject, 16_384, timeoutMs)).trim() === projectId && (await limitedText(metadataPrincipal, 16_384, timeoutMs)).trim() === principal) {
            const response = await metadataGet("instance/service-accounts/default/token");
            let decoded: unknown; try { decoded = JSON.parse(await limitedText(response, 16_384, timeoutMs)); } catch { decoded = undefined; }
            const value = response.ok ? z.object({ access_token: z.string(), expires_in: z.number().int().positive().max(3600), token_type: z.literal("Bearer") }).passthrough().safeParse(decoded) : undefined;
            if (value?.success && TokenSchema.safeParse(value.data.access_token).success) { token = value.data.access_token; expiresAtMs = now() + value.data.expires_in * 1000; actualScopes = metadataScopeSet; }
          }
        } finally { controller.abort(); }
      } catch { /* metadata is optional; fail closed unless local proof succeeds */ }
      if (!TokenSchema.safeParse(token).success || expiresAtMs - margin <= now()) throw new Error("ADC_APPLICATION_DEFAULT_LOGIN_REQUIRED");
      const accountScopeSha256 = await googleAccountScopeSha256({ projectId, quotaProjectId, principal, scopes: actualScopes });
      if (input.accountScopeSha256 !== undefined && DigestSchema.parse(input.accountScopeSha256) !== accountScopeSha256) throw new Error("GOOGLE_ADC_ACCOUNT_SCOPE_INVALID");
      cached = Object.freeze({ token, projectId, quotaProjectId, principal, scopes: actualScopes, accountScopeSha256, expiresAtMs });
      return cached;
    },
  });
}
