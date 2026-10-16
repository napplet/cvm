import type { ActivitySnapshot } from "./activity";
import type { DevelopmentBootstrap } from "./contextvm-client";

export type WorkspaceVersion = Readonly<{ sessionId: string; version: number; artifactId: string }>;
type Message = { role: "user" | "assistant"; text: string; version?: number; state?: "failed" | "uncertain" };
type Draft = { idea: string; revision: string; maximum: string; step: number; messages: Message[]; sessionId?: string };
const arrow = '<span aria-hidden="true">↗</span>';
const steps = ["Preparing", "Generating", "Building", "Checking", "Preview"];
const stageIndex: Record<string, number> = { request: 0, admission: 0, model: 1, model_stream: 1, model_recorded: 1, worker: 2, create: 2, init: 2, skills: 2, install: 2, build: 2, verify: 3, conformance: 3, "dry-run": 3, artifact: 3, ledger: 3, preview: 4 };

/** Product presentation only. The shared controller owns every service operation. */
export class ProductWorkspace {
  #key: string;
  #step = 1;
  #hasDraft = false;
  #messages: Message[] = [];
  #sessionId?: string;
  #running = false;
  #connected = false;
  #recovering = false;
  #sessionBlocked = false;
  #selectingVersion = false;
  #progress = 0;
  #lastState = "idle";
  #version?: WorkspaceVersion;
  #revisionRequest = false;
  #outcomeAdded = false;
  #changeVersion?: (version: WorkspaceVersion) => Promise<unknown>;
  constructor(private readonly root: HTMLElement, private readonly bootstrap: DevelopmentBootstrap) {
    this.#key = `applet-broker/workspace/v1/${bootstrap.servicePubkey}`;
    document.title = "applet.broker — Make a little thing";
    root.setAttribute("aria-label", "Applet workspace");
    root.innerHTML = `
      <a class="skip-link" href="#step-heading">Skip to workspace</a>
      <header class="brand-header"><a class="brand" href="/" aria-label="applet.broker home"><span class="brand-mark" aria-hidden="true">a<span>·</span></span>applet<span class="brand-light">.broker</span></a><div class="header-actions"><span class="environment"><i aria-hidden="true"></i>Local development</span><button id="open-settings" class="quiet">Settings</button></div></header>
      <nav class="step-nav" aria-label="Creation steps"><ol><li data-step="1" aria-current="step"><span>01</span> Your idea</li><li data-step="2"><span>02</span> Ready to build</li><li data-step="3"><span>03</span> Make it yours</li></ol><p id="connection-summary" role="status">Connecting…</p></nav>
      <div id="product-progress" hidden><div class="progress-heading"><p id="progress-title" role="status" aria-live="polite">Preparing your workspace</p><div class="progress-meta"><span id="progress-provider"></span><span id="progress-time"></span></div></div><div id="build-progress" role="progressbar" aria-label="Applet creation progress" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0"><div id="progress-fill"></div></div><ol class="build-stages">${steps.map((step) => `<li>${step}</li>`).join("")}</ol><p id="progress-detail" class="supporting"></p></div>
      <section id="idea-step" class="intro step-panel" aria-labelledby="step-heading"><div class="eyebrow">SMALL TOOLS. YOUR IDEAS.</div><h1 id="step-heading" tabindex="-1">Make a little thing.<br><span>Make it yours.</span></h1><p class="intro-copy">A tracker, a timer, a tiny useful tool.<br>Describe one thing you want your applet to do.</p>
        <div class="idea-card"><label for="idea">What would you like to make?</label><textarea id="idea" maxlength="512" rows="4" placeholder="A quiet focus timer with a big start button and a little celebration when I finish…" aria-describedby="idea-help idea-count"></textarea><div class="idea-bottom"><span id="idea-count">0 / 512</span><button id="idea-next" class="primary">Shape my idea ${arrow}</button></div></div><p id="idea-help" class="supporting">Keep it focused. You can refine the details together once it’s built.</p><p id="idea-validation" class="form-error" role="alert"></p>
        <div class="inspiration"><span>Or start small</span><div><button data-example="A quiet focus timer with start, pause and reset buttons">A focus timer <span aria-hidden="true">↗</span></button><button data-example="A daily practice counter with a large add button and reset">A daily counter <span aria-hidden="true">↗</span></button><button data-example="A simple checklist for my morning routine">A morning checklist <span aria-hidden="true">↗</span></button></div></div>
        <div class="intro-note"><span aria-hidden="true">✳</span><p>From a thought to something you can use.<br><span>Build, try it out, and make it better.</span></p></div>
      </section>
      <section id="setup-step" class="setup step-panel" hidden aria-labelledby="setup-heading"><button id="back-idea" class="text-button">← Back to your idea</button><div class="eyebrow">A QUICK CHECK</div><h1 id="setup-heading" tabindex="-1">Let’s bring it to life.</h1><p class="intro-copy">We’ll build your first version, check it, and open it here.</p><div class="setup-card"><div class="setup-row"><span class="setup-icon" aria-hidden="true">✳</span><div><h2>Your idea</h2><p id="idea-review"></p></div><button id="edit-idea" class="quiet">Edit</button></div><div class="setup-row"><span class="setup-icon" aria-hidden="true">↗</span><div><h2>Generation model</h2><p id="model-summary">${bootstrap.providerLabel}</p><p id="model-explanation" class="supporting"></p></div><button id="setup-settings" class="quiet">Change</button></div><div class="setup-row"><span class="setup-icon" aria-hidden="true">◎</span><div><h2>A local test run</h2><p>Test funds are prepared automatically when you create.</p><p class="supporting">No real sats are charged here. ChatGPT requests use your subscription when selected.</p></div></div><details class="budget-details"><summary>Test budget</summary><label for="maximum">Maximum per action (test sats)</label><input id="maximum" inputmode="numeric" value="${bootstrap.actionCeilingSat}" aria-describedby="budget-help"><p id="budget-help" class="supporting">At least ${bootstrap.actionCeilingSat} test sats. This caps local charges; subscription limits are managed in ChatGPT.</p></details></div><p id="setup-validation" class="form-error" role="alert"></p><div class="setup-footer"><span class="supporting">Your first version is a starting point.</span><button id="generate" class="primary" disabled>Create my applet ${arrow}</button></div></section>
      <section id="build-step" class="step-panel" hidden aria-labelledby="build-heading"><div class="workspace-title"><div><div class="eyebrow">YOUR WORKSPACE</div><h1 id="build-heading" tabindex="-1">A little work in progress.</h1></div><button id="new-applet" class="quiet">New applet <span aria-hidden="true">+</span></button></div>
        <div class="making-grid"><section class="preview-panel" aria-labelledby="preview-heading"><div class="preview-toolbar"><h2 id="preview-heading"><span class="preview-dot" aria-hidden="true"></span>Preview</h2><div class="preview-tools"><label class="sr-only" for="version-picker">Preview version</label><select id="version-picker" disabled><option value="">No version yet</option></select><button id="preview-expand" class="icon-button" aria-label="Expand preview" aria-pressed="false">⤢</button></div></div><div class="preview-stage"><div id="preview-empty"><div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div><h3>Your idea takes shape here.</h3><p id="preview-empty-copy">The preview opens after your applet passes its checks.</p></div><iframe id="preview" title="Verified napplet preview" hidden></iframe></div><div class="preview-caption"><span id="preview-caption">A sandboxed space to try your applet.</span><span id="preview-verified" hidden>✓ Verified</span></div></section>
        <section class="conversation" aria-labelledby="conversation-heading"><div class="conversation-header"><div class="small-mark" aria-hidden="true">a·</div><div><h2 id="conversation-heading">Make it yours</h2><p>Small changes. Better every time.</p></div></div><ol id="conversation-messages" aria-label="Your requests and build results"></ol><p id="chat-working" role="status" hidden>Working on your request…</p><div id="old-version-note" hidden><p>You’re viewing an earlier version.</p><button id="return-latest" class="text-button">Return to latest to make changes →</button></div><div class="composer"><label for="revision">What would you like to change?</label><textarea id="revision" maxlength="512" rows="3" placeholder="Make the buttons bigger, try a softer colour…" aria-describedby="revision-hint"></textarea><div class="composer-footer"><span id="revision-hint">⌘ / Ctrl + Enter to send</span><button id="revise" class="send-button" disabled aria-label="Send revision">${arrow}</button></div></div><p class="chat-footnote">Each change creates a new verified version.</p></section></div>
      </section>
      <section id="product-notice" class="notice" hidden aria-labelledby="notice-heading"><div><h2 id="notice-heading">Something needs a look</h2><p id="notice-copy" role="alert"></p></div><button id="review-request" class="quiet">Review request</button><button id="notice-settings" class="quiet" hidden>Open settings</button></section>
      <section id="continuation" class="notice" hidden><div><h2>Ready when you are</h2><p id="pending-status"></p></div><button id="resume" class="primary">Resume saved action</button></section>
      <section id="recovery" class="notice" hidden><div><h2>Let’s check your last request</h2><p>The page closed before its outcome was confirmed. Check the original request before starting another.</p></div><button id="recover" class="primary" disabled>Check original request</button></section>
      <details id="execution-details" class="execution-details" hidden><summary>Execution details <span>Live activity, checks and receipts</span></summary><section id="execution-activity" aria-labelledby="activity-heading"></section><p id="generation-status" aria-live="polite"></p><p id="generation-error" role="alert"></p><dl id="generation-facts"></dl><h3>Session timeline</h3><ol id="timeline"></ol></details>
      <footer class="site-footer"><span>A little idea goes a long way.</span><div><span>Local development · Publishing later.</span><a href="/dev">Development console <span aria-hidden="true">↗</span></a></div></footer>
      <dialog id="workspace-settings" aria-labelledby="settings-heading"><div class="dialog-header"><h2 id="settings-heading">Workspace settings</h2><button id="close-settings" class="icon-button" aria-label="Close settings">×</button></div><div class="workspace-controls"></div><details><summary>Connection and test balance</summary><p id="connection-status" aria-live="polite">Connecting</p><button id="connect">Reconnect</button><p id="balance"></p><p id="provider-mode"></p><p id="funding-status" aria-live="polite"></p></details><p class="supporting settings-note">This development workspace runs locally. Your browser keeps your Nostr key. Model credentials stay on the local service.</p></dialog>
      <div hidden><input id="cashu-amount"><button id="cashu"></button><button id="cashu-replay"></button><input id="nwc-amount"><button id="nwc"></button><button id="replay-revision"></button><ul id="versions"></ul></div>`;
    let draft: Partial<Draft> = {};
    try { const parsed = JSON.parse(sessionStorage.getItem(this.#key) ?? "null"); if (parsed && typeof parsed === "object") { draft = parsed; this.#hasDraft = true; } } catch { /* A corrupt draft never prevents opening the workspace. */ }
    this.field("idea").value = typeof draft.idea === "string" ? draft.idea.slice(0, 512) : "";
    this.field("revision").value = typeof draft.revision === "string" ? draft.revision.slice(0, 512) : "";
    if (typeof draft.maximum === "string" && /^\d{1,9}$/u.test(draft.maximum)) this.field("maximum").value = draft.maximum;
    this.#messages = Array.isArray(draft.messages) ? draft.messages.filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.text === "string" && m.text.length <= 1000).slice(-60) : [];
    this.#sessionId = typeof draft.sessionId === "string" ? draft.sessionId : undefined;
    this.renderMessages(); this.count();
    // Keep the newest reply beside the composer when the responsive layout changes.
    const conversation = this.el("conversation-messages");
    new ResizeObserver(() => { conversation.scrollTop = conversation.scrollHeight; }).observe(conversation);
    this.showStep(draft.step === 2 ? 2 : draft.step === 3 ? 3 : 1, false);
    this.el<HTMLButtonElement>("idea-next").onclick = () => { if (!this.field("idea").value.trim()) { this.text("idea-validation", "Start with one thing you’d like your applet to do."); this.field("idea").focus(); return; } this.text("idea-validation", ""); this.showStep(2); };
    for (const id of ["back-idea", "edit-idea"]) this.el<HTMLButtonElement>(id).onclick = () => this.showStep(1);
    this.root.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((button) => button.onclick = () => { this.field("idea").value = button.dataset.example!; this.count(); this.persist(); this.field("idea").focus(); });
    for (const id of ["idea", "revision", "maximum"]) this.field(id).addEventListener("input", () => { this.count(); this.persist(); this.syncControls(); });
    this.el<HTMLTextAreaElement>("idea").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) this.el<HTMLButtonElement>("idea-next").click(); });
    this.el<HTMLTextAreaElement>("revision").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.el<HTMLButtonElement>("revise").click(); } });
    const settings = this.el<HTMLDialogElement>("workspace-settings");
    if (new URL(location.href).searchParams.has("chatgpt_error")) settings.showModal();
    for (const id of ["open-settings", "setup-settings", "notice-settings"]) this.el<HTMLButtonElement>(id).onclick = () => settings.showModal();
    this.el<HTMLButtonElement>("close-settings").onclick = () => settings.close();
    this.el<HTMLButtonElement>("review-request").onclick = () => { if (this.#version) { this.field("revision").focus(); } else this.showStep(2); };
    this.el<HTMLButtonElement>("new-applet").onclick = () => { this.showStep(1); this.field("idea").focus(); };
    this.el<HTMLButtonElement>("preview-expand").onclick = () => { const button = this.el("preview-expand"); const expanded = button.getAttribute("aria-pressed") !== "true"; button.setAttribute("aria-pressed", String(expanded)); button.setAttribute("aria-label", expanded ? "Restore workspace" : "Expand preview"); this.el("build-step").classList.toggle("expanded-preview", expanded); };
    this.model(bootstrap.providerLabel);
  }
  private el<T extends HTMLElement = HTMLElement>(id: string): T { return this.root.querySelector<T>(`#${id}`)!; }
  private field(id: string): HTMLInputElement | HTMLTextAreaElement { return this.el<HTMLInputElement | HTMLTextAreaElement>(id); }
  private text(id: string, value: string): void { if (this.el(id).textContent !== value) this.el(id).textContent = value; }
  private count(): void { this.text("idea-count", `${this.field("idea").value.length} / 512`); }
  private persist(): void { sessionStorage.setItem(this.#key, JSON.stringify({ idea: this.field("idea").value, revision: this.field("revision").value, maximum: this.field("maximum").value, step: this.#step, messages: this.#messages.slice(-60), sessionId: this.#sessionId } satisfies Draft)); }
  private showStep(step: number, focus = true): void {
    this.#step = step;
    this.root.querySelector<HTMLAnchorElement>(".skip-link")!.href = `#${["step-heading", "setup-heading", "build-heading"][step - 1]}`;
    ["idea-step", "setup-step", "build-step"].forEach((id, index) => this.el(id).hidden = index + 1 !== step);
    this.root.querySelectorAll<HTMLElement>("[data-step]").forEach((item) => { if (Number(item.dataset.step) === step) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current"); item.dataset.complete = String(Number(item.dataset.step) < step); });
    this.text("idea-review", this.field("idea").value);
    this.el("product-progress").hidden = step !== 3;
    if (step === 3 && !this.#running && !this.#version && this.#lastState === "idle") this.text("progress-title", "Restoring your workspace…");
    if (step === 3) requestAnimationFrame(() => { const messages = this.el("conversation-messages"); messages.scrollTop = messages.scrollHeight; });
    if (focus) this.el(["step-heading", "setup-heading", "build-heading"][step - 1]!).focus();
    this.persist();
  }
  model(summary: string): void { this.text("model-summary", summary); this.text("progress-provider", summary.includes("Deterministic fixture") ? "Sample mode · no model request" : summary); this.text("model-explanation", summary.includes("Deterministic fixture") ? "Sample mode builds a counter without a model request. Choose ChatGPT in Settings to generate from your idea." : summary.includes("API") || summary.includes("Responses") ? "Uses the API provider configured on your local service." : "Your saved ChatGPT sign-in is reused. Requests use your subscription allowance."); }
  connected(value: boolean): void { this.#connected = value; this.text("connection-summary", value ? "Workspace connected" : "Connection unavailable · retry in Settings"); this.el("connection-summary").dataset.connected = String(value); this.syncControls(); }
  validate(kind: string): boolean {
    if (kind === "recover" || kind === "resume") return true;
    let valid = false;
    try { valid = /^\d{1,9}$/u.test(this.field("maximum").value) && BigInt(this.field("maximum").value) >= BigInt(this.bootstrap.actionCeilingSat); } catch { /* Surface the field error below. */ }
    if (!valid) { this.text("setup-validation", `Choose a maximum of at least ${this.bootstrap.actionCeilingSat} test sats.`); this.showStep(2); const details = this.field("maximum").closest("details"); if (details) details.open = true; this.field("maximum").focus(); return false; }
    if (kind === "generate" && !this.field("idea").value.trim()) { this.showStep(1); this.field("idea").focus(); return false; }
    return kind !== "revise" || !!this.field("revision").value.trim();
  }
  begin(kind: string): void {
    this.#revisionRequest = kind === "revise" || kind === "recover-revise";
    this.#outcomeAdded = false; this.#running = true; this.#progress = 0;
    this.el("product-notice").hidden = true; this.el("execution-details").hidden = false;
    this.text("setup-validation", "");
    if (kind === "generate") { this.#sessionBlocked = false; this.#messages = []; this.addMessage({ role: "user", text: this.field("idea").value.trim() }); }
    else if (kind === "revise") this.addMessage({ role: "user", text: this.field("revision").value.trim() });
    this.showStep(3); this.text("build-heading", this.#version ? "A little better, every version." : "A little work in progress.");
    this.el("chat-working").hidden = false; this.syncControls();
  }
  progress(snapshot: ActivitySnapshot): void {
    this.#lastState = snapshot.state;
    if (snapshot.state === "running") this.#progress = Math.max(this.#progress, stageIndex[snapshot.stage ?? "request"] ?? 0);
    if (snapshot.state === "completed" && this.#outcomeAdded) this.#progress = 5;
    const isFailed = snapshot.state === "failed" || snapshot.state === "uncertain";
    const title = snapshot.stale ? "Still waiting for an update…" : snapshot.state === "running" ? ["Preparing your workspace", "Bringing your idea to life", "Building your applet", "Checking everything works", "Opening your preview"][this.#progress] ?? "Opening your preview" : snapshot.state === "completed" ? this.#outcomeAdded ? "Your applet is ready." : "Your action is saved." : snapshot.state === "uncertain" ? "The outcome needs checking." : "This version couldn’t be completed.";
    this.text("progress-title", title); this.text("progress-time", `${snapshot.elapsed}s`);
    this.text("progress-detail", snapshot.stale ? snapshot.detail : isFailed ? "See the explanation below. Your last verified version is safe." : snapshot.state === "running" ? snapshot.current : this.#progress === 5 ? "Built, checked and ready to try. Tell us what you’d change." : "");
    this.el("build-progress").setAttribute("aria-valuenow", String(this.#progress)); this.el("build-progress").setAttribute("aria-valuetext", title);
    this.el("progress-fill").style.width = `${this.#progress * 20}%`;
    this.el("product-progress").dataset.state = snapshot.stale ? "stale" : snapshot.state;
    this.root.querySelectorAll<HTMLElement>(".build-stages li").forEach((item, i) => { item.dataset.complete = String(i < this.#progress); item.dataset.current = String(i === this.#progress && snapshot.state === "running"); });
  }
  completed(version: WorkspaceVersion, hydrated = false): void {
    if (this.#sessionId && this.#sessionId !== version.sessionId && hydrated) this.#messages = [];
    if (!hydrated) this.#sessionBlocked = false;
    this.#sessionId = version.sessionId; this.#version = version; this.el("execution-details").hidden = false;
    this.el("preview-empty").hidden = true; this.el("preview-verified").hidden = false;
    this.text("preview-caption", `Version ${version.version} · ready to explore`);
    this.text("build-heading", "A little thing, made yours.");
    if (!this.#messages.some((m) => m.role === "assistant" && m.version === version.version) || !hydrated) {
      this.addMessage({ role: "assistant", text: `Version ${version.version} is ready to try. ${version.version === 1 ? "Give it a go, then tell me what you’d like to change." : "Your change passed its checks. You can compare versions above the preview."}`, version: version.version });
    }
    this.#outcomeAdded = true;
    if (this.#revisionRequest && !hydrated) this.field("revision").value = "";
    if (hydrated && !this.#running) { if (this.#step === 3 || !this.#hasDraft) this.showStep(3, false); this.progress({ state: "completed", current: "", detail: "", elapsed: 0, stale: false }); this.text("progress-time", "Saved workspace"); }
    this.persist(); this.syncControls();
  }
  failed(code: string, uncertain: boolean): void {
    if (/USAGE_UNKNOWN|SESSION_NOT_REVISION_READY|BILLING_INVARIANT/u.test(code)) this.#sessionBlocked = true;
    const auth = /CHATGPT.*(?:SIGN_IN|PERMISSION|REAUTHORIZE|LIMIT|ACCESS)/u.test(code);
    const copy = uncertain ? "We couldn’t confirm this request’s outcome. It won’t be retried automatically. Check the original request if offered below; detailed activity is available underneath." : auth ? "Your ChatGPT account needs attention before we can continue. Open Settings for the account’s explanation." : /WORKER|ARTIFACT|SOURCE_INVALID/u.test(code) ? "This version didn’t pass its checks. Your last verified preview is still available. Try a simpler change; the check details are below." : /ADMISSION/u.test(code) ? "The service couldn’t reserve a workspace for this request. No generation was started. You can try again when it’s available." : /FUND/u.test(code) ? "Test funds couldn’t be confirmed. Check your balance in Settings before trying again." : "We couldn’t finish this request. Your last verified preview is still available. Open execution details for the reason.";
    this.el("product-notice").hidden = false; this.text("notice-heading", uncertain ? "Outcome unconfirmed" : "This attempt stopped"); this.text("notice-copy", copy); this.el("notice-settings").hidden = !auth; this.el("review-request").hidden = uncertain || auth;
    if (!this.#outcomeAdded) this.addMessage({ role: "assistant", text: copy, state: uncertain ? "uncertain" : "failed" });
    this.#outcomeAdded = true;
    if (!this.#version) { this.text("preview-empty-copy", "A verified preview will appear here after a successful build."); this.text("build-heading", "Let’s get your idea working."); }
  }
  settled(): void { this.#running = false; this.el("chat-working").hidden = true; this.syncControls(); this.persist(); }
  explainFailure(explanation: string): void {
    if (this.#running || this.el("product-notice").hidden) return;
    this.text("notice-copy", explanation);
    const last = this.#messages.at(-1);
    if (last?.role === "assistant" && last.state) { last.text = explanation; this.renderMessages(); this.persist(); }
  }
  recovery(needed: boolean): void { this.#recovering = needed; this.el("recovery").hidden = !needed; if (needed) { this.showStep(3, false); this.#progress = 0; this.text("progress-title", "Your last request needs checking."); this.el("build-progress").setAttribute("aria-valuenow", "0"); this.el("build-progress").setAttribute("aria-valuetext", "Outcome unconfirmed"); this.el("progress-fill").style.width = "0%"; this.text("progress-detail", "The previous request has not been confirmed. Your saved preview remains available."); } this.syncControls(); }
  versions(versions: readonly WorkspaceVersion[], selected: WorkspaceVersion | undefined, change: (version: WorkspaceVersion) => Promise<unknown>): void {
    this.#changeVersion = change;
    const picker = this.el<HTMLSelectElement>("version-picker");
    picker.replaceChildren(...versions.map((version, index) => new Option(`Version ${version.version}${index === versions.length - 1 ? " · latest" : ""}`, version.artifactId)));
    if (!versions.length) picker.add(new Option("No version yet", ""));
    if (selected) picker.value = selected.artifactId;
    picker.disabled = this.#running || this.#selectingVersion || !versions.length;
    const latest = versions.at(-1); const old = !!selected && !!latest && selected.artifactId !== latest.artifactId;
    this.el("old-version-note").hidden = !old;
    this.el<HTMLTextAreaElement>("revision").disabled = old || this.#running || this.#recovering || this.#sessionBlocked || !selected;
    picker.onchange = () => { const version = versions.find((v) => v.artifactId === picker.value); if (version) void this.switchVersion(version); };
    this.el<HTMLButtonElement>("return-latest").onclick = () => { if (latest) void this.switchVersion(latest); };
    this.syncControls();
  }
  private async switchVersion(version: WorkspaceVersion): Promise<void> {
    if (this.#selectingVersion || this.#running) return;
    this.#selectingVersion = true; this.syncControls();
    try { await this.#changeVersion?.(version); } finally { this.#selectingVersion = false; this.syncControls(); }
  }
  sessionState(state: string): void {
    this.#sessionBlocked = !["verified", "failed"].includes(state);
    if (["usage_unknown", "billing_invariant_failed"].includes(state)) {
      this.el("product-notice").hidden = false; this.el("review-request").hidden = true;
      this.text("notice-heading", "This session needs a confirmed outcome");
      this.text("notice-copy", "Your last verified preview is available, but the latest request still needs usage reconciliation. This session can’t accept another revision yet. You can start a new applet as a separate explicit request.");
      this.#progress = 0; this.progress({ state: "uncertain", current: "", detail: "", elapsed: 0, stale: false }); this.text("progress-time", "Saved session");
    }
    this.syncControls();
  }
  selected(version: WorkspaceVersion): void { this.#version = version; this.text("preview-caption", `Version ${version.version} · ready to explore`); }
  private syncControls(): void {
    const picker = this.el<HTMLSelectElement>("version-picker"); picker.disabled = this.#running || this.#selectingVersion || !picker.value;
    this.el<HTMLButtonElement>("generate").disabled = !this.#connected || this.#running || this.#recovering;
    this.el<HTMLButtonElement>("revise").disabled = !this.#connected || this.#running || this.#recovering || this.#sessionBlocked || this.#selectingVersion || !this.#version || !this.el("old-version-note").hidden || !this.field("revision").value.trim();
    this.el<HTMLButtonElement>("recover").disabled = !this.#connected || this.#running;
    this.el<HTMLButtonElement>("resume").disabled = !this.#connected || this.#running || this.#recovering;
    this.el<HTMLButtonElement>("new-applet").disabled = this.#running || this.#recovering;
    this.el<HTMLButtonElement>("open-settings").disabled = this.#running;
  }
  private addMessage(message: Message): void { this.#messages.push(message); this.#messages = this.#messages.slice(-60); this.renderMessages(); this.persist(); }
  private renderMessages(): void {
    const list = this.el("conversation-messages");
    list.replaceChildren(...this.#messages.map((message) => { const item = document.createElement("li"); item.className = `message ${message.role}`; if (message.state) item.dataset.state = message.state; const label = document.createElement("span"); label.className = "message-author"; label.textContent = message.role === "user" ? "You" : "applet.broker"; const body = document.createElement("p"); body.textContent = message.text; item.append(label, body); return item; }));
    list.scrollTop = list.scrollHeight;
  }
}
