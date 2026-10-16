import { DevelopmentContextVmClient, type DevelopmentBootstrap } from "./contextvm-client";
import { mountChatGptSettings } from "./chatgpt-settings";

const connection = await (await fetch("./cvm.json")).json();
const bootstrap: DevelopmentBootstrap = { relayUrl: connection.relayUrl, servicePubkey: connection.servicePubkey, reserveSat: "0", actionCeilingSat: "0", providerLabel: "CVM default provider" };
const storageKey = `napplet-cvm/operator/v1/${bootstrap.servicePubkey}`;
const keyFromLink = new URLSearchParams(location.hash.slice(1)).get("key");
if (keyFromLink && /^[a-f0-9]{64}$/.test(keyFromLink)) sessionStorage.setItem(storageKey, keyFromLink);
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
document.querySelector("#app")!.innerHTML = `<header class="brand-header"><h1>CVM admin</h1><button id="admin-lock" hidden>Lock admin</button></header>
<p>Private operator controls · encrypted ContextVM</p><p id="operator-provider"></p><p id="admin-status" role="status"></p>
<form id="admin-login"><label for="operator-key">Operator access key</label><input id="operator-key" type="password" autocomplete="off" required><button class="primary">Connect to CVM</button><p>Open with <code>bun scripts/open-dev-admin.ts</code> on the CVM host, or enter its private operator access key.</p></form>
<div id="admin-content" hidden><div class="admin-grid"><section class="workspace-controls"></section><section><h2>Rates</h2><p>Integer sats per token, expressed as numerator / denominator. Saves a new price version for new work. Existing jobs retain their original rates.</p><form id="rates-form"><div id="rate-fields"></div><button>Save rates</button></form><p id="price-version" class="supporting"></p>
<h2>API accounts</h2><ul id="api-accounts"></ul><details><summary>Add an API account</summary><form id="api-form"><label for="api-label">Label</label><input id="api-label" maxlength="80" required><label for="api-key">API key</label><input id="api-key" type="password" autocomplete="off" required><label for="api-config">Provider configuration (JSON)</label><textarea id="api-config" rows="8" required placeholder='{"model":"gpt-5-mini","profile":{},"priceCard":{},"priceSources":{}}'></textarea><p class="supporting">Use the pinned OpenAI Responses configuration documented in docs/runbooks/development-gui.md. Price cards require source evidence. Secrets are write-only and stored privately on the CVM.</p><button>Add account</button></form></details></section></div>
<section class="admin-jobs"><h2>Jobs</h2><p class="supporting">Pending includes saved requests awaiting funds. Unconfirmed outcomes remain active until reconciled; they are not silently retried.</p><div class="job-tabs" role="group" aria-label="Job state"><button data-state="pending">Pending</button><button data-state="active" aria-pressed="true">Active</button><button data-state="finished">Finished</button><button id="jobs-refresh">Refresh</button></div><table><thead><tr><th>Job</th><th>State</th><th>Recorded</th></tr></thead><tbody id="jobs"></tbody></table><div class="row"><button id="jobs-prev">Previous</button><button id="jobs-next">Next</button></div></section></div>
<dialog id="job-detail"><div class="dialog-header"><h2>Job details</h2><button id="job-close" aria-label="Close job details">×</button></div><div id="job-facts"></div></dialog>`;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let client: DevelopmentContextVmClient | undefined;
let status: any;
let state = "active"; let offset = 0; let refreshTimer: ReturnType<typeof setInterval> | undefined;
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
  const rates = status.pricing.card.rates;
  el("rate-fields").replaceChildren(...Object.entries(rates).map(([name, rate]: [string, any]) => {
    const row = document.createElement("div"); row.className = "rate-row";
    const label = document.createElement("span"); label.textContent = name.replaceAll("_", " "); row.append(label);
    for (const field of ["numerator", "denominator"]) { const input = document.createElement("input"); input.name = `${name}.${field}`; input.inputMode = "numeric"; input.pattern = "[1-9][0-9]{0,11}"; input.required = true; input.value = rate[field]; input.setAttribute("aria-label", `${name} ${field}`); row.append(input); }
    return row;
  }));
  el("price-version").textContent = `${status.pricing.card.id} · ${status.pricing.card.kind}`;
  el("api-accounts").replaceChildren(...status.apiAccounts.map((account: any) => {
    const item = document.createElement("li"); const name = document.createElement("span"); name.textContent = `${account.label} · ${account.model} · key configured${status.selectedApi === account.id ? " · active" : ""}`; item.append(name);
    for (const action of ["select_api", "remove_api"]) { const button = document.createElement("button"); button.textContent = action === "select_api" ? "Use account" : "Remove"; button.disabled = status.selectedApi === account.id; button.onclick = () => void command({ action, id: account.id }).then(() => action === "select_api" ? location.reload() : refreshConfig()).catch(report); item.append(button); }
    return item;
  }));
}
async function job(id: string, kind: string) {
  const result = await command({ action: "job", id, kind }); const root = el("job-facts"); root.replaceChildren();
  if (!result.job) { root.textContent = "Job not found."; } else {
    const facts = document.createElement("dl");
    for (const [name, value] of Object.entries(result.job)) {
      const label = document.createElement("dt"); label.textContent = name.replaceAll("_", " ");
      const detail = document.createElement("dd"); detail.textContent = value == null ? "—" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value); facts.append(label, detail);
    }
    root.append(facts);
  }
  if (!el<HTMLDialogElement>("job-detail").open) el<HTMLDialogElement>("job-detail").showModal();
}
async function jobs() {
  const selected = state; const page = offset;
  el("jobs").querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
  const result = await command({ action: "jobs", status: selected, offset: page });
  if (state !== selected || offset !== page) return;
  el("jobs").replaceChildren(...result.jobs.map((row: any) => {
    const tr = document.createElement("tr"); const id = document.createElement("td"); const button = document.createElement("button"); button.textContent = row.id; button.onclick = () => void job(row.id, row.kind).catch(report); id.append(button); tr.append(id);
    for (const value of [row.state, new Date(row.created_at).toLocaleString()]) { const td = document.createElement("td"); td.textContent = value; tr.append(td); } return tr;
  }));
  if (!result.jobs.length) { const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 3; td.textContent = `No ${selected} jobs.`; tr.append(td); el("jobs").append(tr); }
  el<HTMLButtonElement>("jobs-prev").disabled = offset === 0; el<HTMLButtonElement>("jobs-next").disabled = result.jobs.length < 50;
}
async function connect(key: string) {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Enter the operator’s 64-character access key.");
  await client?.close(); client = new DevelopmentContextVmClient(bootstrap, undefined, key); await client.connect({ accountStatus: false });
  await refreshConfig(); sessionStorage.setItem(storageKey, key); el<HTMLInputElement>("operator-key").value = "";
  el("admin-login").hidden = true; el("admin-content").hidden = false; el("admin-lock").hidden = false; message("Connected as CVM operator.");
  await mountChatGptSettings(bootstrap, async (operation, body) => command({ action: "chatgpt", operation, ...(body === undefined ? {} : { body }) }), () => { if (status.selectedApi) el("chatgpt-active").textContent = "Saved ChatGPT selection · API account is currently active"; });
  await jobs(); refreshTimer = setInterval(() => { void jobs().catch(report); }, 5000);
}
el<HTMLFormElement>("admin-login").onsubmit = event => { event.preventDefault(); void connect(el<HTMLInputElement>("operator-key").value.trim()).catch(report); };
el("admin-lock").onclick = () => { sessionStorage.removeItem(storageKey); clearInterval(refreshTimer); void client?.close(); location.reload(); };
el<HTMLFormElement>("rates-form").onsubmit = event => { event.preventDefault(); const fields = new FormData(el<HTMLFormElement>("rates-form")); const rates = Object.fromEntries(Object.keys(status.pricing.card.rates).map(name => [name, { numerator: fields.get(`${name}.numerator`), denominator: fields.get(`${name}.denominator`) }])); void command({ action: "save_rates", rates }).then(async () => { await refreshConfig(); message("New rates saved. Existing jobs retain their price versions."); }).catch(report); };
el<HTMLFormElement>("api-form").onsubmit = event => { event.preventDefault(); void (async () => { const configuration = JSON.parse(el<HTMLTextAreaElement>("api-config").value); await command({ action: "add_api", account: { ...configuration, id: crypto.randomUUID(), label: el<HTMLInputElement>("api-label").value, apiKey: el<HTMLInputElement>("api-key").value } }); el<HTMLInputElement>("api-key").value = ""; await refreshConfig(); message("API account saved privately on the CVM."); })().catch(report); };
document.querySelectorAll<HTMLButtonElement>("[data-state]").forEach(button => button.onclick = () => { state = button.dataset.state!; offset = 0; document.querySelectorAll("[data-state]").forEach(item => item.setAttribute("aria-pressed", String(item === button))); void jobs().catch(report); });
el("jobs-refresh").onclick = () => void jobs().catch(report);
el("jobs-prev").onclick = () => { offset = Math.max(0, offset - 50); void jobs().catch(report); };
el("jobs-next").onclick = () => { offset += 50; void jobs().catch(report); };
el("job-close").onclick = () => el<HTMLDialogElement>("job-detail").close();
const saved = sessionStorage.getItem(storageKey); if (saved) void connect(saved).catch(report);
