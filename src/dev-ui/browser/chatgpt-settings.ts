import type { DevelopmentBootstrap } from "./contextvm-client";

type Account = { id: string; label: string; signedIn: boolean; planEnabled: boolean; welcomed: boolean };
type Status = { settings: { mode: "default" | "chatgpt"; accountId?: string; model?: string }; accounts: Account[]; notice?: string; diagnostic?: string };
const explanations: Record<string, string> = {
  CHATGPT_SIGN_IN_DECLINED: "Sign-in was cancelled. You can continue with the local fixture or sign in again.",
  CHATGPT_SIGN_IN_STATE_INVALID: "This sign-in expired or belongs to a different browser. Start sign-in again.",
  CHATGPT_PLAN_PERMISSION_REQUIRED: "Enable ChatGPT plan usage by signing in again and granting that permission.",
  CHATGPT_SIGN_IN_REQUIRED: "Sign in to ChatGPT before generating.",
  CHATGPT_REAUTHORIZE_REQUIRED: "Your ChatGPT session needs a new sign-in.",
  CHATGPT_REMOTE_REVOCATION_UNCONFIRMED: "Signed out locally. Remote disconnection could not be confirmed; disconnect this app in ChatGPT settings.",
  CHATGPT_USAGE_LIMIT_REACHED: "ChatGPT plan or app usage limit reached. Open Manage usage to review it.",
  CHATGPT_USAGE_UNAVAILABLE: "ChatGPT usage availability could not be checked. Try a new action later.",
  CHATGPT_PLAN_ACCESS_DENIED: "Your account or workspace did not allow this request. Check ChatGPT plan access.",
  CHATGPT_STREAM_INTERRUPTED: "The model connection ended before completion. This action will not be sent again automatically.",
  CHATGPT_STREAM_FAILED: "The model did not complete. This action will not be sent again automatically.",
  CHATGPT_INFERENCE_UNAVAILABLE: "ChatGPT inference is unavailable. The original action will not be retried automatically.",
  CHATGPT_SOURCE_INVALID: "ChatGPT returned an invalid source proposal. Its reported usage was recorded; try a new focused request.",
  CHATGPT_GENERATION_BUSY: "Wait for the current generation to finish before changing model settings.",
  CHATGPT_MODELS_UNAVAILABLE: "The account's model list is unavailable. Try loading models again.",
};
let refreshDiagnostic: (() => Promise<void>) | undefined;
export async function showChatGptDiagnostic(): Promise<void> { await refreshDiagnostic?.(); }

export async function mountChatGptSettings(bootstrap: DevelopmentBootstrap): Promise<void> {
  if (!bootstrap.modelControlToken) return;
  const panel = document.createElement("section"); panel.setAttribute("aria-labelledby", "chatgpt-heading");
  panel.innerHTML = `<h2 id="chatgpt-heading">Generation model</h2>
    <p id="chatgpt-active" class="supporting"></p>
    <p class="supporting">Use your ChatGPT plan for real generation. Cashu/NWC balances and charges here are local test sats, separate from your ChatGPT plan or credits.</p>
    <label for="chatgpt-account">ChatGPT account</label><select id="chatgpt-account"><option value="">Add a ChatGPT account</option></select>
    <div class="row"><button id="chatgpt-sign-in">Continue with ChatGPT</button><button id="chatgpt-sign-out" disabled>Sign out of ChatGPT</button></div>
    <label for="chatgpt-model">ChatGPT model</label><select id="chatgpt-model" disabled><option value="">Sign in to load available models</option></select>
    <div class="row"><button id="chatgpt-models" disabled>Reload models</button><button id="chatgpt-use" disabled>Use ChatGPT plan</button><button id="chatgpt-default">Use default provider</button></div>
    <p id="chatgpt-status" class="status" role="status" aria-live="polite"></p>
    <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a>
    <p class="supporting">The maximum below caps test charges. ChatGPT plan usage is controlled in Manage usage; this preview API cannot enforce a per-request output-token cap. Model/account changes apply to new actions. Resume a saved action with its original model and account.</p>
    <dialog id="chatgpt-welcome" aria-labelledby="chatgpt-welcome-title"><h2 id="chatgpt-welcome-title">You're using your ChatGPT plan</h2><p>Eligible generation requests use your ChatGPT plan or credits. Manage access and limits in ChatGPT settings. Local test sats are separate.</p><button id="chatgpt-got-it">Got it</button></dialog>`;
  document.querySelector(".workspace-controls")!.prepend(panel);
  const element = <T extends HTMLElement>(id: string) => panel.querySelector<T>(`#${id}`)!;
  const accountSelect = element<HTMLSelectElement>("chatgpt-account"); const modelSelect = element<HTMLSelectElement>("chatgpt-model");
  let status: Status;
  const message = (text: string) => { element("chatgpt-status").textContent = text; };
  const errorMessage = (code: string) => explanations[code] ?? `ChatGPT setup could not complete (${code}). Try again from Continue with ChatGPT.`;
  const control = async (path: string, body?: unknown) => {
    const response = await fetch(`/dev/chatgpt/${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store", headers: { "x-dev-model-token": bootstrap.modelControlToken!, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.code ?? "CHATGPT_REQUEST_FAILED"); return result;
  };
  const report = (error: unknown) => message(errorMessage(error instanceof Error ? error.message : "CHATGPT_REQUEST_FAILED"));
  const refresh = async () => {
    status = await control("status");
    const previous = accountSelect.value || new URL(location.href).searchParams.get("chatgpt_account") || status.settings.accountId;
    accountSelect.replaceChildren(new Option("Add a ChatGPT account", ""), ...status.accounts.map((account) => new Option(`${account.label} · ${account.id.slice(0, 6)}${account.signedIn ? "" : " · signed out"}`, account.id)));
    if (previous && status.accounts.some((account) => account.id === previous)) accountSelect.value = previous;
    else if (status.accounts.length) accountSelect.value = status.accounts.at(-1)!.id;
    element("chatgpt-active").textContent = status.settings.mode === "chatgpt" ? `Using ChatGPT plan · ${status.settings.model}` : `Active: ${bootstrap.providerLabel}`;
    element<HTMLButtonElement>("chatgpt-default").textContent = bootstrap.providerLabel === "Configured OpenAI Responses" ? "Use configured API provider" : "Use default provider";
    const account = status.accounts.find((item) => item.id === accountSelect.value);
    element<HTMLButtonElement>("chatgpt-sign-out").disabled = !account?.signedIn;
    element<HTMLButtonElement>("chatgpt-models").disabled = !account?.signedIn || !account.planEnabled;
    if (status.notice) message(errorMessage(status.notice));
  };
  const loadModels = async () => {
    const account = status.accounts.find((item) => item.id === accountSelect.value);
    modelSelect.replaceChildren(new Option("Sign in to load available models", "")); modelSelect.disabled = true; element<HTMLButtonElement>("chatgpt-use").disabled = true;
    element<HTMLButtonElement>("chatgpt-sign-out").disabled = !account?.signedIn;
    element<HTMLButtonElement>("chatgpt-models").disabled = !account?.signedIn || !account.planEnabled;
    if (!account?.signedIn || !account.planEnabled) return;
    const accountId = account.id;
    message("Loading models from your ChatGPT account…");
    const result = await control("models", { accountId });
    if (accountSelect.value !== accountId) return;
    modelSelect.replaceChildren(...result.models.map((model: { slug: string; displayName: string }) => new Option(model.displayName, model.slug)));
    if (status.settings.accountId === accountId && result.models.some((model: any) => model.slug === status.settings.model)) modelSelect.value = status.settings.model!;
    modelSelect.disabled = result.models.length === 0; element<HTMLButtonElement>("chatgpt-use").disabled = result.models.length === 0;
    message(result.models.length ? "Choose a model, then Use ChatGPT plan. Model availability is confirmed when a request succeeds." : "No models are available for this account.");
    if (!account.welcomed) element<HTMLDialogElement>("chatgpt-welcome").showModal();
  };
  accountSelect.onchange = () => { void loadModels().catch(report); };
  element<HTMLButtonElement>("chatgpt-models").onclick = () => { void loadModels().catch(report); };
  element<HTMLButtonElement>("chatgpt-sign-in").onclick = async () => {
    try { const result = await control("sign-in", accountSelect.value ? { accountId: accountSelect.value } : {}); const url = new URL(result.url); if (url.origin !== "https://auth.openai.com") throw new Error("CHATGPT_SIGN_IN_URL_INVALID"); location.assign(url.href); } catch (error) { report(error); }
  };
  element<HTMLButtonElement>("chatgpt-use").onclick = async () => { try { await control("select", { mode: "chatgpt", accountId: accountSelect.value, model: modelSelect.value }); location.replace("/"); } catch (error) { report(error); } };
  element<HTMLButtonElement>("chatgpt-default").onclick = async () => { try { await control("select", { mode: "default" }); location.replace("/"); } catch (error) { report(error); } };
  element<HTMLButtonElement>("chatgpt-sign-out").onclick = async () => { try { const result = await control("logout", { accountId: accountSelect.value }); await refresh(); await loadModels(); message(result.revoked ? "Signed out of ChatGPT. Use the default provider or sign in again." : explanations.CHATGPT_REMOTE_REVOCATION_UNCONFIRMED!); } catch (error) { report(error); } };
  const welcome = element<HTMLDialogElement>("chatgpt-welcome");
  element<HTMLButtonElement>("chatgpt-got-it").onclick = async () => { try { await control("welcome", { accountId: accountSelect.value }); welcome.close(); } catch (error) { report(error); } };
  refreshDiagnostic = async () => { try { const current: Status = await control("status"); if (current.diagnostic || current.notice) message(errorMessage(current.diagnostic ?? current.notice!)); } catch { /* Keep generation's own error visible. */ } };
  try { await refresh(); await loadModels(); const error = new URL(location.href).searchParams.get("chatgpt_error"); if (error) message(errorMessage(error)); history.replaceState(null, "", "/"); } catch (error) { report(error); }
}
