import { ProjectCostsSchema, type ProjectCosts } from "../project-costs-contract";
import { renderSpend, requestCostElement, spendMarkup } from "./request-costs";
import { estimateMarkup, GenerationEstimatesView } from "./generation-estimates";
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
  #costs?: ProjectCosts;
  #pendingFrom?: number;
  #requestKey?: string;
  #loadCosts?: (after?: string) => Promise<void>;
  #key: string;
  #estimates: GenerationEstimatesView;
  #step = 1;
  #hasDraft = false;
  #messages: Message[] = [];
  #sessionId?: string;
  #running = false;
  #connected = false;
  #recovering = false;
  #sessionBlocked = false;
  #sessionState?: string;
  #connectionChecked = false;
  #checkingSession = false;
  #checkSession?: () => Promise<void>;
  #revisionHelp?: () => void;
  #selectingVersion = false;
  #restoringVersion = false;
  #restoreVersion?: (version: WorkspaceVersion) => Promise<void>;
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
      <header class="brand-header app-header"><a class="brand" href="#/workspace" aria-label="applet.broker workspace"><span class="brand-mark" aria-hidden="true">a<span>·</span></span><span class="brand-name">applet<span class="brand-light">.broker</span></span></a>
        <nav class="app-navigation" aria-label="Primary navigation"><a id="workspace-home" class="app-nav-item" href="#/workspace" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg><span id="workspace-nav-label">Create</span><span id="workspace-nav-status" hidden>Working</span></a><a id="your-applets" class="app-nav-item" href="#/applets"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg><span>Your applets</span></a></nav>
        <div class="header-actions" role="group" aria-label="Account and settings"><button id="open-settings" class="quiet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></svg><span>Settings</span></button></div></header>
      <div id="app-content" class="app-content" role="region" aria-label="Workspace content" tabindex="-1"><div id="creation-workspace">
      <nav class="step-nav" aria-label="Creation steps"><ol><li data-step="1" aria-current="step"><span>01</span> Your idea</li><li data-step="2"><span>02</span> Ready to build</li><li data-step="3"><span>03</span> Make it yours</li><li data-step="4"><span>04</span> Publish</li></ol></nav>
      <div id="product-progress" hidden><div class="progress-heading"><p id="progress-title" role="status" aria-live="polite">Preparing your workspace</p><div class="progress-meta"><span id="progress-provider"></span><span id="progress-time"></span></div></div><div id="build-progress" role="progressbar" aria-label="Applet creation progress" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0"><div id="progress-fill"></div></div><ol class="build-stages">${steps.map((step) => `<li>${step}</li>`).join("")}</ol><p id="progress-detail" class="supporting"></p><p id="progress-estimate" class="progress-estimate"></p></div>
      <section id="idea-step" class="intro step-panel" aria-labelledby="step-heading"><div class="eyebrow">SMALL TOOLS. YOUR IDEAS.</div><h1 id="step-heading" tabindex="-1">Make a little thing.<br><span>Make it yours.</span></h1><p class="intro-copy">A tracker, a timer, a tiny useful tool.<br>Describe one thing you want your applet to do.</p>
        <div class="idea-card"><label for="idea">What would you like to make?</label><textarea id="idea" maxlength="512" rows="4" placeholder="A quiet focus timer with a big start button and a little celebration when I finish…" aria-describedby="idea-help idea-count"></textarea><div class="idea-bottom"><span id="idea-count">0 / 512</span><button id="idea-next" class="primary">Shape my idea ${arrow}</button></div></div><p id="idea-help" class="supporting">Keep it focused. You can refine the details together once it’s built.</p><p id="idea-validation" class="form-error" role="alert"></p>
        <div class="inspiration"><span>Or start small</span><div><button data-example="A quiet focus timer with start, pause and reset buttons">A focus timer <span aria-hidden="true">↗</span></button><button data-example="A daily practice counter with a large add button and reset">A daily counter <span aria-hidden="true">↗</span></button><button data-example="A simple checklist for my morning routine">A morning checklist <span aria-hidden="true">↗</span></button></div></div>
        <div class="intro-note"><span aria-hidden="true">✳</span><p>From a thought to something you can use.<br><span>Build, try it out, and make it better.</span></p></div>
      </section>
      <section id="setup-step" class="setup step-panel" hidden aria-labelledby="setup-heading"><button id="back-idea" class="text-button">← Back to your idea</button><div class="eyebrow">A QUICK CHECK</div><h1 id="setup-heading" tabindex="-1">Let’s bring it to life.</h1><p class="intro-copy">We’ll build your first version, check it, and open it here.</p><div class="setup-card"><div class="setup-row"><span class="setup-icon" aria-hidden="true">✳</span><div><h2>Your idea</h2><p id="idea-review"></p></div><button id="edit-idea" class="quiet">Edit</button></div><div class="setup-row"><span class="setup-icon" aria-hidden="true">↗</span><div><h2>Connected CVM</h2><p id="model-summary">${bootstrap.providerLabel}</p><p id="model-explanation" class="supporting"></p></div><button id="setup-settings" class="quiet">Connection</button></div><div class="setup-row"><span class="setup-icon" aria-hidden="true">◎</span><div><h2>A local test run</h2><p>Test funds are prepared automatically when you create.</p><p class="supporting">No real sats are charged in this development CVM. Model access is managed by its operator.</p></div></div>${estimateMarkup("create")}<details class="budget-details"><summary>Test budget</summary><label for="maximum">Maximum per action (test sats)</label><input id="maximum" inputmode="numeric" value="${bootstrap.actionCeilingSat}" aria-describedby="budget-help"><p id="budget-help" class="supporting">At least ${bootstrap.actionCeilingSat} test sats. This caps local test charges for this CVM.</p></details></div><p id="setup-validation" class="form-error" role="alert"></p><div class="setup-footer"><span class="supporting">Your first version is a starting point.</span><button id="generate" class="primary" disabled>Create my applet ${arrow}</button></div></section>
      ${spendMarkup("workspace")}
      <section id="build-step" class="step-panel" hidden aria-labelledby="build-heading"><div class="workspace-title"><div><div class="eyebrow">YOUR WORKSPACE</div><h1 id="build-heading" tabindex="-1">A little work in progress.</h1></div><button id="new-applet" class="quiet">New applet <span aria-hidden="true">+</span></button></div>
        <div class="making-grid"><section class="preview-panel" aria-labelledby="preview-heading"><div class="preview-toolbar"><h2 id="preview-heading"><span class="preview-dot" aria-hidden="true"></span>Preview</h2><div class="preview-tools"><label class="sr-only" for="version-picker">Preview version</label><select id="version-picker" disabled><option value="">No version yet</option></select><button id="preview-expand" class="icon-button" aria-label="Expand preview" aria-pressed="false">⤢</button></div></div><details id="revision-history" class="revision-history" hidden><summary>Version history <span id="revision-count"></span></summary><ol id="revision-history-list" aria-label="Saved revisions"></ol></details><div id="revision-selection" class="revision-selection" hidden><div><strong id="revision-selection-title"></strong><p>Your next edit can start here. Later versions stay saved.</p></div><div class="revision-actions"><button id="restore-version" class="primary">Restore this version</button><button id="return-current" class="quiet">Return to current</button></div><span class="supporting">No model request · No charge</span></div><p id="restore-status" class="restore-status" role="status" hidden></p><div class="preview-stage"><div id="preview-empty" data-state="idle"><div class="preview-status-art" aria-hidden="true"><svg viewBox="0 0 160 160" fill="none" focusable="false"><circle class="preview-orbit" cx="80" cy="80" r="65"/><g class="preview-shape"><rect x="40" y="40" width="80" height="80" rx="24"/><rect class="preview-shape-line" x="40" y="40" width="80" height="80" rx="24" pathLength="100"/></g><circle class="preview-center" cx="80" cy="80" r="5"/></svg></div><p id="preview-status-label" class="preview-status-label">YOUR FIRST VERSION</p><h3 id="preview-status-title" role="status" aria-live="polite">Your idea takes shape here.</h3><p id="preview-empty-copy">The preview opens after your applet passes its checks.</p><dl id="preview-status-metrics" hidden><div><dt>Time elapsed</dt><dd id="preview-status-elapsed"></dd></div><div id="preview-remaining-metric"><dt>Estimated remaining</dt><dd id="preview-status-remaining"></dd></div><div id="preview-cost-metric"><dt>Estimated cost</dt><dd id="preview-status-cost"></dd></div></dl><p id="preview-status-note" hidden>Your preview will appear here when it’s ready.</p></div><iframe id="preview" title="Verified napplet preview" hidden></iframe></div><div class="preview-caption"><span id="preview-caption">A sandboxed space to try your applet.</span><span id="preview-verified" hidden>✓ Verified</span></div></section>
        <section class="conversation" aria-labelledby="conversation-heading"><div class="conversation-header"><div class="small-mark" aria-hidden="true">a·</div><div><h2 id="conversation-heading">Make it yours</h2><p>Small changes. Better every time.</p></div></div>${spendMarkup("conversation")}<p id="cost-history-status" class="request-note" role="status"></p><button id="cost-history-refresh" class="quiet" hidden>Refresh costs</button><button id="cost-history-more" class="quiet" hidden>Earlier requests</button><ol id="conversation-messages" aria-label="Your requests and build results"></ol><p id="chat-working" role="status" hidden>Working on your request…</p><div id="old-version-note" hidden><p>Previewing a saved version. Restore it to make changes.</p><button id="return-latest" class="text-button">Return to current →</button></div><div class="composer"><label for="revision">What would you like to change?</label><textarea id="revision" maxlength="512" rows="3" placeholder="Make the buttons bigger, try a softer colour…" aria-describedby="revision-hint revision-blocked-reason revision-status-result"></textarea><div class="composer-footer"><span id="revision-hint">⌘ / Ctrl + Enter to send</span><button id="revise" class="send-button" disabled aria-label="Send revision" aria-describedby="revision-blocked-reason">${arrow}</button></div><div id="revision-availability" hidden><p id="revision-blocked-reason" role="status"></p><button id="revision-help" class="text-button" hidden></button></div><p id="revision-status-result" class="supporting" role="status" hidden></p></div>${estimateMarkup("revise")}<p class="chat-footnote">Each change creates a new verified version.</p></section></div>
      </section>
      <section id="product-notice" class="notice" hidden aria-labelledby="notice-heading"><div><h2 id="notice-heading">Something needs a look</h2><p id="notice-copy" role="alert"></p></div><button id="review-request" class="quiet">Review request</button><button id="notice-settings" class="quiet" hidden>Open settings</button></section>
      <section id="continuation" class="notice" hidden><div><h2>Ready when you are</h2><p id="pending-status"></p></div><button id="resume" class="primary">Resume saved action</button></section>
      <section id="recovery" class="notice" hidden><div><h2>Let’s check your last request</h2><p>The page closed before its outcome was confirmed. Check the original request before starting another.</p></div><button id="recover" class="primary" disabled>Check original request</button></section>
      <details id="execution-details" class="execution-details" hidden><summary>Execution details <span>Live activity, checks and receipts</span></summary><section id="execution-activity" aria-labelledby="activity-heading"></section><p id="generation-status" aria-live="polite"></p><p id="generation-error" role="alert"></p><dl id="generation-facts"></dl><h3>Session timeline</h3><ol id="timeline"></ol></details>
      </div>
      </div><footer class="site-footer app-status"><span class="environment"><i aria-hidden="true"></i>Local development</span><p id="connection-summary" role="status">Connecting…</p><a href="./console.html">Development console <span aria-hidden="true">↗</span></a></footer>
      <dialog id="workspace-settings" aria-labelledby="settings-heading"><div class="dialog-header"><h2 id="settings-heading">Workspace settings</h2><button id="close-settings" class="icon-button" aria-label="Close settings">×</button></div><div class="workspace-controls"></div><details><summary>Connection and test balance</summary><p id="connection-status" aria-live="polite">Connecting</p><button id="connect">Reconnect</button><p id="balance"></p><p id="provider-mode"></p><p id="funding-status" aria-live="polite"></p></details><p class="supporting settings-note">This website connects through encrypted ContextVM. Your signing keys stay in your browser or signer. The CVM operator manages model credentials.</p></dialog>
      <div hidden><input id="cashu-amount"><button id="cashu"></button><button id="cashu-replay"></button><input id="nwc-amount"><button id="nwc"></button><button id="replay-revision"></button><ul id="versions"></ul></div>`;
    this.#estimates = new GenerationEstimatesView(root);
    let draft: Partial<Draft> = {};
    try { const parsed = JSON.parse(sessionStorage.getItem(this.#key) ?? "null"); if (parsed && typeof parsed === "object") { draft = parsed; this.#hasDraft = true; } } catch { /* A corrupt draft never prevents opening the workspace. */ }
    this.field("idea").value = typeof draft.idea === "string" ? draft.idea.slice(0, 512) : "";
    this.field("revision").value = typeof draft.revision === "string" ? draft.revision.slice(0, 512) : "";
    if (typeof draft.maximum === "string" && /^\d{1,9}$/u.test(draft.maximum)) this.field("maximum").value = draft.maximum;
    this.#messages = Array.isArray(draft.messages) ? draft.messages.filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.text === "string" && m.text.length <= 1000).slice(-60) : [];
    this.#sessionId = typeof draft.sessionId === "string" ? draft.sessionId : undefined;
    this.renderMessages(); this.count();
    this.el("cost-history-refresh").onclick = () => { void this.loadCosts(); };
    this.el("cost-history-more").onclick = () => { void this.loadCosts(this.#costs?.nextCursor ?? undefined); };
    this.showStep(draft.step === 2 ? 2 : draft.step === 3 || draft.step === 4 ? 3 : 1, false);
    this.el<HTMLButtonElement>("idea-next").onclick = () => { if (!this.field("idea").value.trim()) { this.text("idea-validation", "Start with one thing you’d like your applet to do."); this.field("idea").focus(); return; } this.text("idea-validation", ""); this.showStep(2); };
    for (const id of ["back-idea", "edit-idea"]) this.el<HTMLButtonElement>(id).onclick = () => this.showStep(1);
    this.root.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((button) => button.onclick = () => { this.field("idea").value = button.dataset.example!; this.count(); this.persist(); this.field("idea").focus(); });
    for (const id of ["idea", "revision", "maximum"]) this.field(id).addEventListener("input", () => { this.count(); this.persist(); this.syncControls(); });
    this.el<HTMLTextAreaElement>("idea").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) this.el<HTMLButtonElement>("idea-next").click(); });
    this.el<HTMLTextAreaElement>("revision").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.el<HTMLButtonElement>("revise").click(); } });
    const settings = this.el<HTMLDialogElement>("workspace-settings");
    for (const id of ["open-settings", "setup-settings", "notice-settings"]) this.el<HTMLButtonElement>(id).onclick = () => settings.showModal();
    this.el<HTMLButtonElement>("close-settings").onclick = () => settings.close();
    this.el<HTMLButtonElement>("review-request").onclick = () => { if (this.#version) { this.field("revision").focus(); } else this.showStep(2); };
    this.el<HTMLButtonElement>("new-applet").onclick = () => { this.showStep(1); this.field("idea").focus(); };
    this.el<HTMLButtonElement>("preview-expand").onclick = () => { const button = this.el("preview-expand"); const expanded = button.getAttribute("aria-pressed") !== "true"; button.setAttribute("aria-pressed", String(expanded)); button.setAttribute("aria-label", expanded ? "Restore workspace" : "Expand preview"); this.el("build-step").classList.toggle("expanded-preview", expanded); };
    document.addEventListener("applet:step", event => { const step = (event as CustomEvent<number>).detail; if (step === 3 || step === 4) this.showStep(step); });
    window.addEventListener("hashchange", () => this.navigation());
    this.el("revision-help").onclick = () => this.#revisionHelp?.();
    this.model(bootstrap.providerLabel); this.#estimates.maximum();
    this.syncControls();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string): T { return this.root.querySelector<T>(`#${id}`)!; }
  private field(id: string): HTMLInputElement | HTMLTextAreaElement { return this.el<HTMLInputElement | HTMLTextAreaElement>(id); }
  private text(id: string, value: string): void { if (this.el(id).textContent !== value) this.el(id).textContent = value; }
  private count(): void { this.text("idea-count", `${this.field("idea").value.length} / 512`); }
  private persist(): void { sessionStorage.setItem(this.#key, JSON.stringify({ idea: this.field("idea").value, revision: this.field("revision").value, maximum: this.field("maximum").value, step: this.#step, messages: this.#messages.slice(-60), sessionId: this.#sessionId } satisfies Draft)); }
  private showStep(step: number, focus = true): void {
    this.#step = step; this.navigation();
    this.el("creation-workspace").dataset.step = String(step);
    if (!this.el("creation-workspace").hidden) this.root.querySelector<HTMLAnchorElement>(".skip-link")!.href = `#${["step-heading", "setup-heading", "build-heading", "publication-heading"][step - 1]}`;
    ["idea-step", "setup-step", "build-step", "publish-step"].forEach((id, index) => { const panel = this.el(id); if (panel) panel.hidden = index + 1 !== step; });
    this.root.querySelectorAll<HTMLElement>("[data-step]").forEach((item) => { if (Number(item.dataset.step) === step) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current"); item.dataset.complete = String(Number(item.dataset.step) < step); });
    this.text("idea-review", this.field("idea").value);
    this.el("product-progress").hidden = step !== 3;
    if (step === 3 && !this.#running && !this.#version && this.#lastState === "idle") this.text("progress-title", "Restoring your workspace…");
    if (step === 3) requestAnimationFrame(() => { const messages = this.el("conversation-messages"); messages.scrollTop = messages.scrollHeight; });
    if (focus && !this.el("creation-workspace").hidden) this.el(["step-heading", "setup-heading", "build-heading", "publication-heading"][step - 1]!).focus();
    this.persist();
  }
  savedStatus(state: string): void { this.text("build-heading", state === "active" ? "Your applet is still building." : state === "needs_top_up" ? "Your applet is waiting for funds." : "Your saved applet."); this.text("progress-title", `Saved status: ${state.replaceAll("_", " ")}`); this.text("preview-empty-copy", "Refresh Your applets to check for a verified version. No new generation has been started."); this.el("execution-details").hidden = false; this.sessionState(state); this.previewStatus({state:"saved",current:"",detail:"",elapsed:0,stale:false}, state === "active" ? "Your applet is still building" : "Your saved request", ""); }
  openSaved(): void {
    this.el("restore-status").hidden = true; this.resetCosts(); this.#sessionId = undefined; this.#estimates.reset(); this.#hasDraft = false; this.#version = undefined; this.#sessionBlocked = false; this.#sessionState = undefined; this.text("revision-status-result", ""); this.#messages = []; this.renderMessages(); this.el("preview-empty").hidden = false; this.el("preview-verified").hidden = true; this.previewStatus({state:"saved",current:"",detail:"",elapsed:0,stale:false}, "Opening your saved applet", ""); this.showStep(3); }
  onCostsLoad(load: (after?: string) => Promise<void>): void { this.#loadCosts = load; }
  private async loadCosts(after?: string): Promise<void> {
    const button = this.el<HTMLButtonElement>(after ? "cost-history-more" : "cost-history-refresh"); button.disabled = true;
    try { await this.#loadCosts?.(after); } finally { button.disabled = false; }
  }
  requestKey(key: string): void { this.#requestKey = key; }
  costs(value: unknown, append = false): void {
    const data = ProjectCostsSchema.parse(value);
    if (append && this.#costs?.sessionId === data.sessionId) data.requests = [...new Map([...this.#costs.requests,...data.requests].map(r => [r.id,r])).values()];
    this.#costs = data; this.#sessionId = data.sessionId;
    if (data.requests.some(r => r.requestKey === this.#requestKey)) this.#pendingFrom = undefined;
    renderSpend(this.root,data.total); this.text("cost-history-status", ""); this.el("cost-history-refresh").hidden = true;
    this.el("cost-history-more").hidden = !data.nextCursor;
    this.renderMessages(!append); this.persist();
  }
  costsUnavailable(): void {
    this.text("cost-history-status", this.#costs ? "Showing saved costs. Refresh to check the latest charges." : "Costs unavailable. Refresh to check recorded charges.");
    this.el("cost-history-refresh").hidden = false;
  }
  private resetCosts(): void {
    this.#costs = undefined; this.#pendingFrom = undefined; this.#requestKey = undefined;
    renderSpend(this.root); this.text("cost-history-status", "");
    this.el("cost-history-more").hidden = true; this.el("cost-history-refresh").hidden = true;
  }
  estimates(value: unknown, forCurrentAction = false, placement?: "create" | "revise"): void { this.#estimates.set(value, forCurrentAction, placement); }
  actionCharge(value: unknown): void { this.#estimates.charge(value); }
  configuration(): void {
    if (!this.#hasDraft) this.field("maximum").value = this.bootstrap.actionCeilingSat;
    this.text("budget-help", `At least ${this.bootstrap.actionCeilingSat} test sats. This caps local test charges for this CVM.`);
    this.model(this.bootstrap.providerLabel); this.#estimates.maximum();
  }
  model(summary: string): void { this.text("model-summary", summary); this.text("progress-provider", summary.includes("fixture") ? `${summary} · no model request` : summary); this.text("model-explanation", summary.includes("fixture") ? "This CVM is in sample mode. Its operator can configure a generation provider." : "Generation is provided by the connected CVM. Provider accounts and credentials are managed privately by its operator."); }
  connected(value: boolean): void { this.#connected = value; this.#connectionChecked = true; this.text("connection-summary", value ? "Workspace connected" : "Connection unavailable · retry in Settings"); this.el("connection-summary").dataset.connected = String(value); this.syncControls(); }
  validate(kind: string): boolean {
    if (this.#checkingSession) return false;
    if (kind === "recover" || kind === "resume") return true;
    let valid = false;
    try { valid = /^\d{1,9}$/u.test(this.field("maximum").value) && BigInt(this.field("maximum").value) >= BigInt(this.bootstrap.actionCeilingSat); } catch { /* Surface the field error below. */ }
    if (!valid) { this.text("setup-validation", `Choose a maximum of at least ${this.bootstrap.actionCeilingSat} test sats.`); this.showStep(2); const details = this.field("maximum").closest("details"); if (details) details.open = true; this.field("maximum").focus(); return false; }
    if (kind === "generate" && !this.field("idea").value.trim()) { this.showStep(1); this.field("idea").focus(); return false; }
    return kind !== "revise" || !!this.field("revision").value.trim();
  }
  begin(kind: string): void {
    this.el("restore-status").hidden = true;
    if (kind === "generate") { this.resetCosts(); this.#sessionId = undefined; }
    this.#pendingFrom = kind === "generate" ? 0 : this.#messages.length; this.#requestKey = undefined;
    if (this.#costs) renderSpend(this.root, { ...this.#costs.total, pending: Math.max(1,this.#costs.total.pending) });
    this.#estimates.begin(kind);
    this.#revisionRequest = kind === "revise" || kind === "recover-revise";
    this.text("revision-status-result", "");
    this.#outcomeAdded = false; this.#running = true; this.#progress = 0;
    this.el("product-notice").hidden = true; this.el("execution-details").hidden = false;
    this.text("setup-validation", "");
    if (kind === "generate") { this.#sessionBlocked = false; this.#sessionState = undefined; this.#messages = []; this.addMessage({ role: "user", text: this.field("idea").value.trim() }); }
    else if (kind === "revise") this.addMessage({ role: "user", text: this.field("revision").value.trim() });
    this.showStep(3); this.text("build-heading", this.#version ? "A little better, every version." : "A little work in progress.");
    this.el("chat-working").hidden = false; this.syncControls();
  }
  progress(snapshot: ActivitySnapshot): void {
    this.#lastState = snapshot.state; const remaining = this.#estimates.progress(snapshot);
    if (snapshot.state === "running") this.#progress = Math.max(this.#progress, stageIndex[snapshot.stage ?? "request"] ?? 0);
    if (snapshot.state === "completed" && this.#outcomeAdded) this.#progress = 5;
    const isFailed = snapshot.state === "failed" || snapshot.state === "uncertain";
    const title = snapshot.stale ? "Still waiting for an update…" : snapshot.state === "running" ? ["Preparing your workspace", "Bringing your idea to life", "Building your applet", "Checking everything works", "Opening your preview"][this.#progress] ?? "Opening your preview" : snapshot.state === "completed" ? this.#outcomeAdded ? "Your applet is ready." : "Your action is saved." : snapshot.state === "uncertain" ? "The outcome needs checking." : "This version couldn’t be completed.";
    this.text("progress-title", title); this.text("progress-time", `${snapshot.elapsed}s elapsed`);
    this.text("progress-detail", snapshot.stale ? snapshot.detail : isFailed ? "See the explanation below. Your last verified version is safe." : snapshot.state === "running" ? snapshot.current : this.#progress === 5 ? "Built, checked and ready to try. Tell us what you’d change." : "");
    this.previewStatus(snapshot, title, remaining);
    this.el("build-progress").setAttribute("aria-valuenow", String(this.#progress)); this.el("build-progress").setAttribute("aria-valuetext", title);
    this.el("progress-fill").style.width = `${this.#progress * 20}%`;
    this.el("product-progress").dataset.state = snapshot.stale ? "stale" : snapshot.state;
    this.root.querySelectorAll<HTMLElement>(".build-stages li").forEach((item, i) => { item.dataset.complete = String(i < this.#progress); item.dataset.current = String(i === this.#progress && snapshot.state === "running"); });
  }
  private previewStatus(snapshot: ActivitySnapshot, title: string, remaining: string): void {
    this.previewStatusPlacement();
    if (this.el("preview-empty").hidden) return;
    const running = snapshot.state === "running";
    this.el("preview-empty").dataset.state = snapshot.stale ? "stale" : snapshot.state;
    this.text("preview-status-label", snapshot.stale ? "WAITING FOR AN UPDATE" : running ? "BUILD IN PROGRESS" : "REQUEST STATUS");
    this.text("preview-status-title", title);
    this.text("preview-empty-copy", snapshot.stale ? snapshot.detail : running ? snapshot.current : snapshot.state === "saved" ? "Refresh Your applets to check for a verified version. No new generation has been started." : snapshot.state === "uncertain" ? "Check the original request below to find out what happened. Your prompt is saved." : snapshot.state === "failed" ? "This attempt stopped. Review the explanation below before trying again." : "Your request is saved. Follow the next step below to continue.");
    this.el("preview-status-metrics").hidden = !running && snapshot.elapsed === 0;
    this.text("preview-status-elapsed", snapshot.elapsed < 60 ? `${snapshot.elapsed} sec` : `${Math.floor(snapshot.elapsed / 60)}m ${snapshot.elapsed % 60}s`);
    this.text("preview-status-remaining", remaining);
    this.el("preview-remaining-metric").hidden = !remaining;
    this.text("preview-status-cost", this.#estimates.currentCost); this.el("preview-cost-metric").hidden = !running;
    this.el("preview-status-note").hidden = !running;
  }
  private previewStatusPlacement(): void {
    const empty = !this.el("preview-empty").hidden;
    for (const id of ["progress-detail", "progress-estimate", "progress-time"]) this.el(id).hidden = empty;
    this.el("progress-title").setAttribute("aria-live", empty ? "off" : "polite");
  }
  completed(version: WorkspaceVersion, hydrated = false): void {
    if (this.#sessionId && this.#sessionId !== version.sessionId && hydrated) this.#messages = [];
    if (!hydrated) { this.#sessionBlocked = false; this.#sessionState = "verified"; }
    this.#sessionId = version.sessionId; this.#version = version; this.el("execution-details").hidden = false;
    this.el("preview-empty").hidden = true; this.el("preview-verified").hidden = false; this.previewStatusPlacement();
    this.text("preview-caption", `Version ${version.version} · ready to explore`);
    this.text("build-heading", "A little thing, made yours.");
    if (!this.#messages.some((m) => m.role === "assistant" && m.version === version.version) || !hydrated) {
      this.addMessage({ role: "assistant", text: `Version ${version.version} is ready to try. ${version.version === 1 ? "Give it a go, then tell me what you’d like to change." : "Your change passed its checks. You can compare versions above the preview."}`, version: version.version });
    }
    this.#outcomeAdded = true;
    if (this.#revisionRequest && !hydrated) this.field("revision").value = "";
    if (hydrated && !this.#running) { this.#estimates.reset(); if (this.#step === 3 || !this.#hasDraft) this.showStep(3, false); this.progress({ state: "completed", current: "", detail: "", elapsed: 0, stale: false }); this.text("progress-time", "Saved workspace"); }
    this.persist(); this.syncControls();
  }
  failed(code: string, uncertain: boolean): void {
    if (/USAGE_UNKNOWN|SESSION_NOT_REVISION_READY|BILLING_INVARIANT/u.test(code)) { this.#sessionBlocked = true; this.#sessionState = /USAGE_UNKNOWN/u.test(code) ? "usage_unknown" : /BILLING_INVARIANT/u.test(code) ? "billing_invariant_failed" : "not_revision_ready"; }
    const auth = /CHATGPT.*(?:SIGN_IN|PERMISSION|REAUTHORIZE|LIMIT|ACCESS)/u.test(code);
    const copy = uncertain ? "We couldn’t confirm this request’s outcome. It won’t be retried automatically. Check the original request if offered below; detailed activity is available underneath." : auth ? "The CVM’s generation provider needs operator attention. Your last verified version remains available." : /WORKER|ARTIFACT|SOURCE_INVALID/u.test(code) ? "This version didn’t pass its checks. Your last verified preview is still available. Try a simpler change; the check details are below." : /ADMISSION/u.test(code) ? "The service couldn’t reserve a workspace for this request. No generation was started. You can try again when it’s available." : /FUND/u.test(code) ? "Test funds couldn’t be confirmed. Check your balance in Settings before trying again." : "We couldn’t finish this request. Your last verified preview is still available. Open execution details for the reason.";
    this.el("product-notice").hidden = false; this.text("notice-heading", uncertain ? "Outcome unconfirmed" : "This attempt stopped"); this.text("notice-copy", copy); this.el("notice-settings").hidden = true; this.el("review-request").hidden = uncertain || auth;
    if (!this.#outcomeAdded) this.addMessage({ role: "assistant", text: copy, state: uncertain ? "uncertain" : "failed" });
    this.#outcomeAdded = true;
    if (!this.#version) { this.text("build-heading", "Let’s get your idea working."); }
  }
  settled(): void { this.#running = false; this.el("chat-working").hidden = true; this.syncControls(); this.persist(); }
  explainFailure(explanation: string): void {
    if (this.#running || this.el("product-notice").hidden) return;
    this.text("notice-copy", explanation);
    const last = this.#messages.at(-1);
    if (last?.role === "assistant" && last.state) { last.text = explanation; this.renderMessages(); this.persist(); }
  }
  recovery(needed: boolean): void { this.#recovering = needed; this.el("recovery").hidden = !needed; if (needed) { this.showStep(3, false); this.#progress = 0; this.text("progress-title", "Your last request needs checking."); this.el("build-progress").setAttribute("aria-valuenow", "0"); this.el("build-progress").setAttribute("aria-valuetext", "Outcome unconfirmed"); this.el("progress-fill").style.width = "0%"; this.text("progress-detail", "The previous request has not been confirmed. Your saved preview remains available."); this.previewStatus({state:"uncertain",current:"",detail:"",elapsed:0,stale:false}, "Your last request needs checking", ""); } this.syncControls(); }
  onRestoreVersion(restore: (version: WorkspaceVersion) => Promise<void>): void { this.#restoreVersion = restore; }
  versions(versions: readonly WorkspaceVersion[], selected: WorkspaceVersion | undefined, change: (version: WorkspaceVersion) => Promise<unknown>, current = versions.at(-1)): void {
    this.#changeVersion = change;
    const picker = this.el<HTMLSelectElement>("version-picker");
    picker.replaceChildren(...versions.map(version => new Option(`Version ${version.version}${version.artifactId === current?.artifactId ? " · current" : ""}`, version.artifactId)));
    if (!versions.length) picker.add(new Option("No version yet", ""));
    if (selected) picker.value = selected.artifactId;
    const viewingOther = !!selected && !!current && selected.artifactId !== current.artifactId;
    this.el("old-version-note").hidden = !viewingOther;
    this.el("revision-selection").hidden = !viewingOther;
    this.text("revision-selection-title", `Viewing version ${selected?.version} · Current is version ${current?.version}`);
    this.text("revision-count", `${versions.length}`);
    this.el("revision-history").hidden = !versions.length;
    this.el("revision-history-list").replaceChildren(...[...versions].reverse().map(version => {
      const item = document.createElement("li"); const label = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = `Version ${version.version}`;
      const badge = document.createElement("span"); badge.className = "revision-badge";
      badge.textContent = version.artifactId === current?.artifactId ? "Current" : "Saved";
      const button = document.createElement("button"); button.className = "quiet";
      button.dataset.previewRevision = version.artifactId;
      button.textContent = version.artifactId === selected?.artifactId ? "Viewing" : "View";
      button.setAttribute("aria-label", `View version ${version.version}`);
      button.setAttribute("aria-pressed", String(version.artifactId === selected?.artifactId));
      button.onclick = () => { void this.switchVersion(version); };
      label.append(title, badge); item.append(label, button); return item;
    }));
    picker.onchange = () => { const version = versions.find(v => v.artifactId === picker.value); if (version) void this.switchVersion(version); };
    for (const id of ["return-latest", "return-current"]) this.el<HTMLButtonElement>(id).onclick = () => { if (current) void this.switchVersion(current); };
    this.el<HTMLButtonElement>("restore-version").onclick = () => { if (selected && viewingOther) void this.restoreVersion(selected); };
    this.syncControls();
  }
  private async restoreVersion(version: WorkspaceVersion): Promise<void> {
    if (!this.#restoreVersion || this.#restoringVersion || this.#running || this.#recovering || this.#sessionBlocked) return;
    this.#restoringVersion = true; this.text("restore-status", `Restoring version ${version.version}…`); this.el("restore-status").hidden = false; this.syncControls();
    try {
      await this.#restoreVersion(version);
      this.text("restore-status", `Version ${version.version} is current. Your next edit starts here. No charge.`);
    } catch (error) {
      this.text("restore-status", error instanceof Error ? error.message : "Could not restore this version. Try again.");
    } finally { this.#restoringVersion = false; this.syncControls(); }
  }
  private async switchVersion(version: WorkspaceVersion): Promise<void> {
    if (this.#selectingVersion || this.#restoringVersion || this.#running) return;
    this.#selectingVersion = true; this.syncControls();
    try { await this.#changeVersion?.(version); } finally { this.#selectingVersion = false; this.syncControls(); }
  }
  sessionState(state: string): void {
    const wasBlocked = this.#sessionBlocked;
    this.#sessionState = state; this.#sessionBlocked = !["verified", "failed"].includes(state);
    if (wasBlocked && !this.#sessionBlocked) this.el("product-notice").hidden = true;
    if (["usage_unknown", "billing_invariant_failed"].includes(state)) {
      this.el("product-notice").hidden = false; this.el("review-request").hidden = true;
      this.text("notice-heading", "This session needs a confirmed outcome");
      this.text("notice-copy", "Your last verified preview is available, but the latest request still needs usage reconciliation. This session can’t accept another revision yet. You can start a new applet as a separate explicit request.");
      this.#progress = 0; this.progress({ state: "uncertain", current: "", detail: "", elapsed: 0, stale: false }); this.text("progress-time", "Saved session");
    }
    this.syncControls();
  }
  selected(version: WorkspaceVersion): void { this.#version = version; this.el("preview-empty").hidden = true; this.el("preview-verified").hidden = false; this.previewStatusPlacement(); this.text("preview-caption", `Version ${version.version} · ready to explore`); }
  get checkingSession(): boolean { return this.#checkingSession || this.#restoringVersion; }
  onSessionStatusCheck(check: () => Promise<void>): void { this.#checkSession = check; }
  private async checkSession(): Promise<void> {
    if (!this.#checkSession || this.#checkingSession || this.#running || this.#recovering) return;
    this.#checkingSession = true; this.text("revision-status-result", ""); this.syncControls();
    try {
      await this.#checkSession();
      this.text("revision-status-result", this.#sessionBlocked ? "Status checked. This session is still waiting; no generation was started." : "Session status refreshed. No generation was started.");
    } catch {
      this.text("revision-status-result", "Couldn’t check this session. Check your connection and original signing identity, then try again. Your draft is saved.");
    } finally { this.#checkingSession = false; this.syncControls(); }
  }
  private revisionAvailability(): void {
    let reason = ""; let label = ""; let help: (() => void) | undefined;
    const check = () => { label = "Check status"; help = () => { void this.checkSession(); }; };
    if (!this.#connected) {
      reason = this.#connectionChecked ? "The CVM connection is unavailable. Reconnect before sending your revision." : "Connecting to your workspace…";
      if (this.#connectionChecked) { label = "Open connection settings"; help = () => this.el<HTMLButtonElement>("open-settings").click(); }
    } else if (this.#running) {
      reason = "Your current request is still running. Wait for it to finish before sending another revision.";
      label = "View progress"; help = () => this.el("product-progress").scrollIntoView({ block: "center" });
    } else if (this.#restoringVersion) reason = "Restoring the selected version…";
    else if (this.#checkingSession) reason = "Checking the saved session status…";
    else if (this.#recovering) {
      reason = "Your previous request has no confirmed result. Check the original request before sending another revision.";
      label = "Check previous request"; help = () => this.el<HTMLButtonElement>("recover").click();
    } else if (this.#sessionBlocked) {
      reason = this.#sessionState === "usage_unknown"
        ? "The connection ended before we received a complete result. Check the saved request to recover it and continue. Your draft and verified preview are saved."
        : this.#sessionState === "billing_invariant_failed"
          ? "The last request has an accounting problem. The CVM operator must resolve it before revisions can continue. Your draft and verified preview are saved."
          : this.#sessionState === "active"
            ? "This applet is still processing a request. Check its status before sending another revision."
            : this.#sessionState === "needs_top_up"
              ? "This applet is waiting for funds. Resume the saved action before sending another revision."
              : this.#sessionState === "expired"
                ? "This session has expired and can’t accept revisions. Your draft is saved; you can start a new applet."
                : "This session isn’t ready for another revision. Check its status before sending.";
      if (this.#sessionState === "needs_top_up" && !this.el("continuation").hidden) {
        label = "Resume saved action"; help = () => this.el<HTMLButtonElement>("resume").click();
      } else if (this.#sessionState === "expired") { label = "New applet"; help = () => this.el<HTMLButtonElement>("new-applet").click(); }
      else check();
    } else if (this.#selectingVersion) reason = "Opening the selected preview version…";
    else if (!this.#version) {
      if (this.el<HTMLSelectElement>("version-picker").value) { reason = "A verified version is ready. Open it before sending a revision."; label = "Open current version"; help = () => this.el<HTMLButtonElement>("return-latest").click(); }
      else reason = "Your first verified preview must be ready before you can send a revision.";
    }
    else if (!this.el("old-version-note").hidden) {
      reason = "Restore the version you’re viewing, or return to current to send your change.";
      label = "Return to current version"; help = () => this.el<HTMLButtonElement>("return-latest").click();
    } else if (!this.field("revision").value.trim()) reason = "Describe what you’d like to change to enable Send.";
    const button = this.el<HTMLButtonElement>("revise"); button.disabled = !!reason; button.title = reason || "Send revision";
    this.el("revision-availability").hidden = !reason; this.text("revision-blocked-reason", reason);
    this.el("revision-availability").dataset.attention = String(this.#sessionBlocked || this.#recovering || (!this.#connected && this.#connectionChecked));
    this.text("revision-hint", reason ? (this.field("revision").value.trim() ? "Draft saved in this tab" : "") : "⌘ / Ctrl + Enter to send");
    this.#revisionHelp = help; this.el("revision-help").hidden = !help; this.text("revision-help", label);
    this.el("revision-status-result").hidden = !this.el("revision-status-result").textContent;
  }
  private navigation(): void {
    const collection = location.hash === "#/applets"; const exploring = location.hash === "#/explore";
    const workspace = this.el("workspace-home"); const projects = this.el("your-applets");
    for (const [link, active] of [[workspace, !collection && !exploring], [projects, collection]] as const) {
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    const label = this.#step === 4 ? "Publish" : this.#step === 3 ? "Builder" : "Create";
    this.text("workspace-nav-label", label);
    workspace.setAttribute("aria-label", `${collection ? "Return to " : ""}${label.toLowerCase()} workspace${this.#running ? " · request in progress" : ""}`);
    this.el("workspace-nav-status").hidden = !this.#running;
    this.root.dataset.context = collection ? "collection" : label.toLowerCase();
  }
  private syncControls(): void {
    this.navigation();
    this.el("revise-estimates").hidden = !this.#version;
    const picker = this.el<HTMLSelectElement>("version-picker"); picker.disabled = this.#running || this.#selectingVersion || this.#restoringVersion || this.#checkingSession || !picker.value;
    this.el<HTMLButtonElement>("generate").disabled = !this.#connected || this.#running || this.#recovering || this.#checkingSession || this.#restoringVersion;
    this.el<HTMLButtonElement>("restore-version").disabled = !this.#connected || !this.#restoreVersion || this.#running || this.#selectingVersion || this.#restoringVersion || this.#checkingSession || this.#recovering || this.#sessionBlocked;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-preview-revision], #return-current, #return-latest")) button.disabled = this.#running || this.#selectingVersion || this.#restoringVersion || this.#checkingSession;
    this.revisionAvailability();
    this.el<HTMLTextAreaElement>("revision").disabled = this.#running || this.#restoringVersion || !this.#version || !this.el("old-version-note").hidden;
    this.el<HTMLButtonElement>("recover").disabled = !this.#connected || this.#running || this.#checkingSession;
    this.el<HTMLButtonElement>("resume").disabled = !this.#connected || this.#running || this.#recovering || this.#checkingSession || this.#restoringVersion;
    this.el<HTMLButtonElement>("new-applet").disabled = this.#running || this.#recovering || this.#checkingSession || this.#restoringVersion;
    this.el<HTMLButtonElement>("open-settings").disabled = false;
  }
  private addMessage(message: Message): void { this.#messages.push(message); if (this.#pendingFrom !== undefined) this.#pendingFrom = Math.max(0,this.#pendingFrom - Math.max(0,this.#messages.length - 60)); this.#messages = this.#messages.slice(-60); this.renderMessages(); this.persist(); }
  private renderMessages(scroll = true): void {
    const list = this.el("conversation-messages");
    const messages = this.#costs ? (this.#pendingFrom === undefined ? [] : this.#messages.slice(this.#pendingFrom)) : this.#messages;
    const receipts = this.#costs ? [...this.#costs.requests].sort((a,b) => a.number - b.number).map(requestCostElement) : [];
    const open = new Set([...list.querySelectorAll<HTMLDetailsElement>(".request-cost-details[open]")].map(el => el.closest<HTMLElement>("[data-request-id]")!.dataset.requestId));
    for (const receipt of receipts) if (open.has(receipt.dataset.requestId)) receipt.querySelector("details")!.open = true;
    list.replaceChildren(...receipts,...messages.map((message) => { const item = document.createElement("li"); item.className = `message ${message.role}`; if (message.state) item.dataset.state = message.state; const label = document.createElement("span"); label.className = "message-author"; label.textContent = message.role === "user" ? "You" : "applet.broker"; const body = document.createElement("p"); body.textContent = message.text; item.append(label, body); const cost = document.createElement("p"); cost.className = "request-note"; cost.textContent = message.role === "user" ? "Cost awaits confirmation" : "Cost included with your request"; item.append(cost); return item; }));
    if (scroll) list.scrollTop = list.scrollHeight;
  }
}
