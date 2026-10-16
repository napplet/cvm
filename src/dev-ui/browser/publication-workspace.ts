import { DestinationInput } from "./destination-input";
import { discoverWriteRelays, suggestRelays } from "./relay-discovery";
import { relayUrl } from "../destinations";
import type { Event, EventTemplate } from "nostr-tools/pure";
import type { DevelopmentBootstrap, DevelopmentContextVmClient } from "./contextvm-client";
import { PublishingIdentity } from "./nostr-identity";
import { blossomServer, discoverBlossom, propagateBlobs, type BlobFile, type Propagation } from "./blossom-client";
type Version = { sessionId: string; artifactId: string; version: number };
type Publication = { id: string; status: string; artifactId: string; publisher: string; template: EventTemplate; files: BlobFile[]; servers: string[]; relays: string[]; relayResults?: { relay: string; state: string; detail?: string }[]; address?: string; url?: string; version: number; expiresAt: number };
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
  #propagation = new Map<string, Propagation>();
  constructor(private readonly bootstrap: DevelopmentBootstrap, private readonly client: () => DevelopmentContextVmClient | undefined, private readonly selected: () => Version | undefined) {
    const button = document.createElement("button"); button.id = "publish"; button.className = "primary"; button.textContent = "Publish"; button.disabled = true; const footer = document.createElement("div"); footer.className = "publish-next"; const hint = document.createElement("p"); hint.id = "publish-hint"; hint.className = "supporting"; footer.append(hint,button); document.querySelector("#build-step")!.append(footer);
    this.identity = new PublishingIdentity(bootstrap.servicePubkey, () => { this.#opening++; if (!this.#busy) { this.#journal = undefined;  } this.sync(); });
    this.#panel = document.createElement("section"); this.#panel.id = "publish-step"; this.#panel.hidden = true; this.#panel.className = "step-panel publication-step"; this.#panel.setAttribute("aria-labelledby", "publication-heading");
    this.#panel.innerHTML = `<button id="publication-close" class="text-button">← Back to your applet</button><div class="eyebrow">THE FINAL STEP</div><h1 id="publication-heading" tabindex="-1">Share your little thing.</h1><p id="publication-version"></p>
      <form id="publication-prepare"><label for="publication-title">Applet name</label><input id="publication-title" maxlength="120" value="My applet" required><p id="publication-discovery" role="status"></p><div id="publication-server-editor"></div><p class="supporting">We’ll copy your applet to these Blossom servers after you approve its signature.</p><p id="publication-relay-discovery" role="status"></p><div id="publication-relay-editor"></div><p id="publication-relay-hint" class="supporting">Relays make your applet discoverable in other shells. Suggestions come from recent NIP-66 monitor reports and are optional.</p><button id="publication-review" class="primary">Review publication</button></form>
      <section id="publication-review-panel" hidden><p id="publication-review-copy"></p><details><summary>Permissions and destinations</summary><p id="publication-capabilities"></p><ul id="publication-destinations"></ul></details><button id="publication-confirm" class="primary">Sign and publish</button><button id="publication-edit">Edit destinations</button></section>
      <ol class="publication-stages"><li id="publication-signing">1. Sign your applet</li><li id="publication-propagating">2. Copy to your servers</li><li id="publication-announcing">3. Publish to Nostr</li></ol><p id="publication-status" role="status" aria-live="polite"></p><ul id="publication-files" aria-label="File propagation progress"></ul><ul id="publication-relay-results" aria-label="Relay publication progress"></ul><button id="publication-check" hidden>Check publication</button>
      <div id="publication-result" hidden><p>Your applet is published.</p><button id="publication-copy">Copy naddr</button><a id="publication-open" target="_blank" rel="noopener noreferrer">Open applet</a></div>`;
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
    this.el("publication-edit").onclick = () => { if (this.#busy) return; this.#journal = undefined; this.el("publication-prepare").hidden = false; this.el("publication-review-panel").hidden = true; };
    this.el("publication-check").onclick = () => { void this.check().catch(error => this.error(error)); };
    document.getElementById("preview-copy-address")!.onclick = () => { if (this.#preview?.address) void this.copy(this.#preview.address, document.getElementById("preview-share-status")!); };
    this.el("publication-copy").onclick = () => { if (this.#journal?.prepared.address) void this.copy(this.#journal.prepared.address, this.el("publication-status")); };
    this.sync();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.#panel.querySelector<T>(`#${id}`)!; }
  private key(version: Version, publisher = this.identity.pubkey) { return `applet-broker/publication/v1/${this.bootstrap.servicePubkey}/${version.artifactId}/${publisher}`; }
  private save() { if (this.#journal) sessionStorage.setItem(this.key({ artifactId: this.#journal.prepared.artifactId } as Version, this.#journal.prepared.publisher), JSON.stringify(this.#journal)); }
  private async call(input: unknown): Promise<any> { if (!this.client()) throw new Error("Connect to the CVM first."); const result = await this.client()!.callTool("development_publication", input); if (["denied", "rejected", "expired"].includes(result?.status)) throw new Error(result.code ?? `Publication ${result.status}`); return result; }
  sync(): void {
    const button = document.getElementById("publish") as HTMLButtonElement;
    button.disabled = !this.identity?.pubkey || !this.selected() || !this.client() || this.#busy;
    document.getElementById("publish-hint")!.textContent = !this.identity?.pubkey ? "Sign in to publish this applet under your Nostr identity." : !this.selected() ? "Publishing opens after this applet passes its checks." : `Ready to share version ${this.selected()!.version}?`;
    button.title = !this.identity?.pubkey ? "Sign in to publish" : !this.selected() ? "A verified applet is needed before publication" : "Publish this version under your identity";
  }
  async version(): Promise<void> {
    this.sync(); const version = this.selected(); if (!version || version.artifactId === this.#previewArtifact) return;
    this.#previewArtifact = version.artifactId; this.#preview = undefined;
    const status = document.getElementById("preview-share-status")!; const button = document.getElementById("preview-copy-address") as HTMLButtonElement; button.disabled = true;
    status.textContent = "Preparing your shareable CVM preview…";
    try { const result = await this.call({ action: "preview", sessionId: version.sessionId, artifactId: version.artifactId }); if (this.selected()?.artifactId !== version.artifactId) return; this.#preview = result; if (!result.address) this.#previewArtifact = undefined; button.disabled = !result.address; status.textContent = result.address ? "CVM preview · copy its naddr to try another shell." : "Preview sharing is unconfirmed. Reopen this version to check again."; }
    catch { if (this.selected()?.artifactId === version.artifactId) { this.#previewArtifact = undefined; status.textContent = "Preview works here; sharing could not be confirmed."; } }
  }
  private async open() {
    if (this.#busy) return;
    this.#propagation.clear(); this.el("publication-files").replaceChildren();
    this.el("publication-signing").textContent = "1. Sign your applet"; this.el("publication-propagating").textContent = "2. Copy to your servers"; this.el("publication-announcing").textContent = "3. Publish to Nostr";
    const version = this.selected(); const pubkey = this.identity.pubkey; if (!version || !pubkey) return;
    const opening = ++this.#opening; document.dispatchEvent(new CustomEvent("applet:step", { detail: 4 })); this.el("publication-version").textContent = `Version ${version.version} · ${this.identity.label}`;
    this.el("publication-relay-results").replaceChildren();
    this.el("publication-status").textContent = ""; this.el("publication-result").hidden = true; this.el("publication-check").hidden = true;
    this.#journal = undefined;
    try { const stored = JSON.parse(sessionStorage.getItem(this.key(version)) ?? "null"); if (stored?.prepared?.artifactId === version.artifactId && stored.prepared.publisher === pubkey && Array.isArray(stored.prepared.relays)) this.#journal = stored; } catch { /* Invalid browser journal cannot authorize a server effect. */ }
    if (this.#journal && (this.#journal.event || this.#journal.prepared.expiresAt > Date.now())) { this.review(); if (this.#journal.event) await this.check(); return; }
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
      this.#journal = { prepared }; this.save(); this.review(); this.el("publication-status").textContent = "Ready for your approval. Nothing has been published under your identity.";
    } finally { this.#busy = false; this.sync(); this.el<HTMLButtonElement>("publication-review").disabled = false; }
  }
  private review() {
    const journal = this.#journal!;
    this.el("publication-prepare").hidden = true; this.el("publication-review-panel").hidden = false;
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
  }
  private async publish() {
    if (this.#busy || !this.#journal) return; const journal = this.#journal;
    if (journal.prepared.publisher !== this.identity.pubkey) throw new Error("Sign in with the identity that approved this publication.");
    this.#busy = true; this.sync(); this.el<HTMLButtonElement>("publication-confirm").disabled = true; this.el<HTMLButtonElement>("publication-edit").disabled = true;
    try {
      this.el("publication-status").textContent = "Waiting for your applet signature…";
      if (!journal.event) { journal.event = await this.identity.sign(journal.prepared.template); this.save(); }
      this.el("publication-signing").textContent = "✓ Applet signed";
      this.#propagation.clear();
      const propagated = await propagateBlobs(journal.prepared.files, journal.prepared.servers, { sign: template => { if (this.identity.pubkey !== journal.prepared.publisher) throw new Error("Publishing identity changed. Sign in with the original identity to continue."); return this.identity.sign(template); } }, event => this.progress(event));
      if (!propagated) { this.el("publication-status").textContent = "Some files could not be copied. Retry remaining steps; verified copies will be reused. Your applet event has not been sent."; return; }
      journal.propagated = true; this.save(); this.el("publication-propagating").textContent = "✓ Files verified on your servers";
      this.el("publication-status").textContent = "Publishing your signed applet to Nostr…";
      journal.prepared = await this.call({ action: "submit", id: journal.prepared.id, event: journal.event }); this.save(); this.result();
    } finally { this.#busy = false; this.sync(); this.el<HTMLButtonElement>("publication-confirm").disabled = false; this.el<HTMLButtonElement>("publication-edit").disabled = false; this.el("publication-confirm").textContent = "Retry remaining steps"; }
  }
  private async check() { if (!this.#journal) return; const journal = this.#journal; journal.prepared = await this.call({ action: "reconcile", id: journal.prepared.id }); this.save(); if (this.#journal === journal) this.result(); }
  private result() {
    const result = this.#journal!.prepared;
    this.el("publication-relay-results").replaceChildren(...(result.relayResults ?? []).map(receipt => { const li = document.createElement("li"); li.dataset.state = receipt.state; li.textContent = `${receipt.relay} · ${receipt.state === "published" ? "Confirmed" : receipt.detail ?? "Unconfirmed"}`; return li; }));
    if (result.status === "published" && result.address) {
      this.el("publication-announcing").textContent = "✓ Publication confirmed"; this.el("publication-status").textContent = "Your signed applet is available on Nostr."; this.el("publication-result").hidden = false; this.el("publication-review-panel").hidden = true; this.el("publication-check").hidden = true;
      this.el<HTMLAnchorElement>("publication-open").href = result.url!;
    } else { this.el("publication-status").textContent = result.status === "prepared" ? "Publication is saved. Continue when ready." : "Relay confirmation is pending. Check publication before retrying."; this.el("publication-check").hidden = false; }
  }
  private error(error: unknown) { this.el("publication-status").textContent = error instanceof Error ? error.message : "Publication could not complete. Your verified preview is safe."; this.el("publication-check").hidden = !this.#journal?.event; }
  private async copy(value: string, status: HTMLElement) { try { await navigator.clipboard.writeText(value); status.textContent = "naddr copied. Paste it into a compatible shell."; } catch { const field = document.createElement("input"); field.value = value; field.readOnly = true; field.setAttribute("aria-label", "Copy this naddr"); status.replaceChildren(field); field.select(); } }
}
