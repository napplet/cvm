import { randomBytes } from "node:crypto";
import { boundedJson, safeChatGptError, type ChatGptOAuth, type ChatGptSettings } from "../dev/chatgpt-oauth";

/** Local operator controls only. Generation/account/payment commands stay on ContextVM. */
export class DevelopmentChatGptRoutes {
  readonly controlToken = randomBytes(32).toString("hex");
  readonly #cookieName = `napplet_chatgpt_${randomBytes(8).toString("hex")}`;
  constructor(private readonly options: { auth: ChatGptOAuth; select: (settings: ChatGptSettings) => Promise<void>; busy: () => boolean; diagnostic: () => string | undefined }) {}
  async handle(request: Request, origin: string): Promise<Response | undefined> {
    const url = new URL(request.url);
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
    if (url.pathname === "/auth/openai/callback") {
      if (request.method !== "GET" || url.origin !== origin || url.search.length > 24_000) return new Response("Invalid callback", { status: 400, headers });
      let location = "/?chatgpt=connected";
      try {
        if (this.options.busy()) throw new Error("CHATGPT_GENERATION_BUSY");
        const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${this.#cookieName}=`))?.slice(this.#cookieName.length + 1);
        const account = await this.options.auth.callback(url, cookie); location += `&chatgpt_account=${encodeURIComponent(account)}`;
      } catch (error) { location = `/?chatgpt_error=${safeChatGptError(error)}`; }
      return new Response(null, { status: 303, headers: { ...headers, location, "set-cookie": `${this.#cookieName}=; HttpOnly; SameSite=Lax; Path=/auth/openai/callback; Max-Age=0` } });
    }
    if (!url.pathname.startsWith("/dev/chatgpt/")) return undefined;
    if (url.origin !== origin || request.headers.get("x-dev-model-token") !== this.controlToken || (request.headers.get("origin") && request.headers.get("origin") !== origin) || request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ code: "CHATGPT_LOCAL_CONTROL_REQUIRED" }, { status: 403, headers });
    try {
      if (url.pathname === "/dev/chatgpt/status" && request.method === "GET") return Response.json({ ...this.options.auth.status(), diagnostic: this.options.diagnostic() }, { headers });
      if (request.method !== "POST" || request.headers.get("content-type") !== "application/json" || request.headers.get("origin") !== origin) return Response.json({ code: "CHATGPT_INVALID_CONTROL_REQUEST" }, { status: 405, headers });
      if (this.options.busy()) return Response.json({ code: "CHATGPT_GENERATION_BUSY" }, { status: 409, headers });
      const body = await boundedJson(new Response(request.body), 4096);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("CHATGPT_INVALID_CONTROL_REQUEST");
      if (url.pathname === "/dev/chatgpt/sign-in") {
        const flow = await this.options.auth.begin(origin, typeof body.accountId === "string" ? body.accountId : undefined);
        return Response.json({ url: flow.url }, { headers: { ...headers, "set-cookie": `${this.#cookieName}=${flow.cookie}; HttpOnly; SameSite=Lax; Path=/auth/openai/callback; Max-Age=600` } });
      }
      if (url.pathname === "/dev/chatgpt/models" && typeof body.accountId === "string") return Response.json({ models: await this.options.auth.models(body.accountId) }, { headers });
      if (url.pathname === "/dev/chatgpt/select") { await this.options.select(body); return Response.json({ selected: true }, { headers }); }
      if (url.pathname === "/dev/chatgpt/welcome" && typeof body.accountId === "string") { await this.options.auth.welcome(body.accountId); return Response.json({ saved: true }, { headers }); }
      if (url.pathname === "/dev/chatgpt/logout" && typeof body.accountId === "string") return Response.json(await this.options.auth.logout(body.accountId), { headers });
      return Response.json({ code: "CHATGPT_CONTROL_NOT_FOUND" }, { status: 404, headers });
    } catch (error) { return Response.json({ code: safeChatGptError(error) }, { status: 400, headers }); }
  }
}
