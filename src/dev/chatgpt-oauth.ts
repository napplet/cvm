import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export type ChatGptFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
const issuer = "https://auth.openai.com";
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const secret = z.string().min(1).max(32_000);
const Tokens = z.object({ access: secret, refresh: secret, id: secret, expiresAt: z.number().finite(), scopes: z.array(z.string()), earliestRefreshAt: z.number().finite().optional() }).strict();
const Account = z.object({ id: z.string(), clientId: z.string(), subject: z.string(), label: z.string().max(256), tokens: Tokens.optional(), welcomed: z.boolean().default(false) }).strict();
const Settings = z.object({ mode: z.enum(["default", "chatgpt"]), accountId: z.string().optional(), model: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/u).optional() }).strict();
const State = z.object({ version: z.literal(1), hostId: z.string().uuid(), accounts: z.array(Account).max(16), settings: Settings }).strict();
type AccountRecord = z.infer<typeof Account>;
type TokenSet = z.infer<typeof Tokens>;
export type ChatGptSettings = z.infer<typeof Settings>;
export type ChatGptModel = Readonly<{ slug: string; displayName: string }>;
type Attempt = { state: string; nonce: string; verifier: string; cookie: string; redirectUri: string; expiresAt: number; accountId?: string; clientId?: string };
const random = () => randomBytes(32).toString("base64url");
export function chatGptError(code: string): Error { return new Error(`CHATGPT_${code}`); }
export function safeChatGptError(error: unknown): string { return error instanceof Error && /^CHATGPT_[A-Z0-9_]{1,100}$/u.test(error.message) ? error.message : "CHATGPT_REQUEST_FAILED"; }

/** Bounded network JSON. Never include remote text, credentials, or URLs in errors. */
export async function boundedJson(response: Response, limit = 256_000): Promise<any> {
  const reader = response.body?.getReader(); if (!reader) throw chatGptError("EMPTY_RESPONSE");
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > limit) throw chatGptError("RESPONSE_TOO_LARGE"); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Local app-owned credentials; never reads Codex/ChatGPT's own credential cache. */
export class ChatGptOAuth {
  #state!: z.infer<typeof State>;
  #attempt?: Attempt;
  #tail: Promise<unknown> = Promise.resolve();
  #models = new Map<string, readonly ChatGptModel[]>();
  #notice?: string;
  #closed = false;
  readonly #fetch: ChatGptFetch;
  readonly #now: () => number;
  readonly #path: string;
  readonly #lock: string;
  private constructor(readonly directory: string, options: { fetch?: ChatGptFetch; now?: () => number }) {
    this.#fetch = options.fetch ?? fetch; this.#now = options.now ?? Date.now;
    this.#path = resolve(directory, "accounts.json"); this.#lock = resolve(directory, "owner.lock");
  }
  static async open(directory: string, options: { fetch?: ChatGptFetch; now?: () => number } = {}): Promise<ChatGptOAuth> {
    const client = new ChatGptOAuth(resolve(directory), options);
    await mkdir(client.directory, { recursive: true, mode: 0o700 }); await chmod(client.directory, 0o700);
    // One process owns token rotation for this instance. Reclaim only a dead PID.
    try {
      const lock = await open(client.#lock, "wx", 0o600); await lock.writeFile(String(process.pid)); await lock.close();
    } catch (error) {
      if ((error as any).code !== "EEXIST") throw error;
      const pid = Number(await readFile(client.#lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw chatGptError("AUTH_BUSY");
      try { process.kill(pid, 0); throw chatGptError("AUTH_BUSY"); }
      catch (check) { if ((check as any).code !== "ESRCH") throw check; }
      await rm(client.#lock);
      const lock = await open(client.#lock, "wx", 0o600); await lock.writeFile(String(process.pid)); await lock.close();
    }
    try {
      try {
        const info = await lstat(client.#path); if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1_000_000) throw chatGptError("PRIVATE_STORAGE_INVALID");
        client.#state = State.parse(JSON.parse(await readFile(client.#path, "utf8")));
      } catch (error) {
        if ((error as any).code !== "ENOENT") throw chatGptError("PRIVATE_STORAGE_INVALID");
        client.#state = { version: 1, hostId: crypto.randomUUID(), accounts: [], settings: { mode: "default" } }; await client.#save();
      }
      return client;
    } catch (error) { await rm(client.#lock, { force: true }); throw error; }
  }
  async close(): Promise<void> { if (this.#closed) return; this.#closed = true; this.#attempt = undefined; await this.#tail.catch(() => undefined); await rm(this.#lock, { force: true }); }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(chatGptError("CLOSED"));
    const run = this.#tail.then(fn); this.#tail = run.catch(() => undefined); return run;
  }
  async #save(): Promise<void> {
    const temporary = `${this.#path}.${random()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(State.parse(this.#state))); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, this.#path); } finally { await rm(temporary, { force: true }); }
  }
  settings(): ChatGptSettings { return structuredClone(this.#state.settings); }
  status() {
    return { settings: this.settings(), accounts: this.#state.accounts.map((account) => ({ id: account.id, label: account.label, signedIn: !!account.tokens, planEnabled: !!account.tokens?.scopes.includes("chatgpt.tokens.use.direct"), welcomed: account.welcomed })), ...(this.#notice ? { notice: this.#notice } : {}) };
  }
  async select(settings: ChatGptSettings): Promise<void> {
    return this.#serial(async () => {
      const parsed = Settings.parse(settings);
      if (parsed.mode === "chatgpt") {
        const account = this.#account(parsed.accountId);
        if (!account.tokens?.scopes.includes("chatgpt.tokens.use.direct") || !this.#models.get(account.id)?.some((model) => model.slug === parsed.model)) throw chatGptError("SELECT_AVAILABLE_MODEL");
      }
      this.#state.settings = parsed; await this.#save();
    });
  }
  async welcome(accountId: string): Promise<void> { return this.#serial(async () => { this.#account(accountId).welcomed = true; await this.#save(); }); }
  #account(id?: string): AccountRecord { const account = this.#state.accounts.find((item) => item.id === id); if (!account) throw chatGptError("SIGN_IN_REQUIRED"); return account; }
  async begin(origin: string, accountId?: string): Promise<{ url: string; cookie: string }> {
    return this.#serial(async () => {
      const callback = new URL("/auth/openai/callback", origin);
      if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.username || callback.password) throw chatGptError("LOOPBACK_REQUIRED");
      const account = accountId ? this.#account(accountId) : undefined;
      const attempt: Attempt = { state: random(), nonce: random(), verifier: random(), cookie: random(), redirectUri: callback.href, expiresAt: this.#now() + 600_000, ...(account ? { accountId: account.id, clientId: account.clientId } : {}) };
      this.#attempt = attempt;
      const url = new URL(`${issuer}/api/accounts/authorize`);
      const params = { client_id: account?.clientId ?? "dynamic_agent_client", ext_agent_host_id: `urn:uuid:${this.#state.hostId}`, response_type: "code", redirect_uri: attempt.redirectUri, scope, resource: CHATGPT_RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"), ...(account ? { ...(account.label.includes("@") ? { login_hint: account.label } : {}), ...(!account.tokens?.scopes.includes("chatgpt.tokens.use.direct") ? { prompt: "consent" } : {}) } : { agent_name_hint: "napplet-cvm development" }) };
      url.search = new URLSearchParams(params).toString();
      // No id_token_hint: the browser may see this URL; account selection is cheap.
      return { url: url.href, cookie: attempt.cookie };
    });
  }
  async callback(url: URL, cookie: string | undefined): Promise<string> {
    return this.#serial(async () => {
      const attempt = this.#attempt;
      if (!attempt || attempt.expiresAt < this.#now() || cookie !== attempt.cookie || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== attempt.state || `${url.origin}${url.pathname}` !== attempt.redirectUri) throw chatGptError("SIGN_IN_STATE_INVALID");
      this.#attempt = undefined; // Consume before any token exchange, including errors.
      if (url.searchParams.has("error")) throw chatGptError("SIGN_IN_DECLINED");
      const code = url.searchParams.get("code"); const suppliedClient = url.searchParams.get("client_id");
      const clientId = attempt.clientId ?? suppliedClient;
      if (!code || code.length > 16_000 || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("client_id").length > 1 || !clientId || !/^oaiapp_[A-Za-z0-9_-]{1,240}$/u.test(clientId) || (attempt.clientId && suppliedClient && suppliedClient !== attempt.clientId)) throw chatGptError("SIGN_IN_CALLBACK_INVALID");
      const payload = await this.#token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: CHATGPT_RESOURCE });
      const identity = await this.#verifyId(payload.id_token, clientId, attempt.nonce);
      const previous = attempt.accountId ? this.#account(attempt.accountId) : undefined;
      if (previous && previous.subject !== identity.sub) throw chatGptError("ACCOUNT_MISMATCH");
      const tokens = this.#tokens(payload);
      const id = createHash("sha256").update(`${clientId}:${identity.sub}`).digest("hex").slice(0, 24);
      const existing = this.#state.accounts.find((account) => account.id === id);
      if (!existing && this.#state.accounts.length >= 16) throw chatGptError("ACCOUNT_LIMIT");
      const account = { id, clientId, subject: identity.sub, label: typeof identity.email === "string" ? identity.email.slice(0, 220) : `ChatGPT ${id.slice(0, 8)}`, tokens, welcomed: existing?.welcomed ?? false };
      this.#state.accounts = [...this.#state.accounts.filter((item) => item.id !== id), account];
      this.#notice = tokens.scopes.includes("chatgpt.tokens.use.direct") ? undefined : "CHATGPT_PLAN_PERMISSION_REQUIRED";
      await this.#save(); return id;
    });
  }
  async #verifyId(token: unknown, clientId: string, nonce?: string): Promise<{ sub: string; email?: string }> {
    if (typeof token !== "string" || token.length > 32_000) throw chatGptError("ID_TOKEN_INVALID");
    const parts = token.split("."); if (parts.length !== 3) throw chatGptError("ID_TOKEN_INVALID");
    let header: any; let claims: any;
    try { header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()); claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()); } catch { throw chatGptError("ID_TOKEN_INVALID"); }
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) throw chatGptError("ID_TOKEN_INVALID");
    const response = await this.#fetch(`${issuer}/.well-known/jwks.json`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw chatGptError("IDENTITY_KEYS_UNAVAILABLE");
    const jwks = await boundedJson(response);
    const keys = Array.isArray(jwks.keys) ? jwks.keys.filter((key: any) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig")) : [];
    if (keys.length !== 1 || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: keys[0], format: "jwk" }), Buffer.from(parts[2]!, "base64url"))) throw chatGptError("ID_TOKEN_INVALID");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]; const now = this.#now() / 1000;
    if (claims.iss !== issuer || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId) || typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 60 || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 60)) || (nonce !== undefined && claims.nonce !== nonce) || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256) throw chatGptError("ID_TOKEN_INVALID");
    return { sub: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
  }
  async #token(params: Record<string, string>): Promise<any> {
    const response = await this.#fetch(tokenEndpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    const result = await boundedJson(response);
    if (!response.ok) {
      const code = typeof result.error === "string" ? result.error : result.error?.code;
      if (["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(code)) throw chatGptError("REAUTHORIZE_REQUIRED");
      throw chatGptError(response.status === 429 ? "RATE_LIMIT" : "TOKEN_EXCHANGE_UNAVAILABLE");
    }
    return result;
  }
  #tokens(payload: any, previous?: TokenSet): TokenSet {
    if (String(payload.token_type).toLowerCase() !== "bearer" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || payload.expires_in > 86_400) throw chatGptError("TOKEN_RESPONSE_INVALID");
    return Tokens.parse({ access: payload.access_token, refresh: payload.refresh_token, id: payload.id_token ?? previous?.id, expiresAt: this.#now() + payload.expires_in * 1000, scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/u) : previous?.scopes ?? [], ...(typeof payload.earliest_refresh_at === "number" ? { earliestRefreshAt: payload.earliest_refresh_at * 1000 } : {}) });
  }
  async accessToken(accountId: string): Promise<string> {
    return this.#serial(async () => {
      const account = this.#account(accountId); let tokens = account.tokens;
      if (!tokens) throw chatGptError("SIGN_IN_REQUIRED");
      if (tokens.expiresAt <= this.#now() + 60_000 && (!tokens.earliestRefreshAt || tokens.earliestRefreshAt <= this.#now())) {
        try {
          const payload = await this.#token({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: tokens.refresh, resource: CHATGPT_RESOURCE });
          if (payload.id_token && (await this.#verifyId(payload.id_token, account.clientId)).sub !== account.subject) throw chatGptError("ACCOUNT_MISMATCH");
          tokens = this.#tokens(payload, tokens); account.tokens = tokens; await this.#save();
        } catch (error) {
          if (safeChatGptError(error) === "CHATGPT_REAUTHORIZE_REQUIRED") { delete account.tokens; this.#models.delete(accountId); this.#notice = "CHATGPT_REAUTHORIZE_REQUIRED"; await this.#save(); }
          throw error;
        }
      }
      if (!tokens.scopes.includes("chatgpt.tokens.use.direct") || !tokens.scopes.includes("resource.invoke")) throw chatGptError("PLAN_PERMISSION_REQUIRED");
      if (tokens.expiresAt <= this.#now()) throw chatGptError("REAUTHORIZE_REQUIRED");
      return tokens.access;
    });
  }
  async models(accountId: string): Promise<readonly ChatGptModel[]> {
    const token = await this.accessToken(accountId);
    const response = await this.#fetch(`${CHATGPT_RESOURCE}/models`, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw chatGptError(response.status === 401 ? "REAUTHORIZE_REQUIRED" : "MODELS_UNAVAILABLE");
    const result = await boundedJson(response);
    const catalog = z.object({ models: z.array(z.object({ slug: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/u), display_name: z.string().min(1).max(128), visibility: z.string() }).passthrough()).max(512) }).passthrough().parse(result);
    const models = catalog.models.filter((model) => model.visibility === "list").map((model) => ({ slug: model.slug, displayName: model.display_name }));
    this.#models.set(accountId, models); return models;
  }
  async logout(accountId: string): Promise<{ revoked: boolean }> {
    return this.#serial(async () => {
      const account = this.#account(accountId); let revoked = !account.tokens;
      if (account.tokens) {
        try {
          const discovery = await this.#fetch(`${issuer}/.well-known/openid-configuration`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
          const metadata = await boundedJson(discovery);
          const endpoint = new URL(metadata.revocation_endpoint);
          if (!discovery.ok || metadata.issuer !== issuer || endpoint.origin !== issuer || endpoint.username || endpoint.password) throw chatGptError("REVOCATION_UNAVAILABLE");
          const response = await this.#fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: account.tokens.refresh, token_type_hint: "refresh_token", client_id: account.clientId }) });
          revoked = response.status === 200; await response.body?.cancel();
        } catch { /* Clear locally even if revocation cannot be confirmed. */ }
      }
      delete account.tokens; this.#models.delete(accountId); this.#attempt = undefined;
      this.#notice = revoked ? undefined : "CHATGPT_REMOTE_REVOCATION_UNCONFIRMED";
      await this.#save(); return { revoked };
    });
  }
}
