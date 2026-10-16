import { DevelopmentContextVmClient, type DevelopmentBootstrap } from "./contextvm-client";
import type { PublishingIdentity } from "./nostr-identity";
export type Project = { id: string; title: string; sessionId: string | null; checkpointId: string | null; stage: string; verifiedVersion: number; createdAt: string };

export class ProjectsWorkspace {
  #dialog = document.createElement("dialog");
  #epoch = 0;
  #client?: DevelopmentContextVmClient;
  #after?: string;
  constructor(private bootstrap: DevelopmentBootstrap, private identity: PublishingIdentity, private busy: () => boolean, private openProject: (project: Project) => Promise<void>) {
    const button = document.createElement("button"); button.id = "your-applets"; button.className = "quiet"; button.textContent = "Your applets";
    document.querySelector(".header-actions")!.append(button);
    this.#dialog.id = "projects-dialog"; this.#dialog.setAttribute("aria-labelledby", "projects-heading");
    this.#dialog.innerHTML = `<div class="dialog-header"><h2 id="projects-heading">Your applets</h2><button id="projects-close" class="icon-button" aria-label="Close your applets">×</button></div><p id="projects-status" role="status"></p><div class="row"><label for="projects-stage">Show</label><select id="projects-stage"><option value="">All stages</option><option value="pending">Pending</option><option value="active">Building</option><option value="verified">Ready</option><option value="published">Published</option><option value="failed">Needs changes</option><option value="unconfirmed">Needs checking</option><option value="expired">Expired</option></select><button id="projects-refresh">Refresh</button></div><ul id="projects-list"></ul><button id="projects-more" hidden>Show more</button>`;
    document.body.append(this.#dialog);
    button.onclick = () => { this.#dialog.showModal(); void this.load(); };
    this.el("projects-close").onclick = () => this.#dialog.close();
    this.el("projects-refresh").onclick = () => { void this.load(); };
    this.el("projects-stage").onchange = () => { void this.load(); };
    this.el("projects-more").onclick = () => { void this.load(true); };
    const changed = () => { ++this.#epoch; void this.#client?.close(); this.#client = undefined; this.el("projects-list").replaceChildren(); this.#dialog.close(); button.disabled = !identity.pubkey; button.title = identity.pubkey ? "Projects belonging to your signed Nostr requests" : "Sign in to see your applets"; };
    identity.onChange(changed); changed();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.#dialog.querySelector<T>(`#${id}`)!; }
  private async load(more = false) {
    const epoch = ++this.#epoch;
    this.el("projects-status").textContent = "Confirming your identity with the CVM…";
    this.el<HTMLButtonElement>("projects-more").disabled = true;
    try {
      if (!this.#client) { this.#client = new DevelopmentContextVmClient(this.bootstrap, undefined, this.identity.captureSigner()); await this.#client.connect({ accountStatus: false }); }
      if (epoch !== this.#epoch) return;
      const stage = this.el<HTMLSelectElement>("projects-stage").value;
      const result = await this.#client.callTool("projects", { action: "list", ...(stage ? { stage } : {}), ...(more && this.#after ? { after: this.#after } : {}) });
      if (epoch !== this.#epoch) return;
      if (result.status !== "ok") throw new Error("Your applets could not be loaded. Refresh to try again.");
      if (!more) this.el("projects-list").replaceChildren();
      for (const project of result.projects as Project[]) {
        const li = document.createElement("li"); const button = document.createElement("button"); button.className = "project-card";
        const title = document.createElement("strong"); title.textContent = project.title;
        const detail = document.createElement("span"); detail.textContent = `${({ active: "Building", verified: "Ready", unconfirmed: "Needs checking" } as Record<string,string>)[project.stage] ?? project.stage} · ${new Date(project.createdAt).toLocaleDateString()}${project.verifiedVersion ? ` · version ${project.verifiedVersion}` : ""}`;
        button.append(title, detail); button.onclick = async () => {
          if (this.busy()) { this.el("projects-status").textContent = "Your build is still running. You can open another applet when it finishes."; return; }
          button.disabled = true;
          try { await this.openProject(project); if (epoch === this.#epoch) this.#dialog.close(); }
          catch (error) { if (epoch === this.#epoch) this.el("projects-status").textContent = error instanceof Error ? error.message : "Applet unavailable"; }
          finally { button.disabled = false; }
        }; li.append(button); this.el("projects-list").append(li);
      }
      this.#after = result.nextCursor ?? undefined; this.el("projects-more").hidden = !this.#after;
      this.el("projects-status").textContent = this.el("projects-list").children.length ? "Only applets belonging to your confirmed identity are shown." : "No applets here yet. New builds use your selected identity. Earlier anonymous builds stay with their original browser key.";
    } catch (error) { if (epoch === this.#epoch) this.el("projects-status").textContent = error instanceof Error ? error.message : "Your applets could not be loaded."; }
    finally { if (epoch === this.#epoch) this.el<HTMLButtonElement>("projects-more").disabled = false; }
  }
}
