import { NappletDiscovery } from "./napplet-discovery";
import { REMIX_HTML_CONTEXT_LIMIT, remixAddress, type RemixManifest } from "../../remix/manifest";
import type { DevelopmentContextVmClient } from "./contextvm-client";
import type { PublishingIdentity } from "./nostr-identity";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const discoveryShape = [
  "M120 50C158.66 50 190 81.34 190 120C190 158.66 158.66 190 120 190C81.34 190 50 158.66 50 120C50 81.34 81.34 50 120 50Z",
  "M120 50C184 50 190 56 190 120C190 184 184 190 120 190C56 190 50 184 50 120C50 56 56 50 120 50Z",
  "M120 38C134 38 202 106 202 120C202 134 134 202 120 202C106 202 38 134 38 120C38 106 106 38 120 38Z",
];
const discoveryLoader = `<div id="explore-loading" class="discovery-loading" role="status" aria-live="polite" aria-hidden="true">
  <div class="discovery-loading-art" aria-hidden="true">
    <svg id="explore-loading-shape" viewBox="0 0 240 240" fill="none" focusable="false">
      <defs><path id="discovery-morph" pathLength="100" d="${discoveryShape[0]}"><animate attributeName="d" values="${[...discoveryShape, discoveryShape[0]].join(";")}" dur="7.2s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.333;0.666;1" keySplines="0.45 0 0.2 1;0.45 0 0.2 1;0.45 0 0.2 1"/></path></defs>
      <circle class="discovery-orbit" cx="120" cy="120" r="108"/>
      <g class="discovery-shape-turn"><use href="#discovery-morph" class="discovery-shape-trace"/><use href="#discovery-morph" class="discovery-shape-line"/></g>
      <circle class="discovery-center" cx="120" cy="120" r="3"/>
    </svg>
  </div>
  <div class="discovery-loading-copy"><p id="explore-loading-title">Finding your applets</p><p id="explore-loading-detail">Looking across your publishing relays</p></div>
</div>`;
/** Public discovery never executes the downloaded applet. All service work uses CVM. */
export class RemixWorkspace {
  #enabled = false;
  #resolved?: { manifest: RemixManifest; html: string };
  #resolveAbort?: AbortController;
  #browseAbort?: AbortController;
  #timer?: ReturnType<typeof setTimeout>;
  #items: RemixManifest[] = [];
  #network = false;
  #key: string;
  constructor(private readonly discovery: NappletDiscovery, private readonly identity: PublishingIdentity, servicePubkey: string, private readonly busy: () => boolean) {
    this.#key = `applet-broker/remix/v1/${servicePubkey}`;
    const mode = document.createElement("div"); mode.className = "remix-mode";
    mode.innerHTML = `<div class="remix-options" role="group" aria-label="Starting point"><button id="create-mode" aria-pressed="true">New idea</button><button id="remix-mode" aria-pressed="false">Remix an applet</button><a href="#/explore">Browse applets ↗</a></div><div id="remix-fields" hidden><label for="remix-address">Applet address</label><input id="remix-address" placeholder="naddr1…" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="remix-status"><p id="remix-status" class="supporting" role="status"></p><button id="remix-retry" class="text-button" hidden>Try again</button></div>`;
    el("idea-step").querySelector(".idea-card")!.before(mode);
    const review = document.createElement("p"); review.id = "remix-review"; review.className = "supporting"; review.hidden = true;
    el("setup-step").querySelector(".setup-card")!.before(review);
    const basis = document.createElement("p"); basis.id = "remix-basis"; basis.className = "supporting"; basis.hidden = true;
    el("build-step").querySelector(".workspace-title")!.after(basis);
    el("create-mode").onclick = () => this.mode(false);
    el("remix-mode").onclick = () => { this.mode(true); el("remix-address").focus(); };
    el("remix-address").oninput = () => this.addressChanged();
    el("remix-retry").onclick = () => this.addressChanged(0);
    el("idea-next").addEventListener("click", event => { if (!this.validate("generate")) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    el("new-applet").addEventListener("click", () => this.mode(false));
    this.mountBrowse();
    try { const saved = JSON.parse(sessionStorage.getItem(this.#key) ?? "null"); if (saved?.enabled && typeof saved.address === "string") { el<HTMLInputElement>("remix-address").value = saved.address.slice(0,4096); this.mode(true); this.addressChanged(); } } catch { /* Fresh draft. */ }
  }
  private mode(enabled: boolean) {
    this.#enabled = enabled; el("remix-fields").hidden = !enabled; el<HTMLInputElement>("remix-address").required = enabled;
    el("create-mode").setAttribute("aria-pressed", String(!enabled)); el("remix-mode").setAttribute("aria-pressed", String(enabled));
    document.querySelector<HTMLLabelElement>('label[for="idea"]')!.textContent = enabled ? "What would you like to change?" : "What would you like to make?";
    el("remix-review").hidden = !enabled; this.persist();
    if (!enabled) { this.#resolveAbort?.abort(); clearTimeout(this.#timer); this.#resolved = undefined; el("remix-basis").hidden = true; }
    else if (!this.#resolved) this.addressChanged();
  }
  private persist() { sessionStorage.setItem(this.#key, JSON.stringify({ enabled: this.#enabled, address: el<HTMLInputElement>("remix-address").value })); }
  private addressChanged(delay = 300) {
    clearTimeout(this.#timer); this.#resolveAbort?.abort(); this.#resolved = undefined; this.persist();
    el("remix-retry").hidden = true; el("remix-review").textContent = "Resolve the starting applet before creating your remix.";
    const input = el<HTMLInputElement>("remix-address");
    try { remixAddress(input.value); input.removeAttribute("aria-invalid"); }
    catch (error) { input.setAttribute("aria-invalid", "true"); el("remix-status").textContent = error instanceof Error ? error.message : "Enter a valid napplet address."; return; }
    el("remix-status").textContent = "Finding the applet and checking its file…";
    const abort = new AbortController(); this.#resolveAbort = abort;
    this.#timer = setTimeout(() => { void this.discovery.resolve(input.value, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      if (new TextEncoder().encode(result.html).length > REMIX_HTML_CONTEXT_LIMIT && !result.manifest.source) throw new Error("This applet has no linked source and its HTML is larger than 128 KB. Choose a smaller applet to remix.");
      this.#resolved = result;
      const detail = `${result.manifest.title} · File verified. ${result.manifest.source ? "The CVM will try its linked source first." : "The published applet will be the starting point."}`;
      el("remix-status").textContent = detail; el("remix-review").textContent = `Remixing ${result.manifest.title}. ${result.manifest.source ? "Source preferred; published HTML is the fallback." : "Starting from its verified HTML."}`;
    }).catch(error => { if (!abort.signal.aborted) { el("remix-status").textContent = error instanceof Error ? error.message : "The applet could not be loaded."; el("remix-retry").hidden = false; } }); }, delay);
  }
  validate(action: string) {
    if (action !== "generate" || !this.#enabled || this.#resolved) return true;
    el("back-idea").click(); el("remix-address").focus(); return false;
  }
  async prepare(client: DevelopmentContextVmClient): Promise<string | undefined> {
    if (!this.#enabled) return;
    const resolved = this.#resolved; if (!resolved) throw new Error("Wait for the starting applet to finish loading.");
    const bytes = new TextEncoder().encode(resolved.html);
    const assetUploaded = bytes.length <= REMIX_HTML_CONTEXT_LIMIT;
    if (assetUploaded) {
      const total = Math.ceil(bytes.length / 8000);
      for (let index = 0; index < total; index++) {
        const data = btoa(String.fromCharCode(...bytes.slice(index * 8000, (index + 1) * 8000)));
        const part = await client.callTool("remix_import", { action: "asset_part", eventId: resolved.manifest.event.id, artifactHash: resolved.manifest.artifactHash, index, total, data });
        if (part.status !== "part_saved") throw new Error(part.detail ?? "The starting applet could not be transferred. Try again.");
      }
    }
    const command = { naddr: resolved.manifest.naddr, event: resolved.manifest.event, assetUploaded };
    if (new TextEncoder().encode(JSON.stringify(command)).length > 48000) throw new Error("This applet’s metadata is too large to import.");
    const result = await client.callTool("remix_import", command);
    if (result.status !== "ready" || !/^remix:[a-f0-9]{64}$/u.test(result.reference)) throw new Error(result.detail ?? "The starting applet could not be prepared.");
    el("remix-review").textContent = result.detail;
    el("remix-basis").hidden = false; el("remix-basis").textContent = `Remixing ${resolved.manifest.title}. ${result.detail}`;
    const note = document.createElement("li"); note.textContent = `Remix: ${result.detail}`; el("timeline").append(note);
    el("progress-detail").textContent = result.detail;
    return result.reference;
  }
  private mountBrowse() {
    const link = document.createElement("a"); link.id = "browse-applets"; link.className = "app-nav-item"; link.href = "#/explore"; link.textContent = "Explore";
    document.querySelector(".app-navigation")!.append(link);
    const page = document.createElement("section"); page.id = "explore-page"; page.hidden = true; page.setAttribute("aria-labelledby", "explore-heading");
    page.innerHTML = `<div class="projects-heading-row"><div><div class="eyebrow">A STARTING POINT</div><h1 id="explore-heading" tabindex="-1">Find a little inspiration.</h1><p class="intro-copy">Published applets from you and the people you follow.</p></div></div><div class="projects-navigation"><a href="#/workspace">← Return to workspace</a></div><div class="remix-options" role="group" aria-label="Browse applets"><button id="explore-mine" aria-pressed="true">Your published applets</button><button id="explore-network" aria-pressed="false">Your network</button><button id="explore-refresh" class="quiet">Refresh</button></div><div id="explore-results" class="discovery-results" data-loading="false">${discoveryLoader}<div id="explore-content" class="discovery-results-content" aria-busy="false"><p id="explore-status" role="status" class="supporting"></p><p id="explore-error" class="form-error" role="alert"></p><button id="explore-sign-in" class="primary" hidden>Sign in to browse</button><ul id="explore-list"></ul><button id="explore-more" hidden>Show older applets</button></div></div>`;
    el("app-content").append(page);
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => {
      const shape = page.querySelector<SVGSVGElement>("#explore-loading-shape")!;
      if (motion.matches || el("explore-results").dataset.loading !== "true" || page.hidden) shape.pauseAnimations(); else shape.unpauseAnimations();
    };
    motion.addEventListener("change", syncMotion); syncMotion();
    el("explore-sign-in").onclick = () => el("nostr-sign-in").click();
    el("explore-mine").onclick = () => { this.#network = false; void this.browse(); };
    el("explore-network").onclick = () => { this.#network = true; void this.browse(); };
    el("explore-refresh").onclick = () => { void this.browse(); };
    el("explore-more").onclick = () => { void this.browse(true); };
    const route = () => {
      const visible = location.hash === "#/explore"; page.hidden = !visible;
      if (visible) {
        el("creation-workspace").hidden = true; const projects = document.getElementById("projects-page"); if (projects) projects.hidden = true;
        for (const node of document.querySelectorAll('.app-navigation a')) node.removeAttribute("aria-current"); link.setAttribute("aria-current", "page");
        document.title = "Explore — applet.broker"; document.querySelector<HTMLAnchorElement>(".skip-link")!.href = "#explore-heading"; el("explore-heading").focus({ preventScroll: true }); el("app-content").scrollTo(0,0);
        void this.browse();
      } else { link.removeAttribute("aria-current"); this.#browseAbort?.abort(); this.loading(false); }
    };
    window.addEventListener("hashchange", route); queueMicrotask(route);
    this.identity.onChange(() => { this.#browseAbort?.abort(); this.#items = []; el("explore-list").replaceChildren(); if (!page.hidden) void this.browse(); });
  }
  private loading(active: boolean, more = false) {
    const results = el("explore-results");
    // Commit the resting styles when this route first becomes visible, so its
    // entrance can transition without delaying the request or its results.
    if (active && results.dataset.loading !== "true") void results.offsetWidth;
    results.dataset.loading = String(active);
    // Keep existing cards on screen when requesting an older page.
    if (active) results.dataset.append = String(more);
    el("explore-content").inert = active && !more;
    el("explore-content").setAttribute("aria-busy", String(active));
    el("explore-loading").setAttribute("aria-hidden", String(!active));
    const shape = document.querySelector<SVGSVGElement>("#explore-loading-shape")!;
    if (active && !matchMedia("(prefers-reduced-motion: reduce)").matches) shape.unpauseAnimations(); else shape.pauseAnimations();
  }
  private async browse(more = false) {
    this.#browseAbort?.abort(); const abort = new AbortController(); this.#browseAbort = abort;
    el("explore-mine").setAttribute("aria-pressed", String(!this.#network)); el("explore-network").setAttribute("aria-pressed", String(this.#network));
    if (!more) { this.#items = []; el("explore-list").replaceChildren(); }
    el("explore-error").textContent = ""; el("explore-more").hidden = true;
    const pubkey = this.identity.pubkey; el("explore-sign-in").hidden = !!pubkey;
    if (!pubkey) { this.loading(false); el("explore-status").textContent = "Sign in to find your public applets and the people you follow. You can also remix an naddr without signing in."; return; }
    el("explore-loading-title").textContent = more ? "Looking a little further" : this.#network ? "Exploring your corner of Nostr" : "Finding your applets";
    el("explore-loading-detail").textContent = this.#network ? "Looking for applets from the people you follow" : "Looking across your publishing relays";
    if (!more) el("explore-status").textContent = "";
    this.loading(true, more);
    try {
      const until = more && this.#items.length ? Math.min(...this.#items.map(item => item.event.created_at)) - 1 : undefined;
      const items = await this.discovery.browse(pubkey, this.#network, abort.signal, until); if (abort.signal.aborted) return;
      const known = new Set(this.#items.map(item => item.naddr)); this.#items.push(...items.filter(item => !known.has(item.naddr))); this.renderCards();
      el("explore-status").textContent = this.#items.length ? `${this.#items.length} published applet${this.#items.length === 1 ? "" : "s"}. ${this.#network ? "From up to 100 people you follow." : "Drafts and ongoing builds are in Your applets."}` : this.#network ? "No applets found from the people you follow. Try a napplet address to remix one directly." : "No published applets found on your outbox relays. Your drafts are in Your applets.";
      el("explore-more").hidden = items.length === 0;
    } catch (error) { if (!abort.signal.aborted) { el("explore-status").textContent = ""; el("explore-error").textContent = error instanceof Error ? error.message : "Discovery is unavailable. Try Refresh."; } }
    finally { if (this.#browseAbort === abort) this.loading(false); }
  }
  private renderCards() {
    el("explore-list").replaceChildren(...this.#items.map(item => {
      const card = document.createElement("li"); card.className = "discovery-card";
      const title = document.createElement("h2"); title.textContent = item.title;
      const description = document.createElement("p"); description.textContent = item.description.slice(0,360) || "A published napplet.";
      const author = document.createElement("p"); author.className = "supporting"; author.textContent = `By ${item.event.pubkey.slice(0,12)}… · ${item.source ? "Source linked" : "Published HTML"}`;
      const address = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Applet address"; const code = document.createElement("code"); code.textContent = item.naddr; address.append(summary,code);
      const actions = document.createElement("div"); actions.className = "remix-options";
      const remix = document.createElement("button"); remix.className = "primary"; remix.textContent = "Remix this";
      const copy = document.createElement("button"); copy.textContent = "Copy naddr";
      copy.onclick = () => { void navigator.clipboard.writeText(item.naddr).then(() => { copy.textContent = "Copied"; }).catch(() => { address.open = true; copy.textContent = "Select address above"; }); };
      remix.onclick = () => {
        if (this.busy()) { el("explore-error").textContent = "Your current request is still running. You can browse while it finishes, then start a remix."; return; }
        el("new-applet").click(); el<HTMLInputElement>("remix-address").value = item.naddr; this.mode(true); this.addressChanged(0); location.hash = "/workspace"; el("idea").focus();
      };
      actions.append(remix,copy); card.append(title,description,author,address,actions); return card;
    }));
  }
}
