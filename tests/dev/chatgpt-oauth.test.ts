import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptOAuth, type ChatGptFetch } from "../../src/dev/chatgpt-oauth";
import { DevelopmentChatGptRoutes } from "../../src/dev-ui/chatgpt-routes";
import { chatGptFixture } from "../fixtures/chatgpt";

const clients: ChatGptOAuth[] = []; const roots: string[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(wrap: (fetch: ChatGptFetch) => ChatGptFetch = (fetch) => fetch) {
  let now = Date.now(); const fixture = chatGptFixture(() => now); const root = await mkdtemp(join(tmpdir(), "napplet-oauth-")); roots.push(root);
  const auth = await ChatGptOAuth.open(root, { fetch: wrap(fixture.fetch), now: () => now }); clients.push(auth);
  const login = async () => { const flow = await auth.begin("http://127.0.0.1:12345"); return auth.callback(fixture.authorize(flow.url), flow.cookie); };
  return { auth, root, fixture, login, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("PKCE dynamic registration persists private tokens, safe identity and selected model across restart", async () => {
  const { auth, root, fixture, login, now } = await setup(); const id = await login();
  expect(await auth.models(id)).toEqual([{ slug: "fixture-codex", displayName: "Fixture Codex" }]);
  await auth.select({ mode: "chatgpt", accountId: id, model: "fixture-codex" });
  expect(JSON.stringify(auth.status())).not.toContain("fixture-access"); expect(JSON.stringify(auth.status())).not.toContain("fixture-refresh");
  expect((await stat(join(root, "accounts.json"))).mode & 0o077).toBe(0);
  await expect(ChatGptOAuth.open(root)).rejects.toThrow("AUTH_BUSY");
  await auth.close(); clients.splice(clients.indexOf(auth), 1);
  const reopened = await ChatGptOAuth.open(root, { fetch: fixture.fetch, now }); clients.push(reopened);
  expect(reopened.settings()).toEqual({ mode: "chatgpt", accountId: id, model: "fixture-codex" });
  expect(await reopened.accessToken(id)).toBe("fixture-access-initial");
  const again = await reopened.begin("http://127.0.0.1:12345", id);
  expect(new URL(again.url).searchParams.get("client_id")).toBe("oaiapp_fixture");
  expect(new URL(again.url).searchParams.has("id_token_hint")).toBe(false);
});

test("state, initiating browser, one-time callback and account identity are enforced", async () => {
  const { auth, fixture } = await setup(); const flow = await auth.begin("http://127.0.0.1:12345"); const callback = fixture.authorize(flow.url);
  await expect(auth.callback(callback, "wrong-browser")).rejects.toThrow("STATE_INVALID");
  const wrong = new URL(callback); wrong.searchParams.set("state", "wrong"); await expect(auth.callback(wrong, flow.cookie)).rejects.toThrow("STATE_INVALID");
  const id = await auth.callback(callback, flow.cookie);
  await expect(auth.callback(callback, flow.cookie)).rejects.toThrow("STATE_INVALID");
  fixture.setClaims({ sub: "other-person" }); const reauth = await auth.begin("http://127.0.0.1:12345", id);
  await expect(auth.callback(fixture.authorize(reauth.url), reauth.cookie)).rejects.toThrow("ACCOUNT_MISMATCH");
  expect(await auth.accessToken(id)).toBe("fixture-access-initial");
});

for (const claims of [{ iss: "https://attacker.test" }, { aud: "another-client" }, { nonce: "wrong" }, { exp: 1 }, { azp: "another-client" }]) {
  test(`ID token rejects mismatched ${Object.keys(claims)[0]}`, async () => {
    const { fixture, login, auth } = await setup(); fixture.setClaims(claims); await expect(login()).rejects.toThrow("ID_TOKEN_INVALID"); expect(auth.status().accounts).toHaveLength(0);
  });
}

test("refresh is serialized, rotating replacement survives restart, terminal errors preserve registration", async () => {
  const { auth, fixture, login, advance, root } = await setup(); const id = await login(); advance(3_550_000);
  expect(await Promise.all([auth.accessToken(id), auth.accessToken(id), auth.accessToken(id)])).toEqual(Array(3).fill("fixture-access-1"));
  expect(fixture.counts().refreshes).toBe(1);
  expect(JSON.parse(await readFile(join(root, "accounts.json"), "utf8")).accounts[0].tokens.refresh).toBe("fixture-refresh-1");
  advance(3_550_000); fixture.setRefreshError("invalid_grant"); await expect(auth.accessToken(id)).rejects.toThrow("REAUTHORIZE_REQUIRED");
  expect(auth.status().accounts[0]).toMatchObject({ signedIn: false, id });
  const flow = await auth.begin("http://127.0.0.1:12345", id); expect(new URL(flow.url).searchParams.get("client_id")).toBe("oaiapp_fixture");
});

test("missing plan permission never permits inference; sign-out revokes and clears every token", async () => {
  const { auth, fixture, login, root } = await setup(); fixture.setScope("openid profile email offline_access"); const id = await login();
  await expect(auth.accessToken(id)).rejects.toThrow("PLAN_PERMISSION_REQUIRED"); expect(auth.status().accounts[0]?.planEnabled).toBe(false);
  expect(await auth.logout(id)).toEqual({ revoked: true });
  const saved = await readFile(join(root, "accounts.json"), "utf8"); expect(saved).not.toContain("fixture-access"); expect(saved).not.toContain("fixture-refresh");
  expect(JSON.parse(saved).accounts[0].clientId).toBe("oaiapp_fixture");
});

test("local operator routes deny cross-origin, missing token, non-JSON and spoofed host requests", async () => {
  const { auth } = await setup(); const origin = "http://127.0.0.1:12345";
  const routes = new DevelopmentChatGptRoutes({ auth, select: async () => {}, busy: () => false, diagnostic: () => undefined });
  for (const headers of [{}, { "x-dev-model-token": routes.controlToken, origin: "https://evil.test" }, { "x-dev-model-token": routes.controlToken, "sec-fetch-site": "cross-site" }]) expect((await routes.handle(new Request(`${origin}/dev/chatgpt/status`, { headers }), origin))?.status).toBe(403);
  expect((await routes.handle(new Request(`${origin}/dev/chatgpt/status`, { headers: { "x-dev-model-token": routes.controlToken } }), origin))?.status).toBe(200);
  expect((await routes.handle(new Request(`${origin}/dev/chatgpt/sign-in`, { method: "POST", headers: { "x-dev-model-token": routes.controlToken, origin }, body: "{}" }), origin))?.status).toBe(405);
  expect((await routes.handle(new Request("http://attacker.test/dev/chatgpt/status", { headers: { "x-dev-model-token": routes.controlToken } }), origin))?.status).toBe(403);
});

test("a valid-looking ID token signed by a different key is rejected", async () => {
  const other = chatGptFixture();
  const { login, auth } = await setup((fetch) => (url, init) => String(url).endsWith("/jwks.json") ? other.fetch(url, init) : fetch(url, init));
  await expect(login()).rejects.toThrow("ID_TOKEN_INVALID");
  expect(auth.status().accounts).toHaveLength(0);
});

test("transient refresh failure preserves credentials and permits a later refresh", async () => {
  const { auth, fixture, login, advance, root } = await setup(); const id = await login(); advance(3_550_000);
  fixture.setRefreshError("temporarily_unavailable");
  await expect(auth.accessToken(id)).rejects.toThrow("TOKEN_EXCHANGE_UNAVAILABLE");
  expect(auth.status().accounts[0]?.signedIn).toBe(true);
  expect(JSON.parse(await readFile(join(root, "accounts.json"), "utf8")).accounts[0].tokens.refresh).toBe("fixture-refresh-initial");
  fixture.setRefreshError(); expect(await auth.accessToken(id)).toBe("fixture-access-2");
});

test("unconfirmed remote revocation still clears local tokens and reports the limitation", async () => {
  const { auth, login, root } = await setup((fetch) => (url, init) => String(url).endsWith("/oauth/revoke") ? Promise.resolve(new Response(null, { status: 503 })) : fetch(url, init));
  const id = await login(); expect(await auth.logout(id)).toEqual({ revoked: false });
  expect(auth.status().notice).toBe("CHATGPT_REMOTE_REVOCATION_UNCONFIRMED");
  expect(JSON.parse(await readFile(join(root, "accounts.json"), "utf8")).accounts[0].tokens).toBeUndefined();
  await expect(auth.accessToken(id)).rejects.toThrow("SIGN_IN_REQUIRED");
});

test("expired authorization and symlinked credential storage fail closed", async () => {
  const { auth, fixture, advance, root } = await setup(); const flow = await auth.begin("http://127.0.0.1:12345");
  advance(600_001); await expect(auth.callback(fixture.authorize(flow.url), flow.cookie)).rejects.toThrow("STATE_INVALID");
  await auth.close();
  await rename(join(root, "accounts.json"), join(root, "elsewhere.json"));
  await symlink(join(root, "elsewhere.json"), join(root, "accounts.json"));
  await expect(ChatGptOAuth.open(root)).rejects.toThrow("PRIVATE_STORAGE_INVALID");
});
