import { DevelopmentContextVmClient, type DevelopmentBootstrap } from "./contextvm-client";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("DEV_UI_ROOT_MISSING");

const bootstrap = await (await fetch("/bootstrap", { cache: "no-store" })).json() as DevelopmentBootstrap;
let client: DevelopmentContextVmClient | undefined;
let balance = "0";

app.innerHTML = `
  <style>body{font:16px system-ui;margin:0;background:#10151c;color:#eef4f8}main{max-width:960px;margin:auto;padding:24px;display:grid;gap:16px}section{background:#19232d;border-radius:10px;padding:20px}button,input{min-height:44px;font:inherit}button{padding:0 16px}input{width:100%;box-sizing:border-box}label{display:grid;gap:6px}.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.status{min-height:24px}@media(max-width:767px){main{padding:12px}.row>*{width:100%}}</style>
  <h1>napplet-cvm development</h1>
  <section aria-labelledby="connection-heading"><h2 id="connection-heading">Connection</h2><p id="connection-status" class="status">Disconnected</p><button id="connect">Connect</button></section>
  <section aria-labelledby="funds-heading"><h2 id="funds-heading">Funds and limits</h2><p id="balance">0 sats</p><p>Current maximum reserve: <strong>${bootstrap.reserveSat} sats</strong>. Action ceiling: <strong>${bootstrap.actionCeilingSat} sats</strong>.</p><div class="row"><label>Cashu amount (sats)<input id="cashu-amount" inputmode="numeric" value="64"></label><button id="cashu" disabled>Fund with Cashu</button><button id="cashu-replay" disabled>Replay Cashu</button></div><div class="row"><label>NWC amount (sats)<input id="nwc-amount" inputmode="numeric" value="3750"></label><button id="nwc" disabled>Fund with NWC</button></div><p id="funding-status" class="status"></p></section>
  <section aria-labelledby="generation-heading"><h2 id="generation-heading">Generate a napplet</h2><p>Source, model charge, worker build, verification, and preview are signed ContextVM projections.</p><label>Focused idea<input id="idea" maxlength="512" value="A counter for a short focused task"></label><div class="row"><label>Maximum (sats)<input id="maximum" inputmode="numeric" value="${bootstrap.actionCeilingSat}"></label><button id="generate" disabled>Generate napplet</button></div><p id="generation-status" class="status"></p><dl id="generation-facts"></dl><iframe id="preview" title="Verified napplet preview" hidden></iframe><p id="publication-status">Publication is unavailable in this development surface.</p></section>`;

const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const connectedControls = [byId<HTMLButtonElement>("cashu"), byId<HTMLButtonElement>("cashu-replay"), byId<HTMLButtonElement>("nwc"), byId<HTMLButtonElement>("generate")];
function setStatus(value: string): void { byId("funding-status").textContent = value; }
function setBalance(value: string): void { balance = value; byId("balance").textContent = `${balance} sats`; }
function facts(values: Record<string, unknown>): void { byId("generation-facts").innerHTML = Object.entries(values).map(([key, value]) => `<dt>${key}</dt><dd>${String(value)}</dd>`).join(""); }
async function refresh(): Promise<void> { if (client) setBalance((await client.accountStatus()).available); }

byId<HTMLButtonElement>("connect").onclick = async () => {
  const button = byId<HTMLButtonElement>("connect"); button.disabled = true;
  try { client = new DevelopmentContextVmClient(bootstrap); const connected = await client.connect(); byId("connection-status").textContent = `Connected: ${connected.pubkey}`; setBalance(connected.account.available); connectedControls.forEach((control) => control.disabled = false); }
  catch { byId("connection-status").textContent = "Connection failed; retry Connect"; button.disabled = false; }
};
byId<HTMLButtonElement>("cashu").onclick = async () => {
  try {
    setStatus("Cashu payment pending");
    const payment = await client!.fundCashu(byId<HTMLInputElement>("cashu-amount").value);
    await refresh();
    setStatus(payment?.state === "credited" ? "Cashu credited" : "Cashu credit unconfirmed; check account status before retrying");
  } catch { setStatus("Cashu credit unconfirmed; check account status before retrying"); }
};
byId<HTMLButtonElement>("cashu-replay").onclick = async () => {
  try {
    const payment = await client!.replayCashu();
    await refresh();
    setStatus(payment?.state === "credited" ? "Cashu replay credited once" : "Cashu replay unconfirmed; check account status");
  } catch { setStatus("Cashu replay unconfirmed; check account status"); }
};
byId<HTMLButtonElement>("nwc").onclick = async () => {
  try {
    setStatus("NWC settlement pending");
    const payment = await client!.fundNwc(byId<HTMLInputElement>("nwc-amount").value);
    if (typeof payment?.topUpId !== "string") throw new Error("NWC_TOP_UP_ID_MISSING");
    const topUpId = payment.topUpId;
    setStatus(`NWC settlement pending (${topUpId})`);
    let credited = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const account = await client!.accountStatus();
      setBalance(account.available);
      const topUp = account.topUps?.find((item: any) => item.topUpId === topUpId);
      if (topUp?.state === "credited") { credited = true; break; }
      if (topUp?.state === "failed") throw new Error("NWC_TOP_UP_FAILED");
    }
    setStatus(credited ? "NWC credited" : "NWC settlement unconfirmed; check account status before retrying");
  } catch { setStatus("NWC settlement unconfirmed; check account status before retrying"); }
};
byId<HTMLButtonElement>("generate").onclick = async () => {
  const button = byId<HTMLButtonElement>("generate"); button.disabled = true;
  try {
    const maximum = byId<HTMLInputElement>("maximum").value;
    const idea = byId<HTMLInputElement>("idea").value.trim();
    if (!idea) throw new Error("IDEA_REQUIRED");
    byId("generation-status").textContent = "Reserving ready isolated capacity";
    const admission = await client!.fundAdmission(maximum);
    if (admission?.status !== "accepted") throw new Error("ADMISSION_NOT_ACCEPTED");
    byId("generation-status").textContent = "Creating metered proposal and isolated build";
    const action = await client!.startSession({ admissionReference: admission.admissionReference, maximum, idea });
    if (action?.status !== "completed" || !action.artifactId) throw new Error(action?.code ?? "GENERATION_NOT_COMPLETED");
    byId("generation-status").textContent = "Authorizing read-only preview";
    const descriptor = await client!.preview({ sessionId: action.sessionId, artifactId: action.artifactId });
    if (descriptor?.status !== "ready" || typeof descriptor.previewUrl !== "string") throw new Error("PREVIEW_NOT_READY");
    const preview = byId<HTMLIFrameElement>("preview"); preview.src = descriptor.previewUrl; preview.hidden = false;
    facts({ model: "durable proposal", source: "Plan 53 stored source", worker: "pinned isolated Docker", stage: "verified", version: action.artifactVersion, artifact: action.artifactId, aggregate: descriptor.aggregateSha256, charge: action.confirmedSpend, remainingMaximum: action.remainingCap, grantExpiresAt: descriptor.expiresAtMs });
    byId("generation-status").textContent = "Verified preview ready";
    await refresh();
  } catch (error) { byId("generation-status").textContent = `Generation unavailable: ${error instanceof Error ? error.message : "unknown"}`; }
  finally { button.disabled = !client; }
};
