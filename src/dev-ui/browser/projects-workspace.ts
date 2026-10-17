import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { browserSignerKey, DevelopmentContextVmClient, type DevelopmentBootstrap } from "./contextvm-client";
import type { PublishingIdentity } from "./nostr-identity";

export type Project = { id: string; title: string; sessionId: string | null; checkpointId: string | null; stage: string; verifiedVersion: number; createdAt: string; publication?: { id: string; version: number; publisher: string; publishedAt?: string; eventId: string } | null; unpublishedChanges?: boolean };
export type ProjectScope = "account" | "browser";
type Source = { scope: ProjectScope; client?: DevelopmentContextVmClient; ready?: Promise<unknown>; projects: Project[]; after?: string; pages: number; error?: string };
const stages: Record<string, string> = { pending: "Waiting to start", active: "Building", verified: "Ready", published: "Published", failed: "Needs changes", unconfirmed: "Needs checking", expired: "Expired" };

/** A static hash route. Each source proves ownership with its own signed CVM request. */
export class ProjectsWorkspace {
  #page = document.createElement("section");
  #epoch = 0;
  #sources: Source[] = [];
  #loading = false;
  #opening = false;
  #browserPubkey: Promise<string>;
  constructor(private bootstrap: DevelopmentBootstrap, private identity: PublishingIdentity, private busy: () => boolean, private openProject: (project: Project, scope: ProjectScope) => Promise<void>) {
    this.#browserPubkey = new PrivateKeySigner(browserSignerKey(bootstrap.servicePubkey)).getPublicKey();
    const workspace = document.getElementById("creation-workspace")!;
    this.#page.id = "projects-page"; this.#page.hidden = true; this.#page.setAttribute("aria-labelledby", "projects-heading");
    this.#page.innerHTML = `<div class="projects-heading-row"><div><div class="eyebrow">YOUR COLLECTION</div><h1 id="projects-heading" tabindex="-1">Your applets</h1><p class="intro-copy">Little things you’re making. All in one place.</p></div><button id="projects-new" class="primary">New applet <span aria-hidden="true">+</span></button></div>
      <div class="projects-navigation"><a id="projects-workspace" href="#/workspace">← Return to workspace</a><span id="projects-live" class="supporting"></span></div>
      <div class="projects-toolbar"><div><label for="projects-stage">Show</label><select id="projects-stage"><option value="">All stages</option><option value="pending">Waiting to start</option><option value="active">Building</option><option value="verified">Ready</option><option value="published">Published</option><option value="failed">Needs changes</option><option value="unconfirmed">Needs checking</option><option value="expired">Expired</option></select></div><button id="projects-refresh" class="quiet">Refresh</button></div>
      <p id="projects-status" class="supporting" role="status"></p><p id="projects-error" class="form-error" role="alert"></p>
      <div id="projects-empty" class="projects-empty" hidden><span class="small-mark" aria-hidden="true">a·</span><h2>A home for your little ideas.</h2><p id="projects-empty-copy">Create your first applet and it will appear here as it builds.</p></div>
      <ul id="projects-list"></ul><button id="projects-more" hidden>Show more</button>
      <aside class="projects-identity-note"><p id="projects-identity-copy"></p><button id="projects-sign-in" class="text-button">Sign in to find your applets →</button></aside>`;
    workspace.after(this.#page);
    this.el("projects-new").onclick = () => { if (this.busy()) return; document.getElementById("new-applet")!.click(); location.hash = "/workspace"; };
    this.el("projects-sign-in").onclick = () => document.getElementById("nostr-sign-in")!.click();
    this.el("projects-refresh").onclick = () => { this.resetSources(); void this.load(); };
    this.el("projects-stage").onchange = () => { for (const source of this.#sources) { source.pages = 1; source.projects = []; source.after = undefined; } this.render(); void this.load(); };
    this.el("projects-more").onclick = () => { void this.load(true); };
    const skip = document.querySelector<HTMLAnchorElement>(".skip-link")!;
    skip.onclick = event => { event.preventDefault(); document.querySelector<HTMLElement>(skip.getAttribute("href")!)?.focus(); };
    document.querySelector<HTMLAnchorElement>(".brand")!.href = "#/workspace";
    const route = (focus = true) => {
      const visible = location.hash === "#/applets";
      workspace.hidden = visible || location.hash === "#/explore"; this.#page.hidden = !visible;
      const heading = visible ? this.el("projects-heading") : workspace.querySelector<HTMLElement>(".step-panel:not([hidden]) h1");
      skip.href = `#${heading?.id ?? "step-heading"}`;
      document.title = visible ? "Your applets — applet.broker" : "applet.broker — Make a little thing";
      if (focus && location.hash !== "#/explore") { heading?.focus({ preventScroll: true }); document.getElementById("app-content")!.scrollTo(0, 0); }
      if (visible) { this.identityNote(); void this.load(); } else this.resetSources();
    };
    window.addEventListener("hashchange", () => route());
    identity.onChange(() => { this.resetSources(); this.el("projects-list").replaceChildren(); this.el("projects-error").textContent = ""; this.identityNote(); if (!this.#page.hidden) void this.load(); });
    setInterval(() => {
      if (this.#page.hidden || document.hidden || this.#loading || this.#opening) return;
      this.liveStatus();
      // Keep keyboard focus stable while someone is choosing an applet.
      if (!document.activeElement?.closest(".project-card")) void this.load(false, true);
    }, 5000);
    queueMicrotask(() => route(false));
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.#page.querySelector<T>(`#${id}`)!; }
  private resetSources() {
    ++this.#epoch; this.#loading = false;
    for (const source of this.#sources) void source.client?.close();
    this.#sources = [];
  }
  private identityNote() {
    this.el("projects-identity-copy").textContent = this.identity.pubkey
      ? "Your account’s applets appear alongside earlier work from this browser. Browser applets stay with this tab’s original identity."
      : "Applets made in this browser are available here. Sign in to also find applets made with your Nostr account on other devices.";
    this.el("projects-sign-in").hidden = !!this.identity.pubkey;
  }
  private liveStatus() {
    this.el("projects-live").textContent = this.busy() ? "Your current request continues in the workspace." : "Status updates automatically.";
    this.el<HTMLButtonElement>("projects-new").disabled = this.busy();
  }
  private async load(more = false, quiet = false) {
    const epoch = ++this.#epoch; this.#loading = true; this.liveStatus();
    if (!quiet) this.el("projects-status").textContent = "Loading your applets…";
    this.el<HTMLButtonElement>("projects-more").disabled = true;
    this.el<HTMLButtonElement>("projects-refresh").disabled = true;
    try {
      const browserPubkey = await this.#browserPubkey;
      if (epoch !== this.#epoch) return;
      if (!this.#sources.length) {
        const browser: Source = { scope: "browser", client: new DevelopmentContextVmClient(this.bootstrap), projects: [], pages: 1 };
        this.#sources = [browser];
        if (this.identity.pubkey && this.identity.pubkey !== browserPubkey) {
          const account: Source = { scope: "account", projects: [], pages: 1 };
          try { account.client = new DevelopmentContextVmClient(this.bootstrap, undefined, this.identity.captureSigner()); }
          catch (error) { account.error = error instanceof Error ? error.message : "Sign in again to load your account’s applets."; }
          this.#sources.unshift(account);
        }
      }
      const stage = this.el<HTMLSelectElement>("projects-stage").value;
      // Independent authenticated sources: failure of one never conceals the other.
      await Promise.all(this.#sources.map(async source => {
        if (!source.client || (more && !source.after)) return;
        try {
          source.ready ??= source.client.connect({ accountStatus: false }); await source.ready;
          let after = more ? source.after : undefined;
          const projects = more ? [...source.projects] : [];
          const pages = more ? 1 : source.pages;
          for (let page = 0; page < pages; page++) {
            if (epoch !== this.#epoch) return;
            const result = await source.client.callTool("projects", { action: "list", ...(stage ? { stage } : {}), ...(after ? { after } : {}) });
            if (epoch !== this.#epoch) return;
            if (result.status !== "ok") throw new Error("Could not load applets. Refresh to try again.");
            projects.push(...result.projects as Project[]); after = result.nextCursor ?? undefined;
            if (!after) break;
          }
          source.projects = [...new Map(projects.map(project => [project.id, project])).values()]; source.after = after;
          if (more) source.pages++; source.error = undefined;
        } catch (error) { if (epoch === this.#epoch) source.error = error instanceof Error ? error.message : "Could not load applets. Refresh to try again."; }
      }));
      if (epoch !== this.#epoch) return;
      this.render();
    } finally {
      if (epoch === this.#epoch) { this.#loading = false; this.el<HTMLButtonElement>("projects-more").disabled = false; this.el<HTMLButtonElement>("projects-refresh").disabled = false; }
    }
  }
  private render() {
    const entries = this.#sources.flatMap(source => source.projects.map(project => ({ source, project }))).sort((a, b) => b.project.createdAt.localeCompare(a.project.createdAt) || b.project.id.localeCompare(a.project.id));
    const list = this.el("projects-list"); list.replaceChildren();
    for (const { source, project } of entries) {
      const li = document.createElement("li"); const button = document.createElement("button"); button.className = "project-card"; button.dataset.projectId = project.id;
      const badge = document.createElement("span"); badge.className = "project-stage"; badge.dataset.stage = project.stage; badge.textContent = project.unpublishedChanges && project.stage === "verified" ? "Unpublished changes" : stages[project.stage] ?? project.stage;
      const title = document.createElement("strong"); title.textContent = project.title; title.title = project.title;
      const detail = document.createElement("span"); detail.className = "project-detail"; detail.textContent = `${source.scope === "browser" ? "This browser" : "Your account"} · ${new Date(project.createdAt).toLocaleDateString()}${project.verifiedVersion ? ` · Version ${project.verifiedVersion}` : ""}`;
      const open = document.createElement("span"); open.className = "project-open"; open.textContent = "Open applet →";
      button.append(badge, title, detail, open);
      if (project.publication) { const published = document.createElement("span"); published.className = "project-publication"; published.textContent = `Published · Version ${project.publication.version}${project.unpublishedChanges ? ` · Version ${project.verifiedVersion} ready to publish` : ""}`; detail.after(published); }
      button.onclick = async () => {
        if (!this.#sources.includes(source) || this.#opening) return;
        const epoch = this.#epoch;
        if (this.busy()) { this.el("projects-status").textContent = "Your current request is still open. Return to the workspace to follow it before opening another applet."; return; }
        this.#opening = true; button.disabled = true;
        try { await this.openProject(project, source.scope); if (epoch === this.#epoch) location.hash = "/workspace"; }
        catch (error) { if (epoch === this.#epoch) this.el("projects-error").textContent = error instanceof Error ? error.message : "Applet unavailable"; }
        finally { this.#opening = false; button.disabled = false; }
      };
      li.append(button); list.append(li);
    }
    const errors = this.#sources.filter(source => source.error).map(source => `${source.scope === "browser" ? "This browser" : "Your account"}: ${source.error}`);
    this.el("projects-error").textContent = errors.join(" ");
    this.el("projects-more").hidden = !this.#sources.some(source => source.after);
    this.el("projects-empty").hidden = !!entries.length || !!errors.length;
    this.el("projects-empty-copy").textContent = this.el<HTMLSelectElement>("projects-stage").value ? "No applets at this stage. Try All stages to see the rest." : "Create your first applet and it will appear here as it builds.";
    this.el("projects-status").textContent = entries.length ? `${entries.length} applet${entries.length === 1 ? "" : "s"}${errors.length ? " loaded · some applets could not be checked" : " · Up to date"}` : errors.length ? "Some applets could not be checked." : "You’re all caught up.";
  }
}
