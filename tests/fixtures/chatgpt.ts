import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { ChatGptFetch } from "../../src/dev/chatgpt-oauth";

/** Deterministic OpenAI protocol fixture, never a live-provider certification. */
export function chatGptFixture(now: () => number = Date.now) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
  const authorization = new Map<string, URL>();
  const calls: { url: string; init?: RequestInit }[] = [];
  let refreshes = 0; let inferences = 0;
  let refreshError: string | undefined; let inferenceMode: "complete" | "cut" | "limit" | "bad-source" | "invalid-typescript" = "complete";
  let claimsOverride: Record<string, unknown> = {}; let grantedScope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const token = (claims: Record<string, unknown>) => {
    const content = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;
  };
  const files = (version: number) => [
    { path: "src/main.ts", content: `import './styles.css';\nimport { runtimeHasDomain } from './domain-availability.js';\nconst root = document.querySelector('#app')!; let count = 0; const heading = document.createElement('h1'); heading.textContent = 'OAuth fixture ${version}'; const value = document.createElement('output'); value.textContent = '0'; const button = document.createElement('button'); button.textContent = 'Add'; button.onclick = () => { count++; value.textContent = String(count); }; const availability = document.createElement('p'); availability.textContent = runtimeHasDomain('storage') ? 'Storage available' : 'Storage unavailable'; root.replaceChildren(heading, value, button, availability);` },
    { path: "src/styles.css", content: "html, body, #app { height: 100%; margin: 0; } body { font-family: system-ui; } button { padding: 1rem; }" },
  ];
  const fetch: ChatGptFetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", revocation_endpoint: "https://auth.openai.com/oauth/revoke" });
    if (url.endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
    if (url.endsWith("/api/accounts/oauth/token")) {
      const body = new URLSearchParams(init?.body as URLSearchParams);
      if (body.get("grant_type") === "refresh_token") {
        refreshes++;
        if (refreshError) return Response.json({ error: refreshError }, { status: 400 });
        return Response.json({ access_token: `fixture-access-${refreshes}`, refresh_token: `fixture-refresh-${refreshes}`, token_type: "Bearer", expires_in: 3600, scope: grantedScope });
      }
      const auth = authorization.get(body.get("code")!); if (!auth) throw new Error("FIXTURE_CODE_NOT_FOUND");
      if (body.get("redirect_uri") !== auth.searchParams.get("redirect_uri") || createHash("sha256").update(body.get("code_verifier")!).digest("base64url") !== auth.searchParams.get("code_challenge")) throw new Error("FIXTURE_PKCE_INVALID");
      return Response.json({ access_token: "fixture-access-initial", refresh_token: "fixture-refresh-initial", id_token: token({ iss: "https://auth.openai.com", sub: "fixture-subject", email: "developer@example.test", aud: body.get("client_id"), nonce: auth.searchParams.get("nonce"), iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 3600, ...claimsOverride }), token_type: "Bearer", expires_in: 3600, scope: grantedScope });
    }
    if (url.endsWith("/v1/models")) return Response.json({ models: [{ slug: "fixture-codex", display_name: "Fixture Codex", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hidden" }] });
    if (url.endsWith("/v1/responses")) {
      inferences++;
      const body = JSON.parse(String(init?.body));
      const event = inferenceMode === "limit" ? { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } } : { type: "response.completed", response: { id: `resp_fixture_${inferences}`, model: body.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: inferenceMode === "bad-source" ? "invalid" : JSON.stringify({ files: files(inferences).map((file) => inferenceMode === "invalid-typescript" && file.path === "src/main.ts" ? { ...file, content: file.content + '\nconst invalid: number = "deliberate type error";' } : file) }) }] }], usage: { input_tokens: 1200, output_tokens: 800 } } };
      const data = `: comment\r\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\r\n\r\n${inferenceMode === "cut" ? "" : `data: ${JSON.stringify(event)}\r\n\r\n`}`;
      const encoded = new TextEncoder().encode(data);
      return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < encoded.length; i += 17) controller.enqueue(encoded.slice(i, i + 17)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error("FIXTURE_UNEXPECTED_NETWORK");
  };
  return { fetch, calls, files, token, setClaims: (claims: Record<string, unknown>) => { claimsOverride = claims; }, setScope: (value: string) => { grantedScope = value; }, setRefreshError: (value?: string) => { refreshError = value; }, setInferenceMode: (value: typeof inferenceMode) => { inferenceMode = value; }, counts: () => ({ refreshes, inferences }), authorize(url: string) {
    const auth = new URL(url); const code = crypto.randomUUID(); authorization.set(code, auth);
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ code, state: auth.searchParams.get("state")!, client_id: auth.searchParams.get("client_id") === "dynamic_agent_client" ? "oaiapp_fixture" : auth.searchParams.get("client_id")! }).toString();
    return callback;
  } };
}
