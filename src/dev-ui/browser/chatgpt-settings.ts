import type { DevelopmentBootstrap } from "./contextvm-client";

type Account = { id: string; label: string; signedIn: boolean; planEnabled: boolean; welcomed: boolean };
type Status = { settings: { mode: "default" | "chatgpt"; accountId?: string; model?: string }; accounts: Account[]; notice?: string; diagnostic?: string };
import { explanations, chatGptErrorMessage } from "./chatgpt-errors";
export { chatGptErrorMessage } from "./chatgpt-errors";
let refreshDiagnostic: (() => Promise<string | undefined>) | undefined;
export async function showChatGptDiagnostic(): Promise<string | undefined> { return refreshDiagnostic?.(); }

export async function mountChatGptSettings(bootstrap: DevelopmentBootstrap, control: (operation: string, body?: unknown) => Promise<any>, onStatus?: (summary: string) => void): Promise<void> {
  const panel = document.createElement("section"); panel.setAttribute("aria-labelledby", "chatgpt-heading");
  panel.innerHTML = `<h2 id="chatgpt-heading">Generation model</h2>
    <p id="chatgpt-active" class="supporting"></p>
    <p class="supporting">Your ChatGPT subscription powers model requests. Cashu/NWC amounts are local test sats for exercising this app's payments.</p>
    <label for="chatgpt-account">ChatGPT account</label><select id="chatgpt-account"><option value="">Add a ChatGPT account</option></select>
    <div class="row"><button id="chatgpt-sign-in">Continue with ChatGPT</button><button id="chatgpt-sign-out" disabled>Sign out of ChatGPT</button></div>
    <label for="chatgpt-model">ChatGPT model</label><select id="chatgpt-model" disabled><option value="">Sign in to load available models</option></select>
    <div class="row"><button id="chatgpt-models" disabled>Reload models</button><button id="chatgpt-default">Use default provider</button></div>
    <p id="chatgpt-status" class="status" role="status" aria-live="polite"></p>
    <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage subscription usage</a>
    <p class="supporting">In ChatGPT, open Settings → Usage → App limits and find napplet-cvm development. Use the same ChatGPT account and workspace you authorized here. If the link shows only API credit billing, open ChatGPT's settings from its account menu instead.</p>
    <p class="supporting">The maximum below caps local test charges. Subscription allowance and app limits are managed in ChatGPT; this app cannot set a per-request output-token cap. Model/account changes apply to new actions. Resume a saved action with its original model and account.</p>
    <dialog id="chatgpt-welcome" aria-labelledby="chatgpt-welcome-title"><h2 id="chatgpt-welcome-title">You're using your ChatGPT plan</h2><p>Eligible generation requests use your ChatGPT subscription allowance. Manage this app's access and limits in ChatGPT settings. Local test sats exercise the payment flow.</p><button id="chatgpt-got-it">Got it</button></dialog>`;
  document.querySelector(".workspace-controls")!.prepend(panel);
  document.body.append(panel.querySelector("#chatgpt-welcome")!);
  const element = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
  const accountSelect = element<HTMLSelectElement>("chatgpt-account"); const modelSelect = element<HTMLSelectElement>("chatgpt-model");
  let status: Status;
  const message = (text: string) => { element("chatgpt-status").textContent = text; };
  const errorMessage = chatGptErrorMessage;
  const report = (error: unknown) => message(errorMessage(error instanceof Error ? error.message : "CHATGPT_REQUEST_FAILED"));
  const refresh = async () => {
    status = await control("status");
    const previous = accountSelect.value || new URL(location.href).searchParams.get("chatgpt_account") || status.settings.accountId;
    accountSelect.replaceChildren(new Option("Add a ChatGPT account", ""), ...status.accounts.map((account) => new Option(`${account.label} · ${account.id.slice(0, 6)}${account.signedIn ? "" : " · signed out"}`, account.id)));
    if (previous && status.accounts.some((account) => account.id === previous)) accountSelect.value = previous;
    else if (status.accounts.length) accountSelect.value = status.accounts.at(-1)!.id;
    const selectedAccount = status.accounts.find((item) => item.id === status.settings.accountId);
    element("chatgpt-active").textContent = status.settings.mode === "chatgpt" ? selectedAccount?.signedIn ? `Using ChatGPT plan · ${status.settings.model}` : "ChatGPT selected · sign in to generate" : `Active: ${bootstrap.providerLabel}`;
    onStatus?.(element("chatgpt-active").textContent ?? bootstrap.providerLabel);
    element<HTMLButtonElement>("chatgpt-default").textContent = bootstrap.providerLabel === "Configured OpenAI Responses" ? "Use configured API provider" : "Use default provider";
    const account = status.accounts.find((item) => item.id === accountSelect.value);
    element<HTMLButtonElement>("chatgpt-sign-out").disabled = !account?.signedIn;
    element<HTMLButtonElement>("chatgpt-models").disabled = !account?.signedIn || !account.planEnabled;
    if (status.notice) message(errorMessage(status.notice));
  };
  const activate = async () => {
    if (!modelSelect.value) return;
    modelSelect.disabled = true; accountSelect.disabled = true;
    message("Activating ChatGPT model…");
    try {
      await control("select", { mode: "chatgpt", accountId: accountSelect.value, model: modelSelect.value });
      location.reload();
    } catch (error) {
      await refresh();
      if (status.settings.accountId === accountSelect.value || status.settings.mode === "default") {
        modelSelect.value = status.settings.mode === "chatgpt" ? status.settings.model ?? "" : "";
        modelSelect.disabled = modelSelect.options.length < 2;
      } else {
        accountSelect.value = status.settings.accountId ?? "";
        await loadModels();
      }
      report(error);
    } finally { accountSelect.disabled = false; }
  };
  const loadModels = async (activateAccount = false) => {
    const account = status.accounts.find((item) => item.id === accountSelect.value);
    modelSelect.replaceChildren(new Option("Sign in to load available models", "")); modelSelect.disabled = true;
    element<HTMLButtonElement>("chatgpt-sign-out").disabled = !account?.signedIn;
    element<HTMLButtonElement>("chatgpt-models").disabled = !account?.signedIn || !account.planEnabled;
    if (!account?.signedIn || !account.planEnabled) return;
    const accountId = account.id;
    message("Loading models from your ChatGPT account…");
    const result = await control("models", { accountId });
    if (accountSelect.value !== accountId) return;
    modelSelect.replaceChildren(new Option("Choose a ChatGPT model", ""), ...result.models.map((model: { slug: string; displayName: string }) => new Option(model.displayName, model.slug)));
    if ((activateAccount || status.settings.mode === "chatgpt") && result.models.some((model: { slug: string }) => model.slug === status.settings.model)) modelSelect.value = status.settings.model!;
    if (activateAccount && !modelSelect.value && result.models.length) modelSelect.value = result.models[0].slug;
    modelSelect.disabled = result.models.length === 0;
    if (activateAccount && modelSelect.value) { await activate(); return; }
    message(result.models.length ? "Model changes apply automatically and are saved for your next visit." : "No models are available for this account.");
    if (!account.welcomed && status.settings.mode === "chatgpt" && status.settings.accountId === accountId) element<HTMLDialogElement>("chatgpt-welcome").showModal();
  };
  accountSelect.onchange = () => { void loadModels(true).catch(report); };
  modelSelect.onchange = () => { void activate().catch(report); };
  element<HTMLButtonElement>("chatgpt-models").onclick = () => { void loadModels().catch(report); };
  element<HTMLButtonElement>("chatgpt-sign-in").onclick = async () => {
    try { const result = await control("sign-in", accountSelect.value ? { accountId: accountSelect.value } : {}); const url = new URL(result.url); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/admin/oauth/start") throw new Error("CHATGPT_SIGN_IN_URL_INVALID"); location.assign(url.href); } catch (error) { report(error); }
  };
  element<HTMLButtonElement>("chatgpt-default").onclick = async () => { try { await control("select", { mode: "default" }); location.reload(); } catch (error) { report(error); } };
  element<HTMLButtonElement>("chatgpt-sign-out").onclick = async () => { try { const result = await control("logout", { accountId: accountSelect.value }); await refresh(); await loadModels(); message(result.revoked ? "Signed out of ChatGPT. Use the default provider or sign in again." : explanations.CHATGPT_REMOTE_REVOCATION_UNCONFIRMED!); } catch (error) { report(error); } };
  const welcome = element<HTMLDialogElement>("chatgpt-welcome");
  element<HTMLButtonElement>("chatgpt-got-it").onclick = async () => { try { await control("welcome", { accountId: accountSelect.value }); welcome.close(); } catch (error) { report(error); } };
  refreshDiagnostic = async () => { try { const current: Status = await control("status"); const selected = current.accounts.find((item) => item.id === current.settings.accountId); const code = current.settings.mode === "chatgpt" && !selected?.signedIn ? "CHATGPT_SIGN_IN_REQUIRED" : current.diagnostic ?? current.notice; if (code) { const explanation = errorMessage(code); message(explanation); return explanation; } } catch { /* Keep generation's own error visible. */ } };
  try { await refresh(); await loadModels(); const error = new URL(location.href).searchParams.get("chatgpt_error"); if (error) message(errorMessage(error)); history.replaceState(null, "", location.pathname); } catch (error) { report(error); }
}
