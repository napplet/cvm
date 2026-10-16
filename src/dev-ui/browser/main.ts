import { consoleMarkup } from "./console-view";
import { ProductWorkspace } from "./product-workspace";
import { ExecutionActivity } from "./activity";
import { ensureChatGptReady, mountChatGptSettings, showChatGptDiagnostic } from "./chatgpt-settings";
import { DevelopmentContextVmClient, type DevelopmentBootstrap } from "./contextvm-client";

type PendingAction = Readonly<{ checkpointId: string; reference: string; fingerprint: string; maximum: string; shortfall: string; expiresAtMs: number }>;
type Version = Readonly<{ sessionId: string; version: number; artifactId: string; aggregate?: string }>;
// OAuth always returns to /. Restore the initiating surface without an open redirect.
if ((location.search.includes("chatgpt=") || location.search.includes("chatgpt_error=")) && sessionStorage.getItem("napplet-cvm/auth-surface") === "/dev") {
  sessionStorage.removeItem("napplet-cvm/auth-surface"); location.replace(`/dev${location.search}`); await new Promise(() => {});
}
const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("DEV_UI_ROOT_MISSING");
const bootstrap = await (await fetch("/bootstrap", { cache: "no-store" })).json() as DevelopmentBootstrap;
const pendingStorageKey = `napplet-cvm/dev-pending/v1/${bootstrap.servicePubkey}`;
const sessionStorageKey = `napplet-cvm/dev-session/v1/${bootstrap.servicePubkey}`;
let client: DevelopmentContextVmClient | undefined;
let balance = "0";
let pending: PendingAction | undefined;
let selected: Version | undefined;
let lastRevision: Readonly<{ sessionId: string; admissionReference: string; expectedVersion: number; maximum: string; revision: string; idempotencyKey: string }> | undefined;
const versions: Version[] = [];

const product = location.pathname === "/dev" ? undefined : new ProductWorkspace(app, bootstrap);
if (!product) app.innerHTML = consoleMarkup(bootstrap);

const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const activity = new ExecutionActivity(byId("execution-activity"), bootstrap.providerLabel, product ? (snapshot) => product.progress(snapshot) : undefined);
const connectedControls = [byId<HTMLButtonElement>("cashu"), byId<HTMLButtonElement>("cashu-replay"), byId<HTMLButtonElement>("nwc"), byId<HTMLButtonElement>("generate")];
function setFundingStatus(value: string): void { byId("funding-status").textContent = value; }
function setGenerationStatus(value: string): void { byId("generation-status").textContent = value; }
function setError(value = ""): void {
  byId("generation-error").textContent = value;
  if (!value) return;
  const uncertain = /UNKNOWN|UNRESOLVED|TIMEOUT|CONNECTION|SEND_FAILED/iu.test(value);
  product?.failed(value, uncertain);
  activity.finish(uncertain ? "Outcome unconfirmed" : "Action stopped", uncertain ? "uncertain" : "failed");
  setGenerationStatus(uncertain ? activity.generationResponded ? "Generation stopped; provider outcome unconfirmed" : "Outcome unconfirmed; check session status" : "Action stopped; see error below");
  void showChatGptDiagnostic().then((explanation) => {
    if (explanation && byId("generation-error").textContent === value) {
      byId("generation-error").textContent = `${value} · ${explanation}`;
      activity.explainFailure(explanation);
    }
  });
}
function setBalance(account: Readonly<{ available: string; held?: string }>): void { balance = account.available; const held = account.held ?? "0"; byId("balance").textContent = `Available: ${balance} sats · held: ${held} sats · settled: ${BigInt(balance) + BigInt(held)} sats`; }
function facts(values: Record<string, unknown>): void { const list = byId<HTMLDListElement>("generation-facts"); list.replaceChildren(...Object.entries(values).flatMap(([key, value]) => { const term = document.createElement("dt"); term.textContent = key; const detail = document.createElement("dd"); detail.textContent = String(value); return [term, detail]; })); }
function appendTimeline(label: string, detail: string): void { const item = document.createElement("li"); item.textContent = `${label}: ${detail}`; byId("timeline").append(item); }
function savePending(value: PendingAction | undefined): void { pending = value; if (value) sessionStorage.setItem(pendingStorageKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingStorageKey); renderPending(); }
function restorePending(): PendingAction | undefined { try { const value = JSON.parse(sessionStorage.getItem(pendingStorageKey) ?? "null"); return value && typeof value.checkpointId === "string" && typeof value.reference === "string" && typeof value.fingerprint === "string" && typeof value.maximum === "string" && typeof value.shortfall === "string" && Number.isSafeInteger(value.expiresAtMs) ? value : undefined; } catch { return undefined; } }
function renderPending(): void { const section = byId("continuation"); if (!pending) { section.hidden = true; return; } section.hidden = false; byId("pending-status").textContent = `Saved action needs ${pending.shortfall} more sats before an explicit resume. Expires ${new Date(pending.expiresAtMs).toLocaleString()}.`; }
function validMaximum(value: string): boolean { try { return BigInt(value) >= BigInt(bootstrap.actionCeilingSat); } catch { return false; } }
async function selectVersion(version: Version): Promise<any> { const descriptor = await client!.preview({ sessionId: version.sessionId, artifactId: version.artifactId }); if (descriptor?.status !== "ready" || typeof descriptor.previewUrl !== "string") throw new Error("PREVIEW_NOT_READY"); const frame = byId<HTMLIFrameElement>("preview"); const previewUrl = new URL(descriptor.previewUrl); if (product) previewUrl.searchParams.set("presentation", "workspace"); frame.src = previewUrl.href; frame.hidden = false; selected = version; byId<HTMLButtonElement>("revise").disabled = activity.running; product?.selected(version); renderVersions(); return descriptor; }
function renderVersions(): void { const list = byId<HTMLUListElement>("versions"); list.replaceChildren(...versions.map((version) => { const item = document.createElement("li"); const button = document.createElement("button"); button.disabled = activity.running; button.textContent = `Version ${version.version}: ${version.artifactId}`; button.onclick = () => { void selectVersion(version).then(() => facts({ selectedVersion: version.version, artifact: version.artifactId })).catch((error) => setError(`Preview unavailable: ${error instanceof Error ? error.message : "unknown"}`)); }; item.append(button); return item; })); product?.versions(versions, selected, async (version) => { try { await selectVersion(version); facts({ selectedVersion: version.version, artifact: version.artifactId }); } catch (error) { setError(`Preview unavailable: ${error instanceof Error ? error.message : "unknown"}`); } }); }
function renderDurableTimeline(status: any): void { const timeline = byId<HTMLUListElement>("timeline"); const events = Array.isArray(status?.timeline) ? status.timeline : []; timeline.replaceChildren(...events.map((event: any) => { const item = document.createElement("li"); item.textContent = `${event.stage.replaceAll("_", " ")} · ${new Date(event.at).toLocaleTimeString()} · ${event.detail}`; return item; })); }
async function refresh(): Promise<void> { if (client) setBalance(await client.accountStatus()); }
async function preview(action: any): Promise<void> { if (!action?.artifactId) throw new Error("ARTIFACT_NOT_AVAILABLE"); const version = { sessionId: action.sessionId, version: action.artifactVersion, artifactId: action.artifactId }; if (versions.some((item) => item.sessionId !== version.sessionId)) versions.length = 0; if (!versions.some((item) => item.version === version.version && item.sessionId === version.sessionId)) versions.push(version); renderVersions(); const descriptor = await selectVersion(version); const generation = action.generation; facts({ provider: generation?.provider ?? "durably recorded", model: generation?.model ?? "recorded", usage: Array.isArray(generation?.usage) ? generation.usage.map((line: any) => `${line.dimension}:${line.units}`).join(", ") : "recorded", worker: generation?.worker ?? "verified", stage: "verified", version: action.artifactVersion, artifact: action.artifactId, aggregate: descriptor.aggregateSha256, charge: action.confirmedSpend, remainingMaximum: action.remainingCap, remainingBalance: action.remainingBalance }); appendTimeline("verified preview", `version ${action.artifactVersion} · charge ${action.confirmedSpend} sats`); product?.completed(version); }
async function hydrateSession(sessionId: string): Promise<void> {
  const status = await client!.sessionStatus(sessionId); if (status?.status !== "ok") return;
  versions.splice(0, versions.length, ...(status.session.verifiedArtifacts ?? []).map((item: any) => ({ sessionId, version: item.version, artifactId: item.id })).sort((a: Version, b: Version) => a.version - b.version));
  renderVersions(); renderDurableTimeline(status.session); const latest = versions.at(-1); if (!latest) return;
  await selectVersion(latest);
  facts({ session: sessionId, state: status.session.state, version: latest.version, artifact: latest.artifactId, remainingMaximum: status.session.remainingCap, remainingBalance: status.session.remainingBalance });
  product?.completed(latest, true); product?.sessionState(status.session.state);
}

async function complete(action: any): Promise<void> { if (action?.status !== "completed") throw new Error(action?.code ?? "GENERATION_NOT_COMPLETED"); sessionStorage.setItem(sessionStorageKey, action.sessionId); await preview(action); const status = await client!.sessionStatus(action.sessionId); if (status?.status === "ok") renderDurableTimeline(status.session); await refresh(); setGenerationStatus("Verified preview ready"); clearRequest(); }

byId<HTMLButtonElement>("connect").onclick = async () => {
  const button = byId<HTMLButtonElement>("connect"); button.disabled = true;
  try {
    await client?.close().catch(() => undefined);
    client = new DevelopmentContextVmClient(bootstrap, (event) => activity.receive(event));
    const connected = await client.connect();
    byId("connection-status").textContent = `Connected: ${connected.pubkey}`; setBalance(connected.account);
    connectedControls.forEach((control) => control.disabled = false); byId("provider-mode").textContent = bootstrap.providerLabel;
    const stored = restorePending();
    if (stored) { const status = await client.pendingActionStatus(stored.checkpointId); if (status?.status === "saved") { savePending(status); appendTimeline("saved action", `shortfall ${status.shortfall} sats`); } else savePending(undefined); }
    const sessionId = sessionStorage.getItem(sessionStorageKey); if (sessionId) { try { await hydrateSession(sessionId); } catch (error) { setError(`Preview unavailable: ${error instanceof Error ? error.message : "unknown"}`); } }
    product?.connected(true); product?.recovery(!!restoreRequest());
  } catch { await client?.close().catch(() => undefined); client = undefined; byId("connection-status").textContent = "Connection failed; retry Connect"; button.disabled = false; connectedControls.forEach((control) => control.disabled = true); product?.connected(false); }
};
byId<HTMLButtonElement>("cashu").onclick = async () => { try { setFundingStatus("Cashu payment pending"); const payment = await client!.fundCashu(byId<HTMLInputElement>("cashu-amount").value); await refresh(); setFundingStatus(payment?.state === "credited" ? "Cashu credited" : "Cashu credit unconfirmed; check account status before retrying"); } catch { setFundingStatus("Cashu credit unconfirmed; check account status before retrying"); } };
byId<HTMLButtonElement>("cashu-replay").onclick = async () => { try { const payment = await client!.replayCashu(); await refresh(); setFundingStatus(payment?.state === "credited" ? "Cashu replay credited once" : "Cashu replay unconfirmed; check account status"); } catch { setFundingStatus("Cashu replay unconfirmed; check account status"); } };
byId<HTMLButtonElement>("nwc").onclick = async () => { try { setFundingStatus("NWC settlement pending"); const payment = await client!.fundNwc(byId<HTMLInputElement>("nwc-amount").value); if (typeof payment?.topUpId !== "string") throw new Error("NWC_TOP_UP_ID_MISSING"); setFundingStatus(`NWC settlement pending (${payment.topUpId})`); for (let attempt = 0; attempt < 120; attempt++) { await new Promise((resolve) => setTimeout(resolve, 500)); const account = await client!.accountStatus(); setBalance(account); if (account.topUps?.find((item: any) => item.topUpId === payment.topUpId)?.state === "credited") { setFundingStatus("NWC credited"); return; } } setFundingStatus("NWC settlement unconfirmed; check account status before retrying"); } catch { setFundingStatus("NWC settlement unconfirmed; check account status before retrying"); } };
byId<HTMLButtonElement>("generate").onclick = async () => { const button = byId<HTMLButtonElement>("generate"); button.disabled = true; setError(); try { const maximum = byId<HTMLInputElement>("maximum").value; const idea = byId<HTMLInputElement>("idea").value.trim(); if (!idea || !validMaximum(maximum)) throw new Error("Enter a focused idea and a maximum at or above the action ceiling"); const idempotencyKey = `browser:pending-start:${crypto.randomUUID()}`; if (BigInt(balance) < BigInt(maximum)) { setGenerationStatus("Saving action for explicit funding and resume"); const saved = await client!.savePreAdmission({ maximum, idea, idempotencyKey }); if (saved?.status === "saved") { savePending(saved); appendTimeline("saved action", `shortfall ${saved.shortfall} sats`); setGenerationStatus("Action saved; funding does not start it"); return; } if (saved?.status !== "funded_admission_required") throw new Error(saved?.code ?? "PENDING_ACTION_NOT_SAVED"); } setGenerationStatus("Request status: reserving ready isolated capacity"); const admission = await client!.fundAdmission(maximum); if (admission?.status !== "accepted") throw new Error("ADMISSION_NOT_ACCEPTED"); setGenerationStatus("Request status: creating metered proposal and isolated build"); await complete(await runGeneration({ kind: "start", input: { admissionReference: admission.admissionReference, maximum, idea, idempotencyKey } })); } catch (error) { setError(`Generation unavailable: ${error instanceof Error ? error.message : "unknown"}`); } finally { button.disabled = !client; } };
byId<HTMLButtonElement>("resume").onclick = async () => { if (!pending) return; const button = byId<HTMLButtonElement>("resume"); button.disabled = true; setError(); let step = "funded admission"; try { setGenerationStatus("Request status: accepting original maximum"); const admission = await client!.fundAdmission(pending.maximum, `browser:pending-admission:${pending.checkpointId}`); if (admission?.status !== "accepted") throw new Error("ADMISSION_NOT_ACCEPTED"); step = "pending action"; setGenerationStatus("Request status: resuming saved action"); const action = await runGeneration({ kind: "resume", input: { ...pending, admissionReference: admission.admissionReference, idempotencyKey: `browser:pending-resume:${pending.checkpointId}` } }); await complete(action); appendTimeline("resumed action", "accepted admission and exact pending action completed"); savePending(undefined); } catch (error) { setError(`Resume unavailable during ${step}: ${error instanceof Error ? error.message : "unknown"}`); } finally { button.disabled = !client || !pending; } };
byId<HTMLButtonElement>("revise").onclick = async () => { if (!selected) return; const button = byId<HTMLButtonElement>("revise"); button.disabled = true; setError(); try { const revision = byId<HTMLInputElement>("revision").value.trim(); const maximum = byId<HTMLInputElement>("maximum").value; if (!revision || !validMaximum(maximum)) throw new Error("Enter a bounded revision and valid maximum"); const admission = await client!.fundAdmission(maximum); if (admission?.status !== "accepted") throw new Error("ADMISSION_NOT_ACCEPTED"); lastRevision = Object.freeze({ sessionId: selected.sessionId, admissionReference: admission.admissionReference, expectedVersion: selected.version, maximum, revision, idempotencyKey: `browser:revision:${crypto.randomUUID()}` }); setGenerationStatus("Request status: verifying revision"); await complete(await runGeneration({ kind: "revise", input: lastRevision })); byId<HTMLButtonElement>("replay-revision").disabled = false; } catch (error) { setError(`Revision unavailable: ${error instanceof Error ? error.message : "unknown"}`); } finally { button.disabled = !client || !selected; } };
byId<HTMLButtonElement>("replay-revision").onclick = async () => { if (!lastRevision) return; const button = byId<HTMLButtonElement>("replay-revision"); button.disabled = true; setError(); try { setGenerationStatus("Request status: replaying the signed revision request"); await complete(await runGeneration({ kind: "revise", input: lastRevision })); } catch (error) { setError(`Revision replay unavailable: ${error instanceof Error ? error.message : "unknown"}`); } finally { button.disabled = !client || !lastRevision; } };

// Keep the exact authorized request across reloads. Recovery reuses its admission
// and idempotency key, so the service joins/returns the original operation.
type GenerationRequest =
  | { kind: "start"; input: Parameters<DevelopmentContextVmClient["startSession"]>[0] }
  | { kind: "revise"; input: Parameters<DevelopmentContextVmClient["reviseSession"]>[0] }
  | { kind: "resume"; input: Parameters<DevelopmentContextVmClient["resumePendingAction"]>[0] };
const requestStorageKey = `applet-broker/original-request/v1/${bootstrap.servicePubkey}`;
function restoreRequest(): GenerationRequest | undefined {
  if (!product) return;
  try {
    const value = JSON.parse(sessionStorage.getItem(requestStorageKey) ?? "null");
    if (!value || !["start", "revise", "resume"].includes(value.kind) || typeof value.input?.idempotencyKey !== "string" || typeof value.input?.admissionReference !== "string" || !/^\d+$/u.test(value.input?.maximum)) return;
    return value;
  } catch { return; }
}
function clearRequest(): void { if (product) { sessionStorage.removeItem(requestStorageKey); product.recovery(false); } }
async function runGeneration(request: GenerationRequest): Promise<any> {
  if (product) sessionStorage.setItem(requestStorageKey, JSON.stringify(request));
  const result = request.kind === "start" ? await client!.startSession(request.input) : request.kind === "revise" ? await client!.reviseSession(request.input) : await client!.resumePendingAction(request.input);
  // A terminal failure is a confirmed response, even when provider usage remains unknown.
  if (["failed", "denied", "billing_invariant_failed", "usage_unknown"].includes(result?.status)) clearRequest();
  return result;
}
async function prepareTestFunds(maximum: string): Promise<void> {
  await refresh();
  const shortfall = BigInt(maximum) - BigInt(balance); if (shortfall <= 0n) return;
  if (shortfall > 10_000n) throw new Error("TEST_FUNDING_LIMIT: lower the test maximum or fund in the development console");
  setFundingStatus("Preparing local test funds");
  const payment = await client!.fundCashu(String(shortfall)); await refresh();
  if (payment?.state !== "credited" || BigInt(balance) < BigInt(maximum)) throw new Error("TEST_FUNDING_UNCONFIRMED");
  setFundingStatus("Local test funds ready");
}
if (product) byId<HTMLButtonElement>("recover").onclick = async () => {
  const request = restoreRequest(); if (!request) return;
  setError(); await complete(await runGeneration(request)); if (request.kind === "resume") savePending(undefined);
};
// One visual action spans admission, generation and opening its verified preview.
const actionButtons = ["generate", "resume", "revise", "replay-revision", ...(product ? ["recover"] : [])];
for (const id of actionButtons) {
  const button = byId<HTMLButtonElement>(id); const run = button.onclick!;
  button.onclick = async (event) => {
    if (!client || activity.running || (product && id !== "recover" && restoreRequest()) || product?.validate(id) === false) return;
    product?.begin(id === "recover" ? `recover-${restoreRequest()?.kind}` : id);
    activity.begin(button.textContent ?? "Action", bootstrap.providerLabel);
    byId("generation-facts").replaceChildren(); setGenerationStatus(""); setError();
    for (const name of actionButtons) byId<HTMLButtonElement>(name).disabled = true;
    byId("versions").querySelectorAll("button").forEach((item) => item.disabled = true);
    try {
      if (id !== "replay-revision" && id !== "recover") {
        await ensureChatGptReady(bootstrap);
        if (product) await prepareTestFunds(id === "resume" && pending ? pending.maximum : byId<HTMLInputElement>("maximum").value);
      }
      await run.call(button, event);
      activity.finish(byId("generation-status").textContent === "Verified preview ready" ? "Completed · verified preview ready" : "Paused · saved action awaits funding and Resume");
    } catch (error) { setError(error instanceof Error ? error.message : "Action failed"); }
    finally {
      byId<HTMLButtonElement>("generate").disabled = !client;
      byId<HTMLButtonElement>("resume").disabled = !client || !pending;
      byId<HTMLButtonElement>("revise").disabled = !client || !selected;
      byId<HTMLButtonElement>("replay-revision").disabled = !client || !lastRevision;
      product?.settled(); product?.recovery(!!restoreRequest()); renderVersions();
    }
  };
}
byId("provider-mode").textContent = bootstrap.providerLabel;
void mountChatGptSettings(bootstrap, (summary) => product?.model(summary));
if (product) { product.recovery(!!restoreRequest()); byId<HTMLButtonElement>("connect").click(); }
