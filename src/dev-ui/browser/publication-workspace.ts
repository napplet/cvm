import { normalizeHashtag } from "../publication-hashtags";
import { DestinationInput } from "./destination-input";
import { discoverWriteRelays, suggestRelays } from "./relay-discovery";
import { relayUrl } from "../destinations";
import { MIN_PUBLICATION_SERVERS, verifiedPublicationServers } from "../publication-copies";
import { PublicationMetadataSchema, publicationCapabilities } from "../publication-metadata";
import type { Event, EventTemplate } from "nostr-tools/pure";
import type { DevelopmentBootstrap, DevelopmentContextVmClient } from "./contextvm-client";
import { PublishingIdentity } from "./nostr-identity";
import { blossomServer, discoverBlossom, propagateBlobs, type BlobFile, type Propagation } from "./blossom-client";
type Version = { sessionId: string; artifactId: string; version: number };
type Publication = { capabilitiesKnown?: boolean; screenshot?: string; application?: { template: EventTemplate; signedEvent?: Event; relayResults?: { relay: string; state: string }[] }; republication?: { attemptedAt: string; relayResults: {relay:string;state:string}[] }; id: string; status: string; artifactId: string; publisher: string; template: EventTemplate; files: BlobFile[]; servers: string[]; relays: string[]; relayResults?: { relay: string; state: string; detail?: string }[]; fileResults?: Propagation[]; signedEvent?: Event; publishedAt?: string; title?: string; description?: string; address?: string; url?: string; version: number; expiresAt: number };
type Journal = { prepared: Publication; event?: Event; applicationEvent?: Event; propagated?: boolean };
export class PublicationWorkspace {
  readonly identity: PublishingIdentity;
  readonly #panel: HTMLElement;
  readonly #servers: DestinationInput;
  readonly #relays: DestinationInput;
  readonly #hashtags: DestinationInput;
  #busy = false;
  #republishing = false;
  #replacement?: string;
  #drafts = new Map<string, { title: string; description: string; hashtags: string[]; pendingHashtag: string }>();
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
    const republish = document.createElement("button"); republish.id = "republish"; republish.textContent = "Republish"; republish.hidden = true; footer.insertBefore(republish, publishedCopy);
    republish.onclick = () => { void this.open().then(() => this.republish()).catch(error => this.error(error)); };
    publishedCopy.onclick = () => { if (this.#current?.address) void this.copy(this.#current.address, hint); };
    this.identity = new PublishingIdentity(bootstrap.servicePubkey, () => { this.#opening++; ++this.#lookupEpoch; this.#current = this.#latest = undefined; if (!this.#busy) this.#journal = undefined; this.sync(); void this.lookup().catch(() => undefined); });
    this.#panel = document.createElement("section"); this.#panel.id = "publish-step"; this.#panel.hidden = true; this.#panel.className = "step-panel publication-step"; this.#panel.setAttribute("aria-labelledby", "publication-heading");
    this.#panel.innerHTML = `<button id="publication-close" class="text-button">← Back to your applet</button><header class="publication-heading"><span class="small-mark" aria-hidden="true">a·</span><div><div class="eyebrow">THE FINAL STEP</div><h1 id="publication-heading" tabindex="-1">Ready for the world.</h1><p id="publication-version" class="supporting"></p></div></header><p id="publication-history" class="supporting" hidden></p>
      <form id="publication-prepare"><label for="publication-title">Applet name</label><input id="publication-title" maxlength="120" required aria-describedby="publication-metadata-note"><label for="publication-description">Description</label><textarea id="publication-description" rows="3" maxlength="500" required aria-describedby="publication-metadata-note"></textarea><p id="publication-metadata-note" class="supporting" role="status"></p><div id="publication-hashtag-editor"></div><p id="publication-discovery" role="status"></p><div id="publication-server-editor"></div><p class="supporting">Two verified copies are enough.</p><p id="publication-relay-discovery" role="status"></p><div id="publication-relay-editor"></div><p id="publication-relay-hint" class="supporting">One relay confirmation is enough to publish.</p><button id="publication-review" class="primary">Review publication</button></form>
      <figure id="publication-media" hidden><img id="publication-screenshot" alt="Screenshot of this applet" width="1200" height="750"><figcaption>Screenshot included in your application listing</figcaption></figure><section id="publication-review-panel" hidden><h2 id="publication-review-title"></h2><p id="publication-review-description"></p><div id="publication-review-hashtags" class="destination-chips" aria-label="Publication hashtags"></div><p id="publication-review-copy"></p><details><summary>Destinations</summary><ul id="publication-destinations"></ul></details><button id="publication-confirm" class="primary">Sign and publish</button><button id="publication-edit">Edit details and destinations</button></section>
      <details id="publication-advanced" class="publication-advanced" hidden><summary>Advanced applet details</summary><p class="supporting">Capabilities declared by this build. Your shell decides which permissions to grant.</p><div class="publication-capability-grid"><section><h3>Required</h3><ul id="publication-required" class="publication-capabilities"></ul></section><section><h3>Optional</h3><ul id="publication-optional" class="publication-capabilities"></ul></section></div><p id="publication-optional-note" class="supporting"></p><details><summary>Manifest and files</summary><pre id="publication-manifest" tabindex="0"></pre></details></details>
      <ol id="publication-stages" class="publication-stages" aria-label="Publication progress"><li id="publication-signing">Sign your applet</li><li id="publication-propagating">Copy to your servers</li><li id="publication-announcing">Publish to Nostr</li></ol><p id="publication-status" role="status" aria-live="polite"></p><p id="publication-copy-warning" class="publication-copy-warning" role="status" hidden></p><details id="publication-receipts" hidden><summary id="publication-delivery-summary">Delivery details</summary><div class="publication-delivery-grid"><section><h3>Files</h3><ul id="publication-files" aria-label="File propagation progress"></ul></section><section><h3>Relays</h3><ul id="publication-relay-results" aria-label="Relay publication progress"></ul></section><section id="publication-application-delivery" hidden><h3>Application listing</h3><ul id="publication-application-results" aria-label="Application listing delivery"></ul></section></div></details><button id="publication-check" hidden>Check publication</button>
      <div id="publication-result" role="status" hidden><span class="publication-success" aria-hidden="true">✓</span><h2 id="publication-result-title">Your applet</h2><p id="publication-completion"></p><p id="publication-listing" hidden></p><div class="publication-actions"><button id="publication-copy" class="primary">Copy naddr</button><a id="publication-open" class="quiet" target="_blank" rel="noopener noreferrer">Open applet ↗</a><button id="publication-edit-published">Edit publication</button><button id="publication-republish">Republish</button></div><p id="publication-share-feedback" class="supporting" aria-live="polite">Paste its naddr into any compatible shell.</p><details class="publication-address-details"><summary>Applet address</summary><input id="publication-address" aria-label="Applet address" readonly></details></div>`;
    this.el("publication-history").after(this.el("publication-result"));
    this.el("publication-receipts").querySelector("summary")!.after(this.el("publication-copy-warning"));
    this.#panel.append(this.el("publication-advanced"));
    document.querySelector("#build-step")!.after(this.#panel);
    this.#servers = new DestinationInput(this.el("publication-server-editor"), "publication-servers", "Blossom servers", "https://blossom.example.com", blossomServer);
    this.#relays = new DestinationInput(this.el("publication-relay-editor"), "publication-relays", "Publishing relays", "wss://relay.example.com", relayUrl);
    this.#hashtags = new DestinationInput(this.el("publication-hashtag-editor"), "publication-hashtags", "Hashtags", "Add a topic, e.g. games", normalizeHashtag, 10, { noun: "hashtag", hint: "Press Enter to add a topic. Up to 10; remove with ×.", onChange: () => this.rememberDraft() });
    const previewShare = document.createElement("div"); previewShare.className = "preview-sharing";
    previewShare.innerHTML = `<span id="preview-share-status" role="status">A shareable CVM preview appears after verification.</span><button id="preview-copy-address" disabled>Copy preview naddr</button>`;
    document.querySelector(".preview-panel")!.append(previewShare);
    button.onclick = () => { void this.open().catch(error => this.error(error)); };
    this.el("publication-close").onclick = () => { ++this.#opening; document.dispatchEvent(new CustomEvent("applet:step", { detail: 3 })); };
    this.el<HTMLFormElement>("publication-prepare").onsubmit = event => { event.preventDefault(); void this.prepare().catch(error => this.error(error)); };
    this.el("publication-confirm").onclick = () => { void this.publish().catch(error => this.error(error)); };
    const edit = () => {
      if (this.#busy || !this.#journal || !["prepared", "unconfirmed", "published"].includes(this.#journal.prepared.status)) return;
      this.#replacement = this.#journal.event ? this.#journal.prepared.id : undefined;
      this.el("publication-metadata-note").textContent = this.#replacement ? "Editing creates a new publication draft. You’ll approve fresh signatures; your previous publication stays available." : "Edit these details before signing.";
      this.el("publication-prepare").hidden = false; this.el("publication-review-panel").hidden = true;
      this.el("publication-result").hidden = true; this.el("publication-media").hidden = true; this.el("publication-receipts").hidden = true; this.el("publication-stages").hidden = true;
      this.#panel.dataset.published = "false"; this.el("publication-heading").textContent = "Edit your publication.";
      this.el("publication-check").hidden = true;
      this.el("publication-discovery").textContent = "Saved Blossom destinations. Change them below.";
      this.el("publication-relay-discovery").textContent = "Saved publishing relays. Change them below.";
      this.el("publication-status").textContent = "";
      this.el("publication-title").focus();
      const journal = this.#journal; const opening = this.#opening;
      // Earlier signed drafts may lack descriptions. Suggest missing fields
      // without changing the saved signature or overwriting ongoing edits.
      if (!this.el<HTMLInputElement>("publication-title").value || !this.el<HTMLTextAreaElement>("publication-description").value) {
        const version = this.selected();
        if (version) void this.call({ action: "metadata", sessionId: version.sessionId, artifactId: version.artifactId }).then(value => {
          const metadata = PublicationMetadataSchema.parse(value);
          if (opening !== this.#opening || this.#journal !== journal || version.artifactId !== this.selected()?.artifactId || journal.prepared.publisher !== this.identity.pubkey || this.el("publication-prepare").hidden) return;
          if (metadata.artifactId !== version.artifactId || metadata.version !== version.version) return;
          if (!this.el<HTMLInputElement>("publication-title").value) this.el<HTMLInputElement>("publication-title").value = metadata.title;
          if (!this.el<HTMLTextAreaElement>("publication-description").value) this.el<HTMLTextAreaElement>("publication-description").value = metadata.description;
        }).catch(() => { /* Manual entry remains available. */ });
      }
    };
    this.el("publication-edit").onclick = edit;
    this.el("publication-edit-published").onclick = edit;
    for (const id of ["publication-title", "publication-description"]) this.el(id).addEventListener("input", () => this.rememberDraft());
    this.el("publication-check").onclick = () => { void (this.#journal ? this.check() : this.open()).catch(error => this.error(error)); };
    document.getElementById("preview-copy-address")!.onclick = () => { if (this.#preview?.address) void this.copy(this.#preview.address, document.getElementById("preview-share-status")!); };
    this.el("publication-copy").onclick = () => { if (this.#journal?.prepared.address) void this.copy(this.#journal.prepared.address, this.el("publication-share-feedback")); };
    this.el("publication-republish").onclick = () => { void this.republish(); };
    this.sync();
  }
  private rememberDraft() {
    const version = this.selected(); if (version) this.#drafts.set(this.key(version), { title: this.el<HTMLInputElement>("publication-title").value, description: this.el<HTMLTextAreaElement>("publication-description").value, hashtags: this.#hashtags.values, pendingHashtag: this.#hashtags.input.value });
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.#panel.querySelector<T>(`#${id}`)!; }
  private key(version: Version, publisher = this.identity.pubkey) { return `applet-broker/publication/v1/${this.bootstrap.servicePubkey}/${version.artifactId}/${publisher}`; }
  private save() { if (this.#journal) { try { sessionStorage.setItem(this.key({ artifactId: this.#journal.prepared.artifactId } as Version, this.#journal.prepared.publisher), JSON.stringify(this.#journal)); } catch { /* Durable CVM state is authoritative; browser storage is optional. */ } } }
  private async call(input: unknown): Promise<any> { if (!this.client()) throw new Error("Connect to the CVM first."); const result = await this.client()!.callTool("development_publication", input); if (["denied", "rejected", "expired"].includes(result?.status)) throw new Error(({PUBLICATION_SCREENSHOT_BUSY:"Screenshots are busy. Try again in a moment.",PUBLICATION_SCREENSHOT_FAILED:"The screenshot could not be captured. Your applet is saved; try again.",PUBLICATION_SCREENSHOT_TOOLCHAIN_MISSING:"The CVM needs its publication tools. Run development setup, then retry.",PUBLICATION_SUPERSEDED:"This draft was replaced. Go back to your applet and reopen publishing for the current draft.",PUBLICATION_EDIT_UNAVAILABLE:"Publication changed or is sending. Check its status, then reopen publishing to edit.",PUBLICATION_NEEDS_TWO_VERIFIED_SERVERS:"Two verified file copies are needed. Retry file copies or edit destinations."} as Record<string,string>)[result.code] ?? result.code ?? `Publication ${result.status}`); return result; }
  sync(): void {
    if (this.#current && (this.#current.artifactId !== this.selected()?.artifactId || this.#current.publisher !== this.identity?.pubkey)) this.#current = undefined;
    const button = document.getElementById("publish") as HTMLButtonElement;
    button.disabled = !this.identity?.pubkey || !this.selected() || !this.client() || this.#busy;
    const published = this.#current?.status === "published";
    const changes = this.#latest && this.selected() && this.#latest.version < this.selected()!.version;
    document.getElementById("publish-hint")!.textContent = !this.identity?.pubkey ? "Sign in to publish this applet under your Nostr identity." : !this.selected() ? "Publishing opens after this applet passes its checks." : published ? `Published · Version ${this.selected()!.version} · Ready to share` : this.#lookupError ? "Publication status could not be checked. Open publishing to try again." : changes ? `Unpublished changes · Version ${this.#latest!.version} is published. Version ${this.selected()!.version} is ready.` : this.#current?.signedEvent ? "Publication in progress · Your signature is saved. Continue the remaining steps." : `Ready to share version ${this.selected()!.version}?`;
    button.textContent = published ? "View publication" : this.#current?.signedEvent ? "Continue publishing" : "Publish";
    document.getElementById("published-copy-address")!.hidden = !published || !this.#current?.address;
    const republish = document.getElementById("republish") as HTMLButtonElement;
    republish.hidden = !published; republish.disabled = this.#busy || button.disabled;
    for (const control of [republish, this.el<HTMLButtonElement>("publication-republish")]) { control.disabled = button.disabled; control.textContent = this.#republishing ? "Republishing…" : "Republish"; }

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
    this.el("publication-heading").textContent = "Publish your applet.";
    this.el("publication-version").hidden = false; this.el("publication-status").hidden = false;
    this.el("publication-stages").hidden = true;
    this.el<HTMLDetailsElement>("publication-receipts").open = false;
    this.el<HTMLDetailsElement>("publication-advanced").open = false;
    this.#panel.dataset.published = "false";
    this.stage("signing", "Sign your applet"); this.stage("propagating", "Copy to your servers"); this.stage("announcing", "Publish to Nostr");
    const version = this.selected(); const pubkey = this.identity.pubkey; if (!version || !pubkey) return;
    const opening = ++this.#opening; document.dispatchEvent(new CustomEvent("applet:step", { detail: 4 })); this.el("publication-version").textContent = `Version ${version.version} · ${this.identity.label}`;
    this.el("publication-relay-results").replaceChildren();
    this.el("publication-status").textContent = "Checking saved publication…"; this.el("publication-copy-warning").hidden = true; this.el("publication-result").hidden = true; this.el("publication-check").hidden = true; this.el("publication-receipts").hidden = true; this.el("publication-prepare").hidden = true; this.el("publication-review-panel").hidden = true;
    this.el("publication-media").hidden = true; this.el("publication-listing").hidden = true;
    this.#journal = undefined; this.#replacement = undefined; this.el("publication-advanced").hidden = true;
    this.el("publication-check").textContent = "Check publication";
    const saved = await this.lookup();
    if (opening !== this.#opening || version.artifactId !== this.selected()?.artifactId || pubkey !== this.identity.pubkey) return;
    this.el("publication-history").hidden = !this.#latest || this.#latest.artifactId === version.artifactId;
    this.el("publication-history").textContent = this.#latest ? `Version ${this.#latest.version} is published. Publishing this version keeps your earlier publication available.` : "";
    if (saved) { this.#journal = { prepared: saved, event: saved.signedEvent }; this.review(); this.result(); return; }
    try { const stored = JSON.parse(sessionStorage.getItem(this.key(version)) ?? "null"); if (stored?.prepared?.artifactId === version.artifactId && stored.prepared.publisher === pubkey && Array.isArray(stored.prepared.relays)) this.#journal = stored; } catch { /* Invalid browser journal cannot authorize a server effect. */ }
    if (this.#journal && (this.#journal.event || this.#journal.prepared.expiresAt > Date.now())) { this.review(); this.result(); return; }
    this.el("publication-status").textContent = "Loading applet details from the CVM…";
    const draft = this.#drafts.get(this.key(version));
    this.el<HTMLInputElement>("publication-title").value = draft?.title ?? "";
    this.el<HTMLTextAreaElement>("publication-description").value = draft?.description ?? "";
    this.#hashtags.reset(draft?.hashtags ?? []); this.#hashtags.input.value = draft?.pendingHashtag ?? "";
    try {
      const metadata = PublicationMetadataSchema.parse(await this.call({ action: "metadata", sessionId: version.sessionId, artifactId: version.artifactId }));
      if (opening !== this.#opening || version.artifactId !== this.selected()?.artifactId || pubkey !== this.identity.pubkey) return;
      if (metadata.artifactId !== version.artifactId || metadata.version !== version.version) throw new Error("Metadata version changed");
      if (!draft) { this.el<HTMLInputElement>("publication-title").value = metadata.title; this.el<HTMLTextAreaElement>("publication-description").value = metadata.description; }
      this.el("publication-metadata-note").textContent = draft ? "Your edits are saved." : metadata.basis === "manifest" ? "Suggested from your verified build." : "Suggested from your project. Edit as you like.";
      if (!draft && this.#hashtags.values.length === 0 && !this.#hashtags.input.value) this.#hashtags.reset(metadata.tags.filter(tag => tag[0] === "t").map(tag => tag[1]!));
      this.advanced(metadata.tags, metadata.files, undefined, undefined, metadata.capabilitiesKnown);
    } catch {
      if (opening !== this.#opening || version.artifactId !== this.selected()?.artifactId || pubkey !== this.identity.pubkey) return;
      this.el("publication-metadata-note").textContent = "Suggestions could not be loaded. Enter a title and description to continue; the signing review will show the build’s capabilities.";
    }
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
      this.el("publication-discovery").textContent = servers.length ? "Found your Blossom servers. You can change them below." : "No server list found. Add at least two Blossom servers below to continue.";
    } catch { if (opening === this.#opening) this.el("publication-discovery").textContent = "Your server list could not be reached. You can enter at least two Blossom servers below."; }
  }
  private async prepare() {
    if (this.#busy) return; const version = this.selected(); const pubkey = this.identity.pubkey; if (!version || !pubkey) throw new Error("Sign in and select a verified version.");
    if (!this.#hashtags.commit() || !this.#servers.commit() || !this.#relays.commit()) return;
    const servers = this.#servers.values; const relays = this.#relays.values;
    if (!relays.length) throw new Error("Add at least one publishing relay.");
    if (servers.length < MIN_PUBLICATION_SERVERS || servers.length > 5) throw new Error("Add at least two Blossom servers so your applet has a backup. You can choose up to five.");
    this.#busy = true; this.sync(); this.el<HTMLButtonElement>("publication-review").disabled = true;
    try {
      this.el("publication-status").textContent = "Capturing your applet and preparing its application listing…";
      this.el("publication-review").textContent = "Preparing screenshot…";
      const prepared = await this.call({ action: "prepare", artifactId: version.artifactId, sessionId: version.sessionId, publisher: pubkey, requestKey: crypto.randomUUID(), hashtags: this.#hashtags.values, title: this.el<HTMLInputElement>("publication-title").value, description: this.el<HTMLTextAreaElement>("publication-description").value, ...(this.#replacement ? { replaces: this.#replacement } : {}), servers, relays });
      if (this.identity.pubkey !== pubkey || this.selected()?.artifactId !== version.artifactId) throw new Error("Identity or version changed. Review publication again.");
      this.#journal = { prepared, event: prepared.signedEvent }; this.#replacement = undefined; this.#current = prepared; this.save(); this.review();
      if (prepared.signedEvent || prepared.status === "published") this.result(); else this.el("publication-status").textContent = "Ready for your approval. Nothing has been published under your identity.";
    } finally { this.#busy = false; this.sync(); this.el<HTMLButtonElement>("publication-review").disabled = false; this.el("publication-review").textContent = "Review publication"; }
  }
  private review() {
    const journal = this.#journal!;
    this.#hashtags.reset(journal.prepared.template.tags.filter(tag => tag[0] === "t").map(tag => tag[1]!));
    this.el("publication-review-hashtags").replaceChildren(...this.#hashtags.values.map(topic => { const chip = document.createElement("span"); chip.className = "destination-chip"; const label = document.createElement("span"); label.textContent = `#${topic}`; chip.append(label); return chip; }));
    this.#servers.reset(journal.prepared.servers); this.#relays.reset(journal.prepared.relays); this.el<HTMLInputElement>("publication-title").value = journal.prepared.title ?? "";
    this.el<HTMLTextAreaElement>("publication-description").value = journal.prepared.description ?? journal.prepared.template.tags.find(tag => tag[0] === "description")?.[1] ?? "";
    this.el("publication-review-title").textContent = this.el<HTMLInputElement>("publication-title").value; this.el("publication-review-description").textContent = this.el<HTMLTextAreaElement>("publication-description").value || "This saved publication has no description. Edit details to add one before publishing.";
    this.el("publication-prepare").hidden = true; this.el("publication-review-panel").hidden = false;
    this.el("publication-edit").hidden = !["prepared", "unconfirmed"].includes(journal.prepared.status);
    this.media(journal.prepared);
    this.el("publication-review-copy").textContent = journal.prepared.application ? "Approve your applet and application listing in your signer (two requests)." : "Approve the applet in your signer.";
    this.el("publication-review-copy").hidden = !!journal.event && (!journal.prepared.application || !!journal.prepared.application.signedEvent);
    this.advanced(journal.prepared.template.tags, journal.prepared.files, journal.prepared.template, journal.prepared.application?.template, journal.prepared.capabilitiesKnown);
    this.el("publication-destinations").replaceChildren(...[...journal.prepared.servers, ...journal.prepared.relays].map(server => { const item = document.createElement("li"); item.textContent = server; return item; }));
    this.el<HTMLButtonElement>("publication-confirm").disabled = false; this.el("publication-confirm").textContent = this.continueLabel(journal);
  }
  private advanced(tags: string[][], files: { path: string; sha256: string; bytes: number }[], template?: EventTemplate, application?: EventTemplate, capabilitiesKnown?: boolean) {
    const capabilities = publicationCapabilities(tags, capabilitiesKnown);
    for (const kind of ["required", "optional"] as const) {
      const values = capabilities[kind];
      this.el(`publication-${kind}`).replaceChildren(...(values.length ? values : [kind === "optional" && capabilities.legacy ? "Not declared by this build" : "None declared"]).map(value => { const li = document.createElement("li"); li.textContent = value; return li; }));
    }
    this.el("publication-optional-note").textContent = capabilities.legacy ? "This older build did not record optional capabilities. A new revision will include explicit declarations." : "Optional capabilities enhance the applet when your shell provides them.";
    this.el("publication-manifest").textContent = JSON.stringify({ ...(template ? { template } : { tags }), ...(application ? { application } : {}), files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) }, null, 2);
    this.el("publication-advanced").hidden = false;
  }
  private continueLabel(journal = this.#journal) {
    if (!journal?.event || (journal.prepared.application && !journal.prepared.application.signedEvent)) return "Sign and publish";
    const count = verifiedPublicationServers(journal.prepared.files, journal.prepared.servers, journal.prepared.fileResults ?? []).length;
    return count >= MIN_PUBLICATION_SERVERS ? journal.prepared.status === "unconfirmed" ? "Retry publication" : "Publish to Nostr" : "Retry file copies";
  }
  private async announce(journal: Journal) {
    this.stage("signing", "Applet signed", "complete"); this.stage("propagating", `Files verified on ${this.verifiedCopies()} servers`, "complete");
    this.el("publication-status").textContent = "Publishing your signed applet to Nostr…";
    this.stage("announcing", "Confirming on your relays", "active");
    journal.prepared = await this.call({ action: "submit", id: journal.prepared.id, event: journal.event }); this.save(); this.result();
  }
  private progress(event: Propagation) {
    this.#propagation.set(`${event.server}:${event.file}`, event);
    this.el("publication-files").replaceChildren(...[...this.#propagation.values()].map(entry => this.receipt(new URL(entry.server).host, entry.state, entry.state === "verified" ? "Verified" : entry.state === "failed" ? "Unavailable" : entry.state, `${entry.file}${entry.detail ? ` · ${entry.detail}` : ""}`)));
    const verified = this.verifiedCopies();
    const operation = { checking: "Checking existing files", signing: "Approve file-copy permission in your signer", mirroring: "Copying files", uploading: "Uploading files", verified: "Files verified", failed: "Copy failed" }[event.state];
    this.el("publication-status").textContent = `${operation} · ${new URL(event.server).host} · ${verified} servers verified · ${MIN_PUBLICATION_SERVERS} required`;
    this.el("publication-receipts").hidden = false;
    this.copyWarnings();
    this.stage("propagating", `Copy files · ${verified} servers verified`, "active");
  }
  private verifiedCopies() { return this.#journal ? verifiedPublicationServers(this.#journal.prepared.files, this.#journal.prepared.servers, [...this.#propagation.values()]).length : 0; }
  private copyWarnings() {
    const failures = [...this.#propagation.values()].filter(item => item.state === "failed");
    const warning = this.el("publication-copy-warning"); warning.hidden = !failures.length;
    warning.textContent = failures.length ? `${new Set(failures.map(item => item.server)).size} file destination${new Set(failures.map(item => item.server)).size === 1 ? " is" : "s are"} unavailable.` : "";
  }
  private receipt(label: string, state: string, status: string, detail?: string) {
    const li = document.createElement("li"); li.dataset.state = state;
    const name = document.createElement("span"); name.className = "publication-receipt-name"; name.textContent = label;
    const badge = document.createElement("span"); badge.className = "publication-receipt-state"; badge.textContent = status;
    li.append(name, badge);
    if (detail) { const note = document.createElement("small"); note.textContent = detail; li.append(note); }
    return li;
  }
  private stage(name: string, label: string, state = "waiting") { const item = this.el(`publication-${name}`); item.textContent = label; item.dataset.state = state; if (state === "active") item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current"); }
  private async publish() {
    if (this.#busy || !this.#journal) return; const journal = this.#journal;
    if (journal.prepared.publisher !== this.identity.pubkey) throw new Error("Sign in with the identity that approved this publication.");
    this.#busy = true; this.sync(); this.el<HTMLButtonElement>("publication-confirm").disabled = true; this.el<HTMLButtonElement>("publication-edit").disabled = true;
    const client = this.client();
    const unchanged = () => { if (client !== this.client() || this.identity.pubkey !== journal.prepared.publisher || this.selected()?.artifactId !== journal.prepared.artifactId) throw new Error("Return to this version with its original publishing identity to continue."); };
    try {
      unchanged();
      this.el("publication-stages").hidden = false;
      this.el("publication-status").textContent = "Waiting for your applet signature…";
      this.stage("signing", "Approve in your signer", "active");
      if (!journal.event) { journal.event = await this.identity.sign(journal.prepared.template); this.save(); }
      unchanged();
      journal.prepared = await this.call({ action: "save", id: journal.prepared.id, event: journal.event }); this.#current = journal.prepared; this.save();
      if (journal.prepared.application && !journal.prepared.application.signedEvent) {
        this.el("publication-status").textContent = "Approve your application listing…";
        this.stage("signing", "Approve listing in your signer", "active");
        journal.applicationEvent ??= await this.identity.sign(journal.prepared.application.template); this.save();
        unchanged();
        journal.prepared = await this.call({ action: "save", id: journal.prepared.id, event: journal.event, applicationEvent: journal.applicationEvent }); this.#current = journal.prepared; this.save();
      }
      this.stage("signing", "Applet signed", "complete");
      this.#propagation.clear();
      if (verifiedPublicationServers(journal.prepared.files, journal.prepared.servers, journal.prepared.fileResults ?? []).length >= MIN_PUBLICATION_SERVERS) {
        for (const receipt of journal.prepared.fileResults ?? []) this.#propagation.set(`${receipt.server}:${receipt.file}`, receipt);
        await this.announce(journal); return;
      }
      const propagated = await propagateBlobs(journal.prepared.files, journal.prepared.servers, { sign: template => { if (this.identity.pubkey !== journal.prepared.publisher) throw new Error("Publishing identity changed. Sign in with the original identity to continue."); return this.identity.sign(template); } }, event => this.progress(event));
      unchanged();
      journal.prepared = await this.call({ action: "save", id: journal.prepared.id, event: journal.event, fileResults: [...this.#propagation.values()] }); this.#current = journal.prepared; this.save();
      if (!propagated) { this.stage("propagating", "More copies needed", "failed"); this.el<HTMLDetailsElement>("publication-receipts").open = true; this.el("publication-status").textContent = `${this.verifiedCopies()} of ${MIN_PUBLICATION_SERVERS} copies ready. Retry or change destinations.`; return; }
      journal.propagated = true; this.save(); this.stage("propagating", `Files verified on ${this.verifiedCopies()} servers`, "complete");
      await this.announce(journal);
    } finally { this.#busy = false; this.sync(); this.el<HTMLButtonElement>("publication-confirm").disabled = false; this.el<HTMLButtonElement>("publication-edit").disabled = false; this.el("publication-confirm").textContent = this.continueLabel(); }
  }
  private async republish() {
    if (this.#busy || !this.#journal || this.#journal.prepared.status !== "published") return;
    const journal = this.#journal; const client = this.client();
    if (!client || journal.prepared.publisher !== this.identity.pubkey || journal.prepared.artifactId !== this.selected()?.artifactId) return;
    this.#busy = this.#republishing = true; this.sync();
    const feedback = this.el("publication-share-feedback"); feedback.textContent = "Republishing to Nostr…";
    try {
      const result = await this.call({ action: "republish", id: journal.prepared.id });
      if (this.#journal !== journal || this.client() !== client || this.identity.pubkey !== journal.prepared.publisher || this.selected()?.artifactId !== journal.prepared.artifactId) return;
      journal.prepared = result; this.save(); this.result();
    } catch { feedback.textContent = "Republish could not be confirmed. Your earlier publication is still saved."; }
    finally { this.#busy = this.#republishing = false; this.sync(); }
  }
  private async check() { if (this.#busy || !this.#journal) return; const journal = this.#journal; this.#busy = true; this.sync(); this.el<HTMLButtonElement>("publication-check").disabled = true; try { journal.prepared = await this.call({ action: "reconcile", id: journal.prepared.id }); this.save(); if (this.#journal === journal) this.result(); } finally { this.#busy = false; this.sync(); this.el<HTMLButtonElement>("publication-check").disabled = false; } }
  private media(result: Publication) {
    this.el("publication-media").hidden = !result.screenshot;
    if (result.screenshot) { this.el<HTMLImageElement>("publication-screenshot").src = result.screenshot; this.el<HTMLImageElement>("publication-screenshot").alt = `Screenshot of ${result.title || "your applet"}`; }
  }
  private result() {
    const result = this.#journal!.prepared;
    this.#current = result; this.media(result);
    if (result.status === "published" && (!this.#latest || result.version >= this.#latest.version)) this.#latest = result;
    this.#propagation.clear(); for (const entry of result.fileResults ?? []) this.progress(entry);
    const verified = this.verifiedCopies();
    const copied = verified >= MIN_PUBLICATION_SERVERS;
    const failed = result.fileResults?.some(item => item.state === "failed") && !copied && result.status !== "published";
    this.copyWarnings();
    this.el("publication-stages").hidden = result.status === "published" || !this.#journal!.event;
    this.stage("signing", this.#journal!.event || result.status === "published" ? "Applet signed" : "Sign your applet", this.#journal!.event || result.status === "published" ? "complete" : "waiting");
    this.stage("propagating", failed ? "More copies needed" : copied ? `Files verified on ${verified} servers` : result.status === "published" ? "Files copied" : "Copy to your servers", failed ? "failed" : copied || result.status === "published" ? "complete" : "waiting");
    if (failed) this.el<HTMLDetailsElement>("publication-receipts").open = true;
    this.el("publication-receipts").hidden = !(result.fileResults?.length || result.relayResults?.length);
    this.el("publication-relay-results").replaceChildren(...(result.relayResults ?? []).map(receipt => this.receipt(new URL(receipt.relay).host, receipt.state, receipt.state === "published" ? "Confirmed" : "Unconfirmed")));
    this.el("publication-application-delivery").hidden = !result.application?.relayResults?.length;
    this.el("publication-application-results").replaceChildren(...(result.application?.relayResults ?? []).map(receipt => this.receipt(new URL(receipt.relay).host, receipt.state, receipt.state === "published" ? "Confirmed" : "Unconfirmed")));
    const relayCount = new Set((result.relayResults ?? []).filter(receipt => receipt.state === "published").map(receipt => receipt.relay)).size;
    const extras = new Set([...(result.fileResults ?? []).filter(receipt => receipt.state === "failed").map(receipt => receipt.server), ...(result.relayResults ?? []).filter(receipt => receipt.state !== "published").map(receipt => receipt.relay)]).size;
    this.el("publication-delivery-summary").textContent = `Delivery details${extras ? ` · ${extras} unavailable` : ""}`;
    if (result.status === "published" && result.address) {
      this.stage("announcing", "Publication confirmed", "complete"); this.el("publication-status").textContent = "Your signed applet is available on Nostr."; this.el("publication-result").hidden = false; this.el("publication-prepare").hidden = true; this.el("publication-review-panel").hidden = true; this.el("publication-check").hidden = true;
      this.#panel.dataset.published = "true";
      this.el("publication-heading").textContent = "Published.";
      this.el("publication-version").hidden = true; this.el("publication-history").hidden = true;
      this.el("publication-status").hidden = true;
      this.el("publication-result-title").textContent = result.title || "Your applet";
      const listed = result.application?.relayResults?.some(receipt => receipt.state === "published");
      this.el("publication-listing").hidden = !result.application;
      this.el("publication-listing").textContent = listed ? "✓ Application listing shared with screenshot" : "Applet published. Listing unconfirmed — Republish to retry.";
      const resent = result.republication?.relayResults.filter(receipt => receipt.state === "published").length ?? 0;
      this.el("publication-share-feedback").textContent = result.republication ? resent ? `Republished · ${resent} relay${resent === 1 ? "" : "s"} confirmed.` : "No new confirmations. Your earlier publication is still saved." : "Paste its naddr into any compatible shell.";
      this.el<HTMLDetailsElement>("publication-receipts").open = false;
      this.el<HTMLInputElement>("publication-address").value = result.address;
      this.el("publication-completion").textContent = `Version ${result.version} · ${verified} file copies · ${relayCount} relay${relayCount === 1 ? "" : "s"} confirmed`;
      this.el<HTMLAnchorElement>("publication-open").href = result.url!;
    } else { this.el("publication-status").textContent = result.status === "prepared" ? this.#journal!.event ? copied ? "Your files are ready to publish." : `Signature saved. ${verified} of ${MIN_PUBLICATION_SERVERS} copies ready.` : "Publication is saved. Continue when ready." : "No relay has confirmed yet. Retry or choose another relay."; this.el("publication-check").hidden = !this.#journal!.event; if (result.status !== "prepared") this.stage("announcing", "No relay confirmation", "failed"); }
    this.el("publication-confirm").textContent = this.continueLabel();
    this.sync();
  }
  private error(error: unknown) { this.el("publication-status").textContent = error instanceof Error ? error.message : "Publication could not complete. Your verified preview is safe."; this.el("publication-check").hidden = false; this.el("publication-check").textContent = this.#journal ? "Check publication" : "Try again"; this.#panel.querySelectorAll<HTMLElement>('[data-state="active"]').forEach(item => { item.dataset.state = "failed"; item.removeAttribute("aria-current"); }); }
  private async copy(value: string, status: HTMLElement) { try { await navigator.clipboard.writeText(value); status.textContent = "naddr copied. Paste it into a compatible shell."; } catch { const field = document.createElement("input"); field.value = value; field.readOnly = true; field.setAttribute("aria-label", "Copy this naddr"); status.replaceChildren(field); field.select(); } }
}
