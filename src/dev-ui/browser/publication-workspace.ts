import { DestinationInput } from "./destination-input";
import { discoverWriteRelays, suggestRelays } from "./relay-discovery";
import { relayUrl } from "../destinations";
import type { Event, EventTemplate } from "nostr-tools/pure";
import type { DevelopmentBootstrap, DevelopmentContextVmClient } from "./contextvm-client";
import { PublishingIdentity } from "./nostr-identity";
import { blossomServer, discoverBlossom, propagateBlobs, type BlobFile, type Propagation } from "./blossom-client";
type Version = { sessionId: string; artifactId: string; version: number };
type Publication = { id: string; status: string; artifactId: string; publisher: string; template: EventTemplate; files: BlobFile[]; servers: string[]; relays: string[]; relayResults?: { relay: string; state: string; detail?: string }[]; fileResults?: Propagation[]; signedEvent?: Event; publishedAt?: string; title?: string; address?: string; url?: string; version: number; expiresAt: number };
type Journal = { prepared: Publication; event?: Event; propagated?: boolean };
export class PublicationWorkspace {
  readonly identity: PublishingIdentity;
  readonly #panel: HTMLElement;
  readonly #servers: DestinationInput;
  readonly #relays: DestinationInput;
  #busy = false;
  #journal?: Journal;
  #opening = 0;
  #preview?: Publication;
  #previewArtifact?: string;
  #current?: Publication;
  #latest?: Publication;
  #lookupEpoch = 0;
  #lookupError = false;
  #propagation = new Map<string, Propagation>();
  get running() { return this.#busy; }
  constructor(private readonly bootstrap: DevelopmentBootstrap, private readonly client: () => DevelopmentContextVmClient | undefined, private readonly selected: () => Version | undefined) {
    const button = document.createElement("button"); button.id = "publish"; button.className = "primary"; button.textContent = "Publish"; button.disabled = true; const footer = document.createElement("div"); footer.className = "publish-next"; const hint = document.createElement("p"); hint.id = "publish-hint"; hint.className = "supporting"; footer.append(hint,button); document.querySelector("#build-step")!.append(footer);
    const publishedCopy = document.createElement("button"); publishedCopy.id = "published-copy-address"; publishedCopy.className = "quiet"; publishedCopy.textContent = "Copy published naddr"; publishedCopy.hidden = true; footer.append(publishedCopy);
    publishedCopy.onclick = () => { if (this.#current?.address) void this.copy(this.#current.address, hint); };
    this.identity = new PublishingIdentity(bootstrap.servicePubkey, () => { this.#opening++; ++this.#lookupEpoch; this.#current = this.#latest = undefined; if (!this.#busy) this.#journal = undefined; this.sync(); void this.lookup().catch(() => undefined); });
    this.#panel = document.createElement("section"); this.#panel.id = "publish-step"; this.#panel.hidden = true; this.#panel.className = "step-panel publication-step"; this.#panel.setAttribute("aria-labelledby", "publication-heading");
    this.#panel.innerHTML = `<button id="publication-close" class="text-button">← Back to your applet</button><header class="publication-heading"><span class="small-mark" aria-hidden="true">a·</span><div><div class="eyebrow">THE FINAL STEP</div><h1 id="publication-heading" tabindex="-1">Ready for the world.</h1><p id="publication-version" class="supporting"></p></div></header><p id="publication-history" class="supporting" hidden></p>
      <form id="publication-prepare"><label for="publication-title">Applet name</label><input id="publication-title" maxlength="120" value="My applet" required><p id="publication-discovery" role="status"></p><div id="publication-server-editor"></div><p class="supporting">We’ll copy your applet to these Blossom servers after you approve its signature.</p><p id="publication-relay-discovery" role="status"></p><div id="publication-relay-editor"></div><p id="publication-relay-hint" class="supporting">Relays make your applet discoverable in other shells. Suggestions come from recent NIP-66 monitor reports and are optional.</p><button id="publication-review" class="primary">Review publication</button></form>
      <section id="publication-review-panel" hidden><p id="publication-review-copy"></p><details><summary>Permissions and destinations</summary><p id="publication-capabilities"></p><ul id="publication-destinations"></ul></details><button id="publication-confirm" class="primary">Sign and publish</button><button id="publication-edit">Edit destinations</button></section>
      <ol class="publication-stages" aria-label="Publication progress"><li id="publication-signing">Sign your applet</li><li id="publication-propagating">Copy to your servers</li><li id="publication-announcing">Publish to Nostr</li></ol><p id="publication-status" role="status" aria-live="polite"></p><details id="publication-receipts" hidden><summary>Destination details</summary><ul id="publication-files" aria-label="File propagation progress"></ul><ul id="publication-relay-results" aria-label="Relay publication progress"></ul></details><button id="publication-check" hidden>Check publication</button>
      <div id="publication-result" hidden><span class="publication-success" aria-hidden="true">✓</span><h2>Your applet is published.</h2><p id="publication-completion" class="supporting"></p><label for="publication-address">Your applet’s address</label><input id="publication-address" readonly><p class="supporting">Copy this address into another compatible shell to open your applet.</p><div class="publication-actions"><button id="publication-copy" class="primary">Copy naddr</button><a id="publication-open" class="quiet" target="_blank" rel="noopener noreferrer">Open applet ↗</a><a href="#/applets">Your applets →</a></div></div>`;
    document.querySelector("#build-step")!.after(this.#panel);
    this.#servers = new DestinationInput(this.el("publication-server-editor"), "publication-servers", "Blossom servers", "https://blossom.example.com", blossomServer);
    this.#relays = new DestinationInput(this.el("publication-relay-editor"), "publication-relays", "Publishing relays", "wss://relay.example.com", relayUrl);
    const previewShare = document.createElement("div"); previewShare.className = "preview-sharing";
    previewShare.innerHTML = `<span id="preview-share-status" role="status">A shareable CVM preview appears after verification.</span><button id="preview-copy-address" disabled>Copy preview naddr</button>`;
    document.querySelector(".preview-panel")!.append(previewShare);
    button.onclick = () => { void this.open().catch(error => this.error(error)); };
    this.el("publication-close").onclick = () => document.dispatchEvent(new CustomEvent("applet:step", { detail: 3 }));
    this.el<HTMLFormElement>("publication-prepare").onsubmit = event => { event.preventDefault(); void this.prepare().catch(error => this.error(error)); };
    this.el("publication-confirm").onclick = () => { void this.publish().catch(error => this.error(error)); };
    this.el("publication-edit").onclick = () => { if (this.#busy || this.#journal?.event) return; this.#journal = undefined; this.el("publication-prepare").hidden = false; this.el("publication-review-panel").hidden = true; };
    this.el("publication-check").onclick = () => { void (this.#journal ? this.check() : this.open()).catch(error => this.error(error)); };
    document.getElementById("preview-copy-address")!.onclick = () => { if (this.#preview?.address) void this.copy(this.#preview.address, document.getElementById("preview-share-status")!); };
    this.el("publication-copy").onclick = () => { if (this.#journal?.prepared.address) void this.copy(this.#journal.prepared.address, this.el("publication-status")); };
    this.sync();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.#panel.querySelector<T>(`#${id}`)!; }
  private key(version: Version, publisher = this.identity.pubkey) { return `applet-broker/publication/v1/${this.bootstrap.servicePubkey}/${version.artifactId}/${publisher}`; }
  private save() { if (this.#journal) { try { sessionStorage.setItem(this.key({ artifactId: this.#journal.prepared.artifactId } as Version, this.#journal.prepared.publisher), JSON.stringify(this.#journal)); } catch { /* Durable CVM state is authoritative; browser storage is optional. */ } } }
  private async call(input: unknown): Promise<any> { if (!this.client()) throw new Error("Connect to the CVM first."); const result = await this.client()!.callTool("development_publication", input); if (["denied", "rejected", "expired"].includes(result?.status)) throw new Error(result.code ?? `Publication ${result.status}`); return result; }
  sync(): void {
    if (this.#current && (this.#current.artifactId !== this.selected()?.artifactId || this.#current.publisher !== this.identity?.pubkey)) this.#current = undefined;
    const button = document.getElementById("publish") as HTMLButtonElement;
    button.disabled = !this.identity?.pubkey || !this.selected() || !this.client() || this.#busy;
    const published = this.#current?.status === "published";
    const changes = this.#latest && this.selected() && this.#latest.version < this.selected()!.version;
    document.getElementById("publish-hint")!.textContent = !this.identity?.pubkey ? "Sign in to publish this applet under your Nostr identity." : !this.selected() ? "Publishing opens after this applet passes its checks." : published ? `Published · Version ${this.selected()!.version} · Ready to share` : this.#lookupError ? "Publication status could not be checked. Open publishing to try again." : changes ? `Unpublished changes · Version ${this.#latest!.version} is published. Version ${this.selected()!.version} is ready.` : this.#current?.signedEvent ? "Publication in progress · Your signature is saved. Continue the remaining steps." : `Ready to share version ${this.selected()!.version}?`;
    button.textContent = published ? "View publication" : this.#current?.signedEvent ? "Continue publishing" : "Publish";
    document.getElementById("published-copy-address")!.hidden = !published || !this.#current?.address;
    button.title = !this.identity?.pubkey ? "Sign in to publish" : !this.selected() ? "A verified applet is needed before publication" : "Publish this version under your identity";
  }
  private async lookup(): Promise<Publication | undefined> {
    const version = this.selected(); const publisher = this.identity?.pubkey; const client = this.client();
    if (!version || !publisher || !client) return;
    const epoch = ++this.#lookupEpoch;
    try {
      const result = await this.call({ action: "lookup", sessionId: version.sessionId, artifactId: version.artifactId, publisher });
      if (epoch !== this.#lookupEpoch || client !== this.client() || version.artifactId !== this.selected()?.artifactId || publisher !== this.identity.pubkey) return;
      if (result.status !== "ok") throw new Error("Could not check publication history. Try again before publishing.");
      this.#lookupError = false; this.#current = result.current ?? undefined; this.#latest = result.latestPublished ?? undefined; this.sync(); return this.#current;
    } catch (error) { if (epoch === this.#lookupEpoch) { this.#lookupError = true; this.sync(); } throw error; }
  }
  async version(): Promise<void> {
    this.sync(); void this.lookup().catch(() => undefined); const version = this.selected(); if (!version || version.artifactId === this.#previewArtifact) return;
    this.#previewArtifact = version.artifactId; this.#preview = undefined;
    const status = document.getElementById("preview-share-status")!; const button = document.getElementById("preview-copy-address") as HTMLButtonElement; button.disabled = true;
    status.textContent = "Preparing your shareable CVM preview…";
    try { const result = await this.call({ action: "preview", sessionId: version.sessionId, artifactId: version.artifactId }); if (this.selected()?.artifactId !== version.artifactId) return; this.#preview = result; if (!result.address) this.#previewArtifact = undefined; button.disabled = !result.address; status.textContent = result.address ? "CVM preview · copy its naddr to try another shell." : "Preview sharing is unconfirmed. Reopen this version to check again."; }
    catch { if (this.selected()?.artifactId === version.artifactId) { this.#previewArtifact = undefined; status.textContent = "Preview works here; sharing could not be confirmed."; } }
  }
  private async open() {
    if (this.#busy) return;
    this.#propagation.clear(); this.el("publication-files").replaceChildren();
    this.stage("signing", "Sign your applet"); this.stage("propagating", "Copy to your servers"); this.stage("announcing", "Publish to Nostr");
    const version = this.selected(); const pubkey = this.identity.pubkey; if (!version || !pubkey) return;
    const opening = ++this.#opening; document.dispatchEvent(new CustomEvent("applet:step", { detail: 4 })); this.el("publication-version").textContent = `Version ${version.version} · ${this.identity.label}`;
    this.el("publication-relay-results").replaceChildren();
    this.el("publication-status").textContent = "Checking saved publication…"; this.el("publication-result").hidden = true; this.el("publication-check").hidden = true; this.el("publication-receipts").hidden = true; this.el("publication-prepare").hidden = true; this.el("publication-review-panel").hidden = true;
    this.#journal = undefined;
    this.el("publication-check").textContent = "Check publication";
    const saved = await this.lookup();
    if (opening !== this.#opening || version.artifactId !== this.selected()?.artifactId || pubkey !== this.identity.pubkey) return;
    this.el("publication-history").hidden = !this.#latest || this.#latest.artifactId === version.artifactId;
    this.el("publication-history").textContent = this.#latest ? `Version ${this.#latest.version} is published. Publishing this version keeps your earlier publication available.` : "";
    if (saved) { this.#journal = { prepared: saved, event: saved.signedEvent }; this.review(); this.result(); return; }
    try { const stored = JSON.parse(sessionStorage.getItem(this.key(version)) ?? "null"); if (stored?.prepared?.artifactId === version.artifactId && stored.prepared.publisher === pubkey && Array.isArray(stored.prepared.relays)) this.#journal = stored; } catch { /* Invalid browser journal cannot authorize a server effect. */ }
    if (this.#journal && (this.#journal.event || this.#journal.prepared.expiresAt > Date.now())) { this.review(); this.result(); return; }
    this.el("publication-status").textContent = "Choose where your applet will live. You’ll approve its signature next.";
    this.el("publication-prepare").hidden = false; this.el("publication-review-panel").hidden = true;
    this.el("publication-discovery").textContent = "Finding your Blossom servers…";
    this.#servers.reset(); this.#relays.reset();
    const serversRevision = this.#servers.revision; const relayRevision = this.#relays.revision;
    this.el("publication-relay-discovery").textContent = "Finding your publishing relays through purplepag.es…";
    void suggestRelays().then(suggestions => { if (opening === this.#opening) this.#relays.suggest(suggestions); }).catch(() => undefined);
    // The user's Nostr list is public; provider/admin configuration is never queried.
    let discoveredRelays: string[] = [];
    try { discoveredRelays = await discoverWriteRelays(pubkey); } catch { /* Manual entry remains available. */ }
    if (opening !== this.#opening || pubkey !== this.identity.pubkey) return;
    if (this.#relays.revision === relayRevision) this.#relays.reset(discoveredRelays);
    this.el("publication-relay-discovery").textContent = discoveredRelays.length ? "Found your NIP-65 publishing relays. You can change them below." : "No publishing relay list was found. Add one or more relays to continue.";
    const relays = [...new Set([...discoveredRelays, this.bootstrap.relayUrl, "wss://purplepag.es"])];
    try {
      const servers = await discoverBlossom(pubkey, relays);
      if (opening !== this.#opening || pubkey !== this.identity.pubkey) return;
      if (this.#servers.revision === serversRevision) this.#servers.reset(servers);
      this.#servers.suggest(servers);
      this.el("publication-discovery").textContent = servers.length ? "Found your Blossom servers. You can change them below." : "No server list found. Add a Blossom server below to continue.";
    } catch { if (opening === this.#opening) this.el("publication-discovery").textContent = "Your server list could not be reached. You can enter a Blossom server below."; }
  }
  private async prepare() {
    if (this.#busy) return; const version = this.selected(); const pubkey = this.identity.pubkey; if (!version || !pubkey) throw new Error("Sign in and select a verified version.");
    if (!this.#servers.commit() || !this.#relays.commit()) return;
    const servers = this.#servers.values; const relays = this.#relays.values;
    if (!relays.length) throw new Error("Add at least one publishing relay.");
    if (!servers.length || servers.length > 5) throw new Error("Enter between one and five Blossom servers.");
    this.#busy = true; this.sync(); this.el<HTMLButtonElement>("publication-review").disabled = true;
    try {
      this.el("publication-status").textContent = "Preparing your applet’s signing request…";
      const prepared = await this.call({ action: "prepare", artifactId: version.artifactId, sessionId: version.sessionId, publisher: pubkey, requestKey: crypto.randomUUID(), title: this.el<HTMLInputElement>("publication-title").value, servers, relays });
      if (this.identity.pubkey !== pubkey || this.selected()?.artifactId !== version.artifactId) throw new Error("Identity or version changed. Review publication again.");
      this.#journal = { prepared, event: prepared.signedEvent }; this.#current = prepared; this.save(); this.review();
      if (prepared.signedEvent || prepared.status === "published") this.result(); else this.el("publication-status").textContent = "Ready for your approval. Nothing has been published under your identity.";
    } finally { this.#busy = false; this.sync(); this.el<HTMLButtonElement>("publication-review").disabled = false; }
  }
  private review() {
    const journal = this.#journal!;
    this.#servers.reset(journal.prepared.servers); this.#relays.reset(journal.prepared.relays); this.el<HTMLInputElement>("publication-title").value = journal.prepared.title ?? "My applet";
    this.el("publication-prepare").hidden = true; this.el("publication-review-panel").hidden = false;
    this.el("publication-edit").hidden = !!journal.event;
    this.el("publication-review-copy").textContent = `Publish version ${journal.prepared.version} as ${this.identity.label}. Your signer will ask you to approve the applet and permission to copy its files.`;
    const capabilities = journal.prepared.template.tags.filter(tag => tag[0] === "requires").map(tag => tag[1]);
    this.el("publication-capabilities").textContent = capabilities.length ? `Required capabilities: ${capabilities.join(", ")}` : "No required shell capabilities.";
    this.el("publication-destinations").replaceChildren(...[...journal.prepared.servers, ...journal.prepared.relays].map(server => { const item = document.createElement("li"); item.textContent = server; return item; }));
    this.el<HTMLButtonElement>("publication-confirm").disabled = false; this.el("publication-confirm").textContent = journal.event ? "Retry remaining steps" : "Sign and publish";
  }
  private progress(event: Propagation) {
    this.#propagation.set(`${event.server}:${event.file}`, event);
    this.el("publication-files").replaceChildren(...[...this.#propagation.values()].map(entry => { const item = document.createElement("li"); item.dataset.state = entry.state; item.textContent = `${new URL(entry.server).host} · ${entry.file} · ${entry.state}${entry.detail ? `: ${entry.detail}` : ""}`; return item; }));
    const verified = [...this.#propagation.values()].filter(item => item.state === "verified").length;
    this.el("publication-status").textContent = event.state === "signing" ? "Approve file-copy permission in your signer…" : `Copying your applet · ${verified} verified copies`;
    this.el("publication-receipts").hidden = false;
    this.stage("propagating", `Copy files · ${verified} of ${(this.#journal?.prepared.files.length ?? 0) * (this.#journal?.prepared.servers.length ?? 0)} verified`, "active");
  }
  private stage(name: string, label: string, state = "waiting") { const item = this.el(`publication-${name}`); item.textContent = label; item.dataset.state = state; if (state === "active") item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current"); }
  private async publish() {
    if (this.#busy || !this.#journal) return; const journal = this.#journal;
    if (journal.prepared.publisher !== this.identity.pubkey) throw new Error("Sign in with the identity that approved this publication.");
    this.#busy = true; this.sync(); this.el<HTMLButtonElement>("publication-confirm").disabled = true; this.el<HTMLButtonElement>("publication-edit").disabled = true;
    const client = this.client();
    const unchanged = () => { if (client !== this.client() || this.identity.pubkey !== journal.prepared.publisher || this.selected()?.artifactId !== journal.prepared.artifactId) throw new Error("Return to this version with its original publishing identity to continue."); };
    try {
      this.el("publication-status").textContent = "Waiting for your applet signature…";
      this.stage("signing", "Approve in your signer", "active");
      if (!journal.event) { journal.event = await this.identity.sign(journal.prepared.template); this.save(); }
      unchanged();
      journal.prepared = await this.call({ action: "save", id: journal.prepared.id, event: journal.event }); this.#current = journal.prepared; this.save();
      this.stage("signing", "Applet signed", "complete");
      this.#propagation.clear();
      const propagated = await propagateBlobs(journal.prepared.files, journal.prepared.servers, { sign: template => { if (this.identity.pubkey !== journal.prepared.publisher) throw new Error("Publishing identity changed. Sign in with the original identity to continue."); return this.identity.sign(template); } }, event => this.progress(event));
      unchanged();
      journal.prepared = await this.call({ action: "save", id: journal.prepared.id, event: journal.event, fileResults: [...this.#propagation.values()] }); this.#current = journal.prepared; this.save();
      if (!propagated) { this.stage("propagating", "Some copies need attention", "failed"); this.el<HTMLDetailsElement>("publication-receipts").open = true; this.el("publication-status").textContent = "Some files could not be copied. Retry remaining steps; verified copies will be reused. Your applet event has not been sent."; return; }
      journal.propagated = true; this.save(); this.stage("propagating", "Files verified", "complete");
      this.el("publication-status").textContent = "Publishing your signed applet to Nostr…";
      this.stage("announcing", "Confirming on your relays", "active");
      journal.prepared = await this.call({ action: "submit", id: journal.prepared.id, event: journal.event }); this.save(); this.result();
    } finally { this.#busy = false; this.sync(); this.el<HTMLButtonElement>("publication-confirm").disabled = false; this.el<HTMLButtonElement>("publication-edit").disabled = false; this.el("publication-confirm").textContent = "Retry remaining steps"; }
  }
  private async check() { if (this.#busy || !this.#journal) return; const journal = this.#journal; this.#busy = true; this.sync(); this.el<HTMLButtonElement>("publication-check").disabled = true; try { journal.prepared = await this.call({ action: "reconcile", id: journal.prepared.id }); this.save(); if (this.#journal === journal) this.result(); } finally { this.#busy = false; this.sync(); this.el<HTMLButtonElement>("publication-check").disabled = false; } }
  private result() {
    const result = this.#journal!.prepared;
    this.#current = result;
    if (result.status === "published" && (!this.#latest || result.version >= this.#latest.version)) this.#latest = result;
    this.#propagation.clear(); for (const entry of result.fileResults ?? []) this.progress(entry);
    const copied = result.fileResults?.length === result.files.length * result.servers.length && result.fileResults.every(item => item.state === "verified");
    const failed = result.fileResults?.some(item => item.state === "failed") && result.status !== "published";
    this.stage("signing", this.#journal!.event || result.status === "published" ? "Applet signed" : "Sign your applet", this.#journal!.event || result.status === "published" ? "complete" : "waiting");
    this.stage("propagating", failed ? "Some copies need attention" : copied ? "Files verified" : result.status === "published" ? "Files copied" : "Copy to your servers", failed ? "failed" : copied || result.status === "published" ? "complete" : "waiting");
    if (failed) this.el<HTMLDetailsElement>("publication-receipts").open = true;
    this.el("publication-receipts").hidden = !(result.fileResults?.length || result.relayResults?.length);
    this.el("publication-relay-results").replaceChildren(...(result.relayResults ?? []).map(receipt => { const li = document.createElement("li"); li.dataset.state = receipt.state; li.textContent = `${receipt.relay} · ${receipt.state === "published" ? "Confirmed" : receipt.detail ?? "Unconfirmed"}`; return li; }));
    if (result.status === "published" && result.address) {
      this.stage("announcing", "Publication confirmed", "complete"); this.el("publication-status").textContent = "Your signed applet is available on Nostr."; this.el("publication-result").hidden = false; this.el("publication-prepare").hidden = true; this.el("publication-review-panel").hidden = true; this.el("publication-check").hidden = true;
      this.el<HTMLInputElement>("publication-address").value = result.address;
      this.el("publication-completion").textContent = `Version ${result.version} · ${result.servers.length} file server${result.servers.length === 1 ? "" : "s"} · ${result.relays.length} relay${result.relays.length === 1 ? "" : "s"}${result.publishedAt ? ` · ${new Date(result.publishedAt).toLocaleDateString()}` : ""}`;
      this.el<HTMLAnchorElement>("publication-open").href = result.url!;
    } else { this.el("publication-status").textContent = result.status === "prepared" ? this.#journal!.event ? "Your signature is saved. Continue copying your files; existing copies will be checked and reused." : "Publication is saved. Continue when ready." : "Some relays have not confirmed. Retry remaining steps to check and resend the same signed event."; this.el("publication-check").hidden = !this.#journal!.event; if (result.status !== "prepared") this.stage("announcing", "Confirmation incomplete", "failed"); }
    this.sync();
  }
  private error(error: unknown) { this.el("publication-status").textContent = error instanceof Error ? error.message : "Publication could not complete. Your verified preview is safe."; this.el("publication-check").hidden = false; this.el("publication-check").textContent = this.#journal ? "Check publication" : "Try again"; this.#panel.querySelectorAll<HTMLElement>('[data-state="active"]').forEach(item => { item.dataset.state = "failed"; item.removeAttribute("aria-current"); }); }
  private async copy(value: string, status: HTMLElement) { try { await navigator.clipboard.writeText(value); status.textContent = "naddr copied. Paste it into a compatible shell."; } catch { const field = document.createElement("input"); field.value = value; field.readOnly = true; field.setAttribute("aria-label", "Copy this naddr"); status.replaceChildren(field); field.select(); } }
}
