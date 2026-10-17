import { ratesMarkup, mountAdminRates } from "./admin-rates";
import { jobsMarkup, mountAdminJobs } from "./admin-jobs";
import { DevelopmentContextVmClient, type DevelopmentBootstrap } from "./contextvm-client";
import { mountChatGptSettings } from "./chatgpt-settings";
import type { ExchangeRate } from "../../currency/btc-usd";
import { profitMarkup, mountAdminProfit } from "./admin-profit";

const connection = await (await fetch("./cvm.json")).json();
const bootstrap: DevelopmentBootstrap = { relayUrl: connection.relayUrl, servicePubkey: connection.servicePubkey, reserveSat: "0", actionCeilingSat: "0", providerLabel: "CVM default provider" };
const storageKey = `napplet-cvm/operator/v1/${bootstrap.servicePubkey}`;
const keyFromLink = new URLSearchParams(location.hash.slice(1)).get("key");
if (keyFromLink && /^[a-f0-9]{64}$/.test(keyFromLink)) sessionStorage.setItem(storageKey, keyFromLink);
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
document.querySelector("#app")!.innerHTML = `<header class="brand-header"><div><a class="admin-home" href="/">applet.broker</a><h1>CVM admin</h1></div><nav aria-label="Admin navigation"><a href="#jobs-heading">Jobs</a><a id="provider-navigation" href="#provider-settings">Provider & rates</a><button id="admin-lock" hidden>Lock admin</button></nav></header>
<p class="supporting">Private operator workspace · encrypted ContextVM</p><p id="operator-provider"></p><p id="admin-status" role="status"></p>
<form id="admin-login"><label for="operator-key">Operator access key</label><input id="operator-key" type="password" autocomplete="off" required><button class="primary">Connect to CVM</button><p>Open with <code>bun scripts/open-dev-admin.ts</code> on the CVM host, or enter its private operator access key.</p></form>
<div id="admin-content" hidden>${jobsMarkup}<details id="provider-settings"><summary>Provider & rates</summary><div class="admin-grid"><section class="workspace-controls"></section><section>${ratesMarkup}${profitMarkup}
<h2>API accounts</h2><ul id="api-accounts"></ul><details><summary>Add an API account</summary><form id="api-form"><label for="api-label">Label</label><input id="api-label" maxlength="80" required><label for="api-key">API key</label><input id="api-key" type="password" autocomplete="off" required><label for="api-config">Provider configuration (JSON)</label><textarea id="api-config" rows="8" required placeholder='{"model":"gpt-5-mini","profile":{},"priceCard":{},"priceSources":{}}'></textarea><p class="supporting">Use the pinned OpenAI Responses configuration documented in docs/runbooks/development-gui.md. Price cards require source evidence. Secrets are write-only and stored privately on the CVM.</p><button>Add account</button></form></details></section></div>
</details></div>
<dialog id="job-detail"><div class="dialog-header"><h2>Job details</h2><button id="job-close" aria-label="Close job details">×</button></div><div id="job-facts"></div></dialog>`;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settingsPanel = el<HTMLDetailsElement>("provider-settings");
settingsPanel.open = sessionStorage.getItem(storageKey + "/settings") === "open";
settingsPanel.ontoggle = () => { if (settingsPanel.open) sessionStorage.setItem(storageKey + "/settings", "open"); else sessionStorage.removeItem(storageKey + "/settings"); };
let client: DevelopmentContextVmClient | undefined;
let status: any;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let exchangeTimer: ReturnType<typeof setInterval> | undefined;
let exchangeRate: ExchangeRate = { status: "unavailable" };
let ratesView: ReturnType<typeof mountAdminRates> | undefined;
let profitView: ReturnType<typeof mountAdminProfit> | undefined;
const message = (value: string) => { el("admin-status").textContent = value; };
async function command(args: unknown) {
  const result = await client!.callTool("cvm_admin", args);
  if (result?.status === "denied" || result?.status === "rejected") throw new Error(result.code);
  return result;
}
const report = (error: unknown) => message(error instanceof Error ? error.message : "CVM admin unavailable");
async function refreshConfig() {
  status = await command({ action: "status" });
  el("operator-provider").textContent = `Active provider: ${status.pricing.profile.provider} · ${status.pricing.profile.model}`;
  Object.assign(bootstrap, { providerLabel: status.selectedApi ? "Configured OpenAI Responses" : status.pricing.profile.provider === "deterministic_fixture" ? "Deterministic fixture" : "ChatGPT subscription" });
  ratesView = mountAdminRates(status.pricing, async rates => {
    await command({ action: "save_rates", rates });
    status = await command({ action: "status" });
    message("New rates saved. Existing jobs retain their price versions.");
    return status.pricing;
  }, exchangeRate);
  profitView = mountAdminProfit(status.pricing, status.profit, async setting => {
    await command({ action: "save_profit", setting }); await refreshConfig();
    message("Profit margin saved for new requests.");
  }, exchangeRate);
  el("api-accounts").replaceChildren(...status.apiAccounts.map((account: any) => {
    const item = document.createElement("li"); const name = document.createElement("span"); name.textContent = `${account.label} · ${account.model} · key configured${status.selectedApi === account.id ? " · active" : ""}`; item.append(name);
    for (const action of ["select_api", "remove_api"]) { const button = document.createElement("button"); button.textContent = action === "select_api" ? "Use account" : "Remove"; button.disabled = status.selectedApi === account.id; button.onclick = () => void command({ action, id: account.id }).then(() => action === "select_api" ? location.reload() : refreshConfig()).catch(report); item.append(button); }
    return item;
  }));
}
const jobs = mountAdminJobs(command);
async function refreshExchangeRate() {
  try { exchangeRate = (await command({ action: "exchange_rate" })).exchangeRate ?? { status: "unavailable" }; }
  catch { exchangeRate = exchangeRate.quote ? { ...exchangeRate, status: "stale" } : { status: "unavailable" }; }
  ratesView?.setExchangeRate(exchangeRate); profitView?.setExchangeRate(exchangeRate); jobs.setExchangeRate(exchangeRate);
}
async function connect(key: string) {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Enter the operator’s 64-character access key.");
  await client?.close(); client = new DevelopmentContextVmClient(bootstrap, undefined, key); await client.connect({ accountStatus: false });
  await refreshConfig(); sessionStorage.setItem(storageKey, key); el<HTMLInputElement>("operator-key").value = "";
  el("admin-login").hidden = true; el("admin-content").hidden = false; el("admin-lock").hidden = false; message("Connected as CVM operator.");
  await mountChatGptSettings(bootstrap, async (operation, body) => command({ action: "chatgpt", operation, ...(body === undefined ? {} : { body }) }), () => { if (status.selectedApi) el("chatgpt-active").textContent = "Saved ChatGPT selection · API account is currently active"; });
  await jobs.refresh(); clearInterval(refreshTimer); refreshTimer = setInterval(() => { void jobs.refresh(); }, 5000);
  void refreshExchangeRate(); clearInterval(exchangeTimer); exchangeTimer = setInterval(() => { if (!document.hidden) void refreshExchangeRate(); }, 60_000);
}
el<HTMLFormElement>("admin-login").onsubmit = event => { event.preventDefault(); void connect(el<HTMLInputElement>("operator-key").value.trim()).catch(report); };
el("admin-lock").onclick = () => { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(storageKey + "/settings"); clearInterval(refreshTimer); clearInterval(exchangeTimer); void client?.close(); location.reload(); };
el<HTMLFormElement>("api-form").onsubmit = event => { event.preventDefault(); void (async () => { const configuration = JSON.parse(el<HTMLTextAreaElement>("api-config").value); await command({ action: "add_api", account: { ...configuration, id: crypto.randomUUID(), label: el<HTMLInputElement>("api-label").value, apiKey: el<HTMLInputElement>("api-key").value } }); el<HTMLInputElement>("api-key").value = ""; await refreshConfig(); message("API account saved privately on the CVM."); })().catch(report); };
el("provider-navigation").onclick = () => { el<HTMLDetailsElement>("provider-settings").open = true; };
const saved = sessionStorage.getItem(storageKey); if (saved) void connect(saved).catch(report);
