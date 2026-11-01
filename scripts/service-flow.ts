import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { DevelopmentContextVmClient, type ClientActivity } from "../src/dev-ui/browser/contextvm-client";
import { propagateBlobs } from "../src/dev-ui/browser/blossom-client";
import { CvmBlossom } from "../src/dev/cvm-blossom";

/**
 * End-to-end user flow against a deployed service, using only its public
 * origins: signed/encrypted ContextVM over the public relay, CEP-8 top-ups,
 * metered generation, sandboxed preview, revision, insufficient-funds pause
 * and resume, ownership checks, and user-signed publication to the user's own
 * Blossom servers. The user's Nostr key stays in --identity on this machine.
 *
 *   bun scripts/service-flow.ts --origin https://cvm.example --identity ./user.key --phase full --cashu-token-file ./token
 *   bun scripts/service-flow.ts --origin https://cvm.example --identity ./user.key --phase reopen --state ./flow.json
 */
const arg = (name: string): string | undefined => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const origin = new URL(arg("origin") ?? "").origin;
const phase = arg("phase") ?? "full";
const identityPath = arg("identity") ?? "";
const statePath = arg("state") ?? join(dirname(identityPath), "flow-state.json");
const maximum = arg("maximum") ?? "3750";
if (!identityPath || !["full", "reopen"].includes(phase)) throw new Error("FLOW_USAGE");

function check(condition: unknown, code: string, detail?: unknown): asserts condition {
  if (!condition) throw new Error(`${code}${detail === undefined ? "" : `:${JSON.stringify(detail).slice(0, 400)}`}`);
}
async function userKey(path: string): Promise<string> {
  try { const value = (await readFile(path, "utf8")).trim(); check(/^[a-f0-9]{64}$/u.test(value), "FLOW_IDENTITY_INVALID"); return value; }
  catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    const value = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" }); await chmod(path, 0o600);
    return value;
  }
}

// Isolated restore tests reach the stack directly: `--resolve http://cvm:8080`
// sends every service-origin request there with its original Host header, and
// `--relay` selects the stack's private relay.
const resolveBase = arg("resolve");
const nativeFetch = globalThis.fetch;
const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (!resolveBase || url.protocol !== "https:") return nativeFetch(input as never, init);
  const headers = new Headers(init.headers); headers.set("host", url.host);
  return nativeFetch(new URL(url.pathname + url.search, resolveBase), { ...init, headers });
}) as typeof globalThis.fetch;
const discovered = await (await fetch(`${origin}/cvm.json`, { signal: AbortSignal.timeout(10_000) })).json() as { relayUrl: string; servicePubkey: string };
const bootstrap = { ...discovered, relayUrl: arg("relay") ?? discovered.relayUrl };
const key = await userKey(identityPath);
const pubkey = getPublicKey(Uint8Array.from(Buffer.from(key, "hex")));
const events: Array<{ at: number; tool?: string; stage?: string; state?: string }> = [];
const onActivity = (event: ClientActivity) => { if (event.kind === "progress") events.push({ at: Date.now(), tool: event.progress.tool, stage: event.progress.stage, state: event.progress.state }); };
const connect = async (signingKey: string) => {
  const client = new DevelopmentContextVmClient({ ...bootstrap, reserveSat: "3750", actionCeilingSat: "3750", providerLabel: "flow" }, onActivity, signingKey);
  await client.connect({ accountStatus: false });
  return client;
};
const sign = (template: EventTemplate) => Promise.resolve(finalizeEvent(template, Uint8Array.from(Buffer.from(key, "hex"))));
const balance = async (client: DevelopmentContextVmClient) => { const status = await client.accountStatus(); return { available: BigInt(status.available), held: BigInt(status.held ?? "0"), status }; };
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, code: string, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs; let value = await read();
  while (!done(value)) { check(Date.now() < deadline, code, value); await Bun.sleep(2000); value = await read(); }
  return value;
}
const report: Record<string, unknown> = { origin, servicePubkey: bootstrap.servicePubkey, userPubkey: pubkey, phase };
const client = await connect(key);

try {
  const info = await client.callTool("service_info", {});
  check(info.development === false && info.available === true, "FLOW_SERVICE_INFO", info);
  report.service = { realm: info.realm, providerLabel: info.providerLabel, actionCeilingSat: info.actionCeilingSat };

  if (phase === "full") {
    const start = await balance(client);
    report.startingBalance = start.available.toString();
    // 1. Insufficient funds pauses before any spend: the action is saved, not failed.
    const idea = "A single-purpose tally counter with a large plus button, a minus button and a reset link.";
    let pending = await client.savePreAdmission({ maximum, idea, idempotencyKey: `flow:pending:${crypto.randomUUID()}` });
    if (start.available >= BigInt(maximum)) report.preAdmission = "balance already sufficient";
    else {
      check(pending?.status === "saved" && BigInt(pending.shortfall) > 0n, "FLOW_PAUSE_NOT_SAVED", pending);
      check((await balance(client)).available === start.available, "FLOW_PAUSE_SPENT");
      report.pause = { checkpointId: pending.checkpointId, shortfall: pending.shortfall };
    }

    // 2. CEP-8 Lightning: the requester receives a payable BOLT11 request.
    const lightning = await client.fundNwc("1000");
    check(lightning.status === "payment_required" && typeof lightning.paymentRequest === "string" && /^ln/u.test(lightning.paymentRequest), "FLOW_LIGHTNING_REQUEST", { ...lightning, paymentRequest: lightning.paymentRequest ? "present" : "missing" });
    const afterLightning = await until(() => balance(client), (value) => value.available >= start.available + 1000n, "FLOW_LIGHTNING_NOT_CREDITED", 180_000);
    report.lightning = { topUpId: lightning.topUpId, credited: (afterLightning.available - start.available).toString() };

    // 3. CEP-8 Cashu direct payment, then an identical replay: no second credit.
    const tokenFile = arg("cashu-token-file");
    if (tokenFile) {
      const token = (await readFile(tokenFile, "utf8")).trim();
      const amount = arg("cashu-amount") ?? "4000";
      const args = { idempotencyKey: `flow:cashu:${crypto.randomUUID()}`, topUpId: `flow:cashu:${crypto.randomUUID()}`, pmi: "bitcoin-cashu-v4-direct", mode: "transparent", amount, maxFee: "64" };
      const tags = [["pmi", args.pmi], ["payment_interaction", args.mode], ["direct_payment", args.pmi, token]] as const;
      const first = await client.callTool("top_up", args, tags);
      const replay = await client.callTool("top_up", args, tags);
      check(first.state === "credited" && replay.state === "credited" && replay.topUpId === first.topUpId, "FLOW_CASHU_NOT_CREDITED", { first, replay });
      const afterCashu = await balance(client);
      const credited = afterCashu.available - afterLightning.available;
      check(credited > 0n && credited <= BigInt(amount), "FLOW_CASHU_CREDIT_INVALID", credited.toString());
      const again = await balance(client);
      check(again.available === afterCashu.available, "FLOW_CASHU_REPLAY_DOUBLE_CREDIT");
      report.cashu = { topUpId: first.topUpId, gross: amount, netCredited: credited.toString(), replay: "same top-up, no second credit" };
    }

    // 4. Explicit resume of the saved action, under the user's original maximum.
    const funded = await balance(client);
    check(funded.available >= BigInt(maximum), "FLOW_INSUFFICIENT_TEST_FUNDS", funded.available.toString());
    let sessionResult: any;
    const admissionStarted = Date.now();
    if (pending?.status === "saved") {
      const admission = await client.fundAdmission(pending.maximum, `flow:pending-admission:${pending.checkpointId}`);
      check(admission?.status === "accepted", "FLOW_ADMISSION", admission);
      report.admissionMs = Date.now() - admissionStarted;
      sessionResult = await client.resumePendingAction({ ...pending, admissionReference: admission.admissionReference, idempotencyKey: `flow:pending-resume:${pending.checkpointId}` });
    } else {
      const admission = await client.fundAdmission(maximum);
      check(admission?.status === "accepted", "FLOW_ADMISSION", admission);
      report.admissionMs = Date.now() - admissionStarted;
      sessionResult = await client.startSession({ admissionReference: admission.admissionReference, maximum, idea });
    }
    check(sessionResult?.status === "completed" && sessionResult.artifactId, "FLOW_GENERATION_NOT_COMPLETED", sessionResult);
    const afterFirst = await balance(client);
    const firstSpend = BigInt(sessionResult.confirmedSpend);
    check(firstSpend > 0n && firstSpend <= BigInt(maximum), "FLOW_SPEND_OUTSIDE_CAP", sessionResult);
    // The open session keeps its remaining cap on hold for revisions: settled
    // funds (available + held) fall by exactly the confirmed spend.
    const settled = (value: { available: bigint; held: bigint }) => value.available + value.held;
    check(settled(funded) - settled(afterFirst) === firstSpend && afterFirst.held === BigInt(sessionResult.remainingCap), "FLOW_LEDGER_MISMATCH", { before: settled(funded).toString(), after: settled(afterFirst).toString(), held: afterFirst.held.toString(), remainingCap: sessionResult.remainingCap, spend: sessionResult.confirmedSpend });
    report.generation = { sessionId: sessionResult.sessionId, artifactId: sessionResult.artifactId, confirmedSpend: sessionResult.confirmedSpend, remainingCap: sessionResult.remainingCap, durationMs: Date.now() - admissionStarted };

    // 5. Durable status timeline and sandboxed preview from the preview origin.
    const status = await client.sessionStatus(sessionResult.sessionId);
    check(status.status === "ok", "FLOW_STATUS", status);
    report.timeline = status.session.timeline?.map((item: { stage: string }) => item.stage);
    const preview = await client.preview({ sessionId: sessionResult.sessionId, artifactId: sessionResult.artifactId });
    const ready = (value: { status?: string; state?: string } | undefined) => (value?.status ?? value?.state) === "ready";
    check(ready(preview) && typeof preview.previewUrl === "string", "FLOW_PREVIEW", preview);
    const previewUrl = new URL(preview.previewUrl);
    check(previewUrl.origin !== origin, "FLOW_PREVIEW_ORIGIN_NOT_SEPARATE", previewUrl.origin);
    const shell = await fetch(previewUrl, { signal: AbortSignal.timeout(20_000) });
    const target = await fetch(new URL("__kehto/target.html", previewUrl), { signal: AbortSignal.timeout(20_000) });
    check(shell.ok && target.ok && (target.headers.get("content-security-policy") ?? "").includes("sandbox allow-scripts"), "FLOW_PREVIEW_SANDBOX", { shell: shell.status, target: target.status, csp: target.headers.get("content-security-policy") });
    const config = await (await fetch(new URL("__kehto/config.json", previewUrl))).text();
    const artifactUrl = /"(https:[^"]+\/cvm-artifacts\/[^"]+)"/u.exec(config)?.[1];
    const artifact = artifactUrl ? await fetch(artifactUrl) : undefined;
    check(artifact?.ok && (artifact.headers.get("content-security-policy") ?? "").startsWith("sandbox allow-scripts"), "FLOW_ARTIFACT_SANDBOX", { artifactUrl, status: artifact?.status });
    report.preview = { origin: previewUrl.origin, targetCsp: target.headers.get("content-security-policy"), artifactCsp: artifact!.headers.get("content-security-policy") };

    // 6. Revision, then an identical replay: same result, no second charge.
    const revisionAdmission = await client.fundAdmission(maximum);
    check(revisionAdmission?.status === "accepted", "FLOW_REVISION_ADMISSION", revisionAdmission);
    const revisionInput = { sessionId: sessionResult.sessionId, admissionReference: revisionAdmission.admissionReference, expectedVersion: sessionResult.sessionVersion, maximum, revision: "Show the current count in a much larger font and add a subtle border around the buttons.", idempotencyKey: `flow:revision:${crypto.randomUUID()}` };
    const revised = await client.reviseSession(revisionInput);
    check(revised?.status === "completed" && revised.artifactId && revised.artifactId !== sessionResult.artifactId, "FLOW_REVISION", revised);
    const afterRevision = await balance(client);
    check(settled(afterFirst) - settled(afterRevision) === BigInt(revised.confirmedSpend), "FLOW_REVISION_LEDGER_MISMATCH", { revised, before: settled(afterFirst).toString(), after: settled(afterRevision).toString(), held: afterRevision.held.toString() });
    const replayed = await client.reviseSession(revisionInput);
    check(replayed.artifactId === revised.artifactId && replayed.confirmedSpend === revised.confirmedSpend, "FLOW_REVISION_REPLAY_CHANGED", replayed);
    const afterReplay = await balance(client);
    check(settled(afterReplay) === settled(afterRevision) && afterReplay.held === afterRevision.held, "FLOW_REVISION_REPLAY_CHARGED");
    report.revision = { artifactId: revised.artifactId, confirmedSpend: revised.confirmedSpend, replay: "same artifact, no second charge" };

    // 7. Ownership: another Nostr identity sees nothing.
    const stranger = await connect(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"));
    try {
      const foreignStatus = await stranger.sessionStatus(sessionResult.sessionId).catch((error: Error) => ({ status: error.message }));
      const foreignPreview = await stranger.preview({ sessionId: sessionResult.sessionId, artifactId: revised.artifactId }).catch((error: Error) => ({ status: error.message }));
      check(foreignStatus.status !== "ok" && !ready(foreignPreview) && !foreignPreview.previewUrl, "FLOW_OWNERSHIP_LEAK", { foreignStatus, foreignPreview });
      report.ownership = { foreignStatus: foreignStatus.status, foreignPreview: foreignPreview.status ?? foreignPreview.state };
    } finally { await stranger.close(); }

    // 8. Publication through the napplet CLI upload contract, signed by the user,
    // copied to two Blossom servers the user controls.
    const blossomRoot = await mkdtemp(join(tmpdir(), "user-blossom-"));
    const servers = await Promise.all([0, 1].map(async (index) => {
      let url = "";
      const blossom = new CvmBlossom(join(blossomRoot, String(index)), pubkey, () => url);
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => blossom.handle(request) });
      url = `http://127.0.0.1:${server.port}`;
      return { url, server };
    }));
    try {
      const prepared = await client.callTool("development_publication", { action: "prepare", sessionId: sessionResult.sessionId, artifactId: revised.artifactId, publisher: pubkey, requestKey: crypto.randomUUID(), title: "Tally counter", description: "A focused tally counter generated and verified by napplet-cvm.", servers: servers.map((item) => `${item.url}/`), relays: [bootstrap.relayUrl] });
      check(prepared?.template && prepared.publisher === pubkey, "FLOW_PUBLICATION_PREPARE", prepared);
      const event = await sign(prepared.template);
      let saved = await client.callTool("development_publication", { action: "save", id: prepared.id, event });
      let applicationEvent;
      if (saved.application && !saved.application.signedEvent) {
        applicationEvent = await sign(saved.application.template);
        saved = await client.callTool("development_publication", { action: "save", id: prepared.id, event, applicationEvent });
      }
      const receipts: Array<{ server: string; file: string; state: string }> = [];
      const copied = await propagateBlobs(saved.files, saved.servers, { sign }, (item) => receipts.push(item));
      check(copied, "FLOW_BLOSSOM_COPY", receipts.filter((item) => item.state === "failed"));
      const latest = new Map(receipts.map((item) => [`${item.server}\n${item.file}`, item]));
      saved = await client.callTool("development_publication", { action: "save", id: prepared.id, event, fileResults: [...latest.values()] });
      let published = await client.callTool("development_publication", { action: "submit", id: prepared.id, event });
      published = await until(() => client.callTool("development_publication", { action: "status", id: prepared.id }), (value: any) => value.status === "published", "FLOW_PUBLICATION_NOT_PUBLISHED", 90_000);
      check(published.signedEvent?.pubkey === pubkey && published.signedEvent.id === event.id, "FLOW_PUBLICATION_SIGNER", published.signedEvent);
      report.publication = { id: prepared.id, eventId: event.id, kind: event.kind, publisher: pubkey, address: published.address, files: saved.files.length, verifiedServers: 2, relayResults: published.relayResults };
    } finally { for (const item of servers) item.server.stop(true); }

    const projects = await client.callTool("projects", { action: "list" }).catch((error: Error) => ({ error: error.message }));
    const final = await balance(client);
    report.final = { balance: final.available.toString(), held: final.held.toString(), settled: (final.available + final.held).toString(), projects: Array.isArray(projects?.projects) ? projects.projects.length : projects };
    await writeFile(statePath, JSON.stringify({ sessionId: sessionResult.sessionId, artifactId: revised.artifactId, balance: report.final, spends: [sessionResult.confirmedSpend, revised.confirmedSpend] }, null, 2), { mode: 0o600 });
  } else {
    // Reopen after restart/restore: same identity, same artifact, no model call.
    const prior = JSON.parse(await readFile(statePath, "utf8")) as { sessionId: string; artifactId: string; balance: { balance: string } };
    const now = await balance(client);
    check(now.available.toString() === prior.balance.balance && (now.available + now.held).toString() === (prior.balance as { settled?: string }).settled, "FLOW_REOPEN_BALANCE_CHANGED", { prior: prior.balance, now: now.available.toString(), held: now.held.toString() });
    const status = await client.sessionStatus(prior.sessionId);
    check(status.status === "ok", "FLOW_REOPEN_STATUS", status);
    const preview = await client.preview({ sessionId: prior.sessionId, artifactId: prior.artifactId });
    check((preview?.status ?? preview?.state) === "ready", "FLOW_REOPEN_PREVIEW", preview);
    const target = await fetch(new URL("__kehto/target.html", preview.previewUrl), { signal: AbortSignal.timeout(20_000) });
    check(target.ok, "FLOW_REOPEN_PREVIEW_UNREACHABLE", target.status);
    check((await balance(client)).available === now.available && !events.some((event) => event.stage === "model"), "FLOW_REOPEN_CHARGED_OR_CALLED_MODEL", events);
    report.reopen = { sessionId: prior.sessionId, artifactId: prior.artifactId, balance: now.available.toString(), modelCalls: 0 };
  }
  report.progress = events.filter((event) => ["admission", "model", "worker", "create", "conformance", "artifact", "ledger", "preview"].includes(event.stage ?? "")).map((event) => `${event.tool}:${event.stage}:${event.state}@${event.at}`);
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  console.log(JSON.stringify(report, null, 2));
}
