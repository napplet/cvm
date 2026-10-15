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
  <section aria-labelledby="funds-heading"><h2 id="funds-heading">Funds and limits</h2><p id="balance">0 sats</p><p>Current maximum reserve: <strong>${bootstrap.reserveSat} sats</strong>. Action ceiling: <strong>${bootstrap.actionCeilingSat} sats</strong>.</p><div class="row"><label>Cashu amount (sats)<input id="cashu-amount" inputmode="numeric" value="64"></label><button id="cashu" disabled>Fund with Cashu</button><button id="cashu-replay" disabled>Replay Cashu</button></div><div class="row"><label>NWC amount (sats)<input id="nwc-amount" inputmode="numeric" value="3750"></label><button id="nwc" disabled>Fund with NWC</button></div><p id="funding-status" class="status"></p></section>`;

const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const connectedControls = [byId<HTMLButtonElement>("cashu"), byId<HTMLButtonElement>("cashu-replay"), byId<HTMLButtonElement>("nwc")];
function setStatus(value: string): void { byId("funding-status").textContent = value; }
function setBalance(value: string): void { balance = value; byId("balance").textContent = `${balance} sats`; }
async function refresh(): Promise<void> { if (client) setBalance((await client.accountStatus()).available); }

byId<HTMLButtonElement>("connect").onclick = async () => {
  const button = byId<HTMLButtonElement>("connect"); button.disabled = true;
  try { client = new DevelopmentContextVmClient(bootstrap); const connected = await client.connect(); byId("connection-status").textContent = `Connected: ${connected.pubkey}`; setBalance(connected.account.available); connectedControls.forEach((control) => control.disabled = false); }
  catch { byId("connection-status").textContent = "Connection failed; retry Connect"; button.disabled = false; }
};
byId<HTMLButtonElement>("cashu").onclick = async () => { try { setStatus("Cashu payment pending"); await client!.fundCashu(byId<HTMLInputElement>("cashu-amount").value); await refresh(); setStatus("Cashu credited"); } catch { setStatus("Cashu funding failed; balance unchanged"); } };
byId<HTMLButtonElement>("cashu-replay").onclick = async () => { try { await client!.replayCashu(); await refresh(); setStatus("Cashu replay credited once"); } catch { setStatus("Cashu replay failed; balance unchanged"); } };
byId<HTMLButtonElement>("nwc").onclick = async () => { try { setStatus("NWC settlement pending"); const before = BigInt(balance); const payment = await client!.fundNwc(byId<HTMLInputElement>("nwc-amount").value); const topUpId = typeof payment?.topUpId === "string" ? payment.topUpId : "pending"; setStatus(`NWC settlement pending (${topUpId})`); for (let attempt = 0; attempt < 120; attempt++) { await new Promise((resolve) => setTimeout(resolve, 500)); const account = await client!.accountStatus(); setBalance(account.available); const pending = account.topUps?.find((topUp: any) => topUp.topUpId === topUpId); if (pending?.state === "credited" && BigInt(balance) > before) break; } if (BigInt(balance) <= before) throw new Error("NWC_SETTLEMENT_TIMEOUT"); setStatus("NWC credited"); } catch { setStatus("NWC funding failed; balance unchanged"); } };
