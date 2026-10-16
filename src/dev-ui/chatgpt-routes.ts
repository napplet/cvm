import { randomBytes } from "node:crypto";
import { z } from "zod";
import { safeChatGptError, type ChatGptOAuth, type ChatGptSettings } from "../dev/chatgpt-oauth";

/** Operator commands arrive over encrypted ContextVM. HTTP is used only for
 * the provider's browser redirect/callback, protected by a one-use ticket,
 * HttpOnly browser binding, OAuth state, nonce and PKCE. */
export class DevelopmentChatGptRoutes {
  readonly #cookieName = `napplet_chatgpt_${randomBytes(8).toString("hex")}`;
  #tickets = new Map<string, { url: string; cookie: string; expires: number }>();
  constructor(private readonly options: { auth: ChatGptOAuth; select: (settings: ChatGptSettings) => Promise<void>; busy: () => boolean; diagnostic: () => string | undefined }) {}
  async command(operation: string, input: unknown, origin: string): Promise<unknown> {
    const body = z.object({ accountId: z.string().min(1).max(240).optional(), mode: z.enum(["default", "chatgpt"]).optional(), model: z.string().max(128).optional() }).strict().parse(input);
    if (operation === "status") return { ...this.options.auth.status(), diagnostic: this.options.diagnostic() };
    if (operation === "sign-in") {
      const flow = await this.options.auth.begin(origin, body.accountId);
      this.#tickets.clear();
      const ticket = randomBytes(32).toString("hex"); this.#tickets.set(ticket, { ...flow, expires: Date.now() + 600000 });
      return { url: `${origin}/admin/oauth/start?ticket=${ticket}` };
    }
    if (operation === "models" && body.accountId) return { models: await this.options.auth.models(body.accountId) };
    if (operation === "welcome" && body.accountId) { await this.options.auth.welcome(body.accountId); return { saved: true }; }
    if (this.options.busy()) throw new Error("CHATGPT_GENERATION_BUSY");
    if (operation === "select") { await this.options.select(body as ChatGptSettings); return { selected: true }; }
    if (operation === "logout" && body.accountId) return this.options.auth.logout(body.accountId);
    throw new Error("CHATGPT_INVALID_CONTROL_REQUEST");
  }
  async handle(request: Request, origin: string): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!["/admin/oauth/start", "/auth/openai/callback"].includes(url.pathname)) return undefined;
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };
    if (request.method !== "GET" || url.origin !== origin || url.search.length > 24000) return new Response("Invalid callback", { status: 400, headers });
    if (url.pathname === "/admin/oauth/start") {
      const ticket = url.searchParams.get("ticket") ?? ""; const flow = this.#tickets.get(ticket); this.#tickets.delete(ticket);
      if (!flow || flow.expires < Date.now()) return new Response("Operator sign-in expired. Start again in CVM admin.", { status: 403, headers });
      return new Response(null, { status: 303, headers: { ...headers, location: flow.url, "set-cookie": `${this.#cookieName}=${flow.cookie}; HttpOnly; SameSite=Lax; Path=/auth/openai/callback; Max-Age=600` } });
    }
    let location = "/admin?chatgpt=connected";
    try {
      const cookie = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${this.#cookieName}=`))?.slice(this.#cookieName.length + 1);
      const account = await this.options.auth.callback(url, cookie);
      const models = await this.options.auth.models(account);
      const saved = this.options.auth.settings().model;
      const model = models.find(item => item.slug === saved)?.slug ?? models[0]?.slug;
      if (!model) throw new Error("CHATGPT_SELECT_AVAILABLE_MODEL");
      if (!this.options.busy()) await this.options.select({ mode: "chatgpt", accountId: account, model });
    } catch (error) { location = `/admin?chatgpt_error=${safeChatGptError(error)}`; }
    return new Response(null, { status: 303, headers: { ...headers, location, "set-cookie": `${this.#cookieName}=; HttpOnly; SameSite=Lax; Path=/auth/openai/callback; Max-Age=0` } });
  }
}
