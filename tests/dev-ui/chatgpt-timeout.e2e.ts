/** A failed subscription stream through the real browser, relay and SQL authority. */
import { chromium } from "playwright";
import { openFixtureAdmin } from "./operator-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developmentStack, createDevelopmentPool } from "../../scripts/dev-payments";
import { createDevelopmentContextVmServer } from "../../src/dev-ui/contextvm-server";
import { ChatGptModelGateway, SqlChatGptOperations } from "../../src/dev/chatgpt-model-gateway";
import { ChatGptDiagnosticSchema } from "../../src/dev/chatgpt-diagnostic";
import { ModelDispatchObservationSchema } from "../../src/model/model-gateway";
import { chatGptFixture } from "../fixtures/chatgpt";

const assert = (condition: unknown, code: string) => { if (!condition) throw new Error(code); };
const fixture = chatGptFixture();
const timeoutFetch: typeof fixture.fetch = async (url, init) => {
  const response = await fixture.fetch(url, init);
  if (!String(url).endsWith("/responses")) return response;
  await response.body?.cancel();
  return new Response(new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"fixture-timeout"}}\n\n'));
    setTimeout(() => stream.error(new DOMException("private provider details", "TimeoutError")), 10);
  } }), { headers: { "content-type": "text/event-stream" } });
};
const stack = developmentStack(true); const config = await stack.up();
const stateRoot = await mkdtemp(join(tmpdir(), "applet-timeout-e2e-"));
const server = await createDevelopmentContextVmServer({ config, stateRoot, chatGptFetch: timeoutFetch }).catch(async (error) => { await stack.down(true); await rm(stateRoot, { recursive: true, force: true }); throw error; });
const pool = createDevelopmentPool(config.databaseUrl);
const browser = await chromium.launch(); const page = await browser.newPage();
try {
  const admin = await browser.newPage(); await openFixtureAdmin(admin, server.url, stateRoot, fixture);
  await page.goto(server.url); await page.getByText("Workspace connected", { exact: true }).waitFor();
  await page.locator("#idea").fill("A quiet focus timer");
  await page.getByRole("button", { name: "Shape my idea" }).click();
  await page.getByRole("button", { name: "Create my applet" }).click();
  await page.locator("#notice-copy").filter({ hasText: "model time limit" }).waitFor({ timeout: 30000 });
  assert((await page.locator("#conversation-messages").textContent())?.includes("model time limit"), "CHAT_TIMEOUT_EXPLANATION_MISSING");
  const visibleError = await page.locator("#generation-error").textContent();
  assert(!visibleError?.includes("setup could not complete") && !visibleError?.includes("Continue with ChatGPT"), "TIMEOUT_MISLABELED_AS_AUTH");
  assert(!(await page.content()).includes("private provider details"), "RAW_ERROR_EXPOSED");
  assert(fixture.counts().inferences === 1, "TIMEOUT_RETRIED");
  const record = (await pool.query("SELECT observation_json,diagnostic_json FROM development_chatgpt_operations")).rows[0];
  const observation = ModelDispatchObservationSchema.parse(record.observation_json);
  const diagnostic = ChatGptDiagnosticSchema.parse(record.diagnostic_json);
  assert(observation.status === "usage_unknown" && observation.reason === "accepted_timeout" && diagnostic.code === "CHATGPT_GENERATION_TIMEOUT" && diagnostic.phase === "stream", "SQL_TIMEOUT_DETAILS_MISSING");
  assert(diagnostic.httpStatus === 200 && diagnostic.receivedBytes > 0, "SQL_RESPONSE_DETAILS_MISSING");
  assert(await admin.getByRole("button", { name: "Sign out of ChatGPT", exact: true }).isEnabled(), "TIMEOUT_CLEARED_SIGN_IN");
  await page.reload(); await page.getByText("Workspace connected", { exact: true }).waitFor();
  assert(fixture.counts().inferences === 1 && await page.locator("#revise").isDisabled(), "RELOAD_RETRIED_UNKNOWN_ACTION");

  // Exercise SQL replay across gateway replacement without a second network call.
  const operations = new SqlChatGptOperations(pool);
  const options = { accountId: "diagnostic-test", model: "fixture-codex", auth: { accessToken: async () => "fixture-access" }, operations, fetch: timeoutFetch,
    store: { persist: async () => { throw new Error("must not persist partial output"); }, recordProviderObservation: async () => {}, lookupProviderObservation: async () => undefined } };
  const gateway = new ChatGptModelGateway(options);
  const intent = { operationId: "diagnostic-replay", providerRequestId: "diagnostic-request", accountId: "diagnostic-owner", sessionId: "diagnostic-session", actionId: "diagnostic-action", expectedVersion: 0, actionBudgetReference: "diagnostic-budget", profileId: gateway.pricing.profile.id, priceCardId: gateway.pricing.card.id, requestFingerprint: "a".repeat(64), prompt: "A timer", maximumUnits: gateway.pricing.profile.maximumUnits, selection: "unselected" as const };
  assert((await gateway.dispatch(intent, new AbortController().signal)).status === "usage_unknown", "SQL_TIMEOUT_NOT_FENCED");
  const restarted = new ChatGptModelGateway({ ...options, fetch: async () => { throw new Error("REPLAY_DISPATCH_FORBIDDEN"); } });
  assert((await restarted.dispatch(intent, new AbortController().signal)).status === "usage_unknown" && restarted.diagnostic() === "CHATGPT_GENERATION_TIMEOUT", "SQL_DIAGNOSTIC_NOT_RESTORED");
  assert(fixture.counts().inferences === 2, "SQL_REPLAY_CREATED_REQUEST");
  console.log(JSON.stringify({ status: "passed", case: "chatgpt-timeout", checks: ["visible timeout cause", "sign-in retained", "private error redacted", "SQL diagnostics", "reload fence", "restart replay without dispatch"] }));
} catch (error) { console.error("TIMEOUT_TEST", error, await page.locator("#generation-error").textContent().catch(() => ""), await page.locator("#notice-copy").textContent().catch(() => ""), server.generationEvidence().result, (await pool.query("SELECT operation_id,diagnostic_json FROM development_chatgpt_operations")).rows); throw error; } finally {
  await browser.close(); await pool.end();
  try { await server.close(); } finally { await stack.down(true); await rm(stateRoot, { recursive: true, force: true }); }
}
