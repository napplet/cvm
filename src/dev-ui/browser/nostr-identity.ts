import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { browserSignerKey, type ContextVmSigner } from "./contextvm-client";
import { generateSecretKey, getPublicKey, getEventHash, verifyEvent, type EventTemplate, type Event } from "nostr-tools/pure";
import { bunkerSession, encodeNbunksec, keyBytes, readIdentitySession, writeIdentitySession, type IdentitySession } from "./identity-session";
import { BunkerSigner, createNostrConnectURI } from "nostr-tools/nip46";
import { SimplePool } from "nostr-tools/pool";
import { qrcodegen } from "../../../infra/vendor/qrcode/qr.js";

type Extension = { getPublicKey(): Promise<string>; signEvent(template: EventTemplate): Promise<Event>; nip44?: ContextVmSigner["nip44"] };
const extension = () => (window as unknown as { nostr?: Extension }).nostr;
const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
type Identity = { pubkey: string; mode: "anonymous" | "nip07" | "nip46"; sign(template: EventTemplate): Promise<Event>; nip44?: ContextVmSigner["nip44"]; leases?: number; retire?(): void };
export class PublishingIdentity {
  #identity?: Identity;
  #generation = 0;
  #listeners = new Set<() => void>();
  #abort?: AbortController;
  #pool?: SimplePool;
  #bunker?: BunkerSigner;
  #saved?: IdentitySession;
  #restoring = false;
  #waitingForExtension = false;
  ready: Promise<void> = Promise.resolve();
  readonly #dialog: HTMLDialogElement;
  readonly #storageKey: string;
  readonly #sessionKey: string;
  constructor(servicePubkey: string, private readonly changed: () => void) {
    this.#storageKey = `applet-broker/publisher/v1/${servicePubkey}`;
    this.#sessionKey = `applet-broker/identity/v1/${servicePubkey}`;
    this.#saved = readIdentitySession(this.#sessionKey);
    const button = document.createElement("button"); button.id = "nostr-sign-in"; button.className = "quiet"; button.textContent = "Sign in";
    document.querySelector(".header-actions")?.prepend(button);
    this.#dialog = document.createElement("dialog"); this.#dialog.id = "nostr-identity"; this.#dialog.setAttribute("aria-labelledby", "nostr-heading");
    this.#dialog.innerHTML = `<div class="dialog-header"><h2 id="nostr-heading">Your Nostr identity</h2><button id="nostr-close" class="icon-button" aria-label="Close sign-in">×</button></div><p>Sign in whenever you’re ready. Your current build keeps running.</p>
      <div class="identity-options" role="group" aria-label="Sign-in method"><button id="nostr-anonymous">Anonymous</button><button id="nostr-extension" disabled>NIP-07 · extension</button><button id="nostr-remote" aria-pressed="true">NIP-46 · remote signer</button></div>
      <p id="nostr-extension-hint" class="supporting"></p><p id="nostr-status" role="status"></p>
      <div id="nostr-connect"><p>Scan with your Nostr signer.</p><div id="nostr-qr" aria-label="NostrConnect sign-in QR code" role="img"></div><div class="row"><a id="nostr-open">Open signer</a><button id="nostr-copy">Copy connection</button></div><details><summary>Connection relay</summary><label for="nostr-relay">Relay URL</label><input id="nostr-relay" value="wss://relay.nsec.app"><button id="nostr-retry">Create new QR code</button></details></div>
      <a id="nostr-approve" target="_blank" rel="noopener noreferrer" hidden>Approve in your signer</a><button id="nostr-restore" hidden>Reconnect saved signer</button><button id="nostr-sign-out" hidden>Sign out</button>`;
    document.body.append(this.#dialog);
    button.onclick = () => { this.detectExtension(); this.#dialog.showModal(); if (!this.#identity && !this.#saved) this.ready = this.remote(); };
    this.el("nostr-close").onclick = () => this.#dialog.close();
    this.#dialog.addEventListener("close", () => { if (!this.#identity && !this.#restoring) this.cancel(); });
    this.el("nostr-anonymous").onclick = () => {
      this.reset(); const generation = this.#generation; this.save();
      const secret = browserSignerKey(servicePubkey); const signer = new PrivateKeySigner(secret); sessionStorage.setItem(this.#storageKey, secret);
      this.ready = signer.getPublicKey().then(pubkey => { if (generation === this.#generation) this.use({ pubkey, mode: "anonymous", sign: template => signer.signEvent({ ...template, pubkey }), nip44: signer.nip44 }); });
    };
    this.el("nostr-extension").onclick = () => { this.ready = this.nip07(); };
    this.el("nostr-remote").onclick = this.el("nostr-retry").onclick = () => { this.ready = this.remote(); };
    this.el("nostr-restore").onclick = () => { this.ready = this.restore(); };
    this.el("nostr-sign-out").onclick = () => { this.reset(); this.save(); this.render(); this.notify(); };
    const detect = () => { this.detectExtension(); if (this.#waitingForExtension && extension()?.getPublicKey && extension()?.signEvent) this.ready = this.restore(); };
    window.addEventListener("focus", detect); window.addEventListener("nostr:ready", detect); this.detectExtension();
    for (const delay of [250, 1000, 3000]) setTimeout(detect, delay);
    window.addEventListener("storage", event => {
      if (event.storageArea !== localStorage || (event.key !== null && event.key !== this.#sessionKey)) return;
      this.reset(); this.#saved = readIdentitySession(this.#sessionKey); this.render(); this.notify(); this.ready = this.restore();
    });
    const stored = sessionStorage.getItem(this.#storageKey);
    if (!this.#saved && stored && /^[a-f0-9]{64}$/.test(stored)) {
      try { const key = Uint8Array.from(stored.match(/../g)!, byte => Number.parseInt(byte, 16)); const signer = new PrivateKeySigner(stored); this.#identity = { pubkey: getPublicKey(key), mode: "anonymous", sign: template => signer.signEvent({ ...template, pubkey: getPublicKey(key) }), nip44: signer.nip44 }; } catch { sessionStorage.removeItem(this.#storageKey); }
    }
    this.render();
    // Defer notification until consumers have finished constructing themselves.
    this.ready = Promise.resolve().then(() => this.restore());
  }
  onChange(listener: () => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  private notify() { this.changed(); for (const listener of this.#listeners) listener(); }
  captureSigner(): ContextVmSigner {
    const identity = this.#identity;
    if (!identity?.nip44?.decrypt) throw new Error("Your signer needs NIP-44 support for private CVM requests. Use a compatible extension or remote signer.");
    identity.leases = (identity.leases ?? 0) + 1;
    let released = false;
    return { getPublicKey: async () => identity.pubkey, signEvent: async template => {
      if (released) throw new Error("Signer connection closed");
      const event = JSON.parse(JSON.stringify(await identity.sign(structuredClone(template)))) as Event;
      if (event.pubkey !== identity.pubkey || event.id !== getEventHash({ ...template, pubkey: identity.pubkey }) || !verifyEvent(event)) throw new Error("Signer returned an invalid CVM request.");
      return event;
    }, nip44: identity.nip44, release: () => { if (released) return; released = true; identity.leases!--; if (!identity.leases) identity.retire?.(); } };
  }
  get pubkey() { return this.#identity?.pubkey; }
  async requireReady() { await this.ready; if (this.#saved && !this.#identity) throw new Error("Reconnect your saved Nostr signer, or choose Anonymous in Sign in, before starting a new applet."); }
  get label() { return this.#identity ? `${this.#identity.mode === "anonymous" ? "Anonymous" : this.#identity.mode === "nip07" ? "NIP-07" : "NIP-46"} · ${this.#identity.pubkey.slice(0, 12)}` : "Signed out"; }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.#dialog.querySelector<T>(`#${id}`)!; }
  private detectExtension() { const available = !!extension()?.getPublicKey && !!extension()?.signEvent; this.el<HTMLButtonElement>("nostr-extension").disabled = !available; this.el("nostr-extension-hint").textContent = available ? "Browser extension available." : "NIP-07 requires a Nostr browser extension."; }
  private cancel() { this.#generation++; this.#abort?.abort(); this.#abort = undefined; this.#restoring = false; this.#waitingForExtension = false; const bunker = this.#bunker; const pool = this.#pool;
    // Subscription CLOSE frames are queued asynchronously. Let them flush before
    // destroying their sockets, including when a QR connection was canceled.
    const retire = () => { void (async () => { await bunker?.close().catch(() => undefined); pool?.destroy(); })(); };
    if (bunker || pool) { if (this.#identity?.leases) this.#identity.retire = retire; else retire(); }
    this.#bunker = undefined; this.#pool = undefined; this.el("nostr-approve").hidden = true; }
  private reset() { this.cancel(); this.#identity = undefined; sessionStorage.removeItem(this.#storageKey); }
  private save(session?: IdentitySession) { this.#saved = session; return writeIdentitySession(this.#sessionKey, session); }
  private use(identity: Identity) { if (!/^[a-f0-9]{64}$/.test(identity.pubkey)) throw new Error("Invalid signer identity"); this.#identity = identity; this.render(); this.notify(); this.#dialog.close(); }
  private render() {
    document.getElementById("nostr-sign-in")!.textContent = this.#identity ? this.label : this.#restoring ? "Reconnecting…" : this.#saved ? "Reconnect signer" : "Sign in";
    this.el("nostr-status").textContent = this.#identity ? `Signed in: ${this.label}` : this.#restoring ? "Reconnecting to your saved signer…" : "Choose a signing identity to enable publishing.";
    this.el("nostr-connect").hidden = !!this.#identity || !!this.#saved;
    this.el("nostr-sign-out").hidden = !this.#identity && !this.#saved;
    this.el("nostr-restore").hidden = !this.#saved || !!this.#identity;
    this.el<HTMLButtonElement>("nostr-restore").disabled = this.#restoring;
  }
  private async bounded<T>(work: Promise<T>, abort: AbortController, milliseconds: number): Promise<T> {
    let rejectAbort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("Signer connection interrupted")); });
    abort.signal.addEventListener("abort", rejectAbort, { once: true });
    const timer = setTimeout(() => abort.abort(), milliseconds);
    try { if (abort.signal.aborted) rejectAbort(); return await Promise.race([work, interrupted]); }
    finally { clearTimeout(timer); abort.signal.removeEventListener("abort", rejectAbort); }
  }
  private async nip07(restoring = false) {
    this.reset(); if (!restoring) this.save(); const generation = this.#generation;
    this.#restoring = true; this.render(); this.notify();
    try {
      const signer = extension();
      if (!signer?.getPublicKey || !signer.signEvent) { this.#waitingForExtension = restoring; throw new Error("Extension unavailable"); }
      const abort = new AbortController(); this.#abort = abort;
      const pubkey = await this.bounded(signer.getPublicKey(), abort, 30000);
      if (generation !== this.#generation) return;
      if (!/^[a-f0-9]{64}$/.test(pubkey)) throw new Error("Invalid signer identity");
      const persisted = this.save({ mode: "nip07" }); this.#restoring = false;
      this.use({ pubkey, mode: "nip07", sign: template => signer.signEvent(template), nip44: signer.nip44 });
      if (!persisted) this.el("nostr-status").textContent = "Signed in for this visit. Browser storage is unavailable, so sign-in could not be remembered.";
    } catch {
      if (generation === this.#generation) {
        this.#restoring = false; this.render(); this.notify();
        this.el("nostr-status").textContent = restoring ? "Your extension sign-in is saved. Unlock or enable your extension, then reconnect." : "Extension sign-in was not approved. You can try again.";
      }
    }
  }
  private approve(value: string, generation: number) {
    if (generation !== this.#generation) return;
    try { const url = new URL(value); if (url.protocol !== "https:") return; const link = this.el<HTMLAnchorElement>("nostr-approve"); link.href = url.href; link.hidden = false; } catch { /* Untrusted signer URL. */ }
  }
  private remoteIdentity(pubkey: string, signer: BunkerSigner): Identity {
    return { pubkey, mode: "nip46", sign: template => signer.signEvent(template), nip44: { encrypt: (pubkey, text) => signer.nip44Encrypt(pubkey, text), decrypt: (pubkey, text) => signer.nip44Decrypt(pubkey, text) } };
  }
  private async restore() {
    const saved = this.#saved; if (!saved) return;
    if (saved.mode === "nip07") return this.nip07(true);
    this.reset(); const generation = this.#generation;
    this.#restoring = true; this.render(); this.notify();
    try {
      const info = bunkerSession(saved.nbunksec);
      const pool = new SimplePool(); this.#pool = pool;
      const signer = BunkerSigner.fromBunker(keyBytes(info.local_key), { pubkey: info.pubkey, relays: info.relays, secret: info.secret ?? null }, { pool, onauth: url => this.approve(url, generation) });
      this.#bunker = signer;
      const abort = new AbortController(); this.#abort = abort;
      const pubkey = await this.bounded(signer.getPublicKey(), abort, 15000);
      if (generation !== this.#generation) return;
      if (pubkey !== saved.pubkey) throw new Error("Saved signer identity changed");
      this.#restoring = false; this.use(this.remoteIdentity(pubkey, signer));
    } catch {
      if (generation === this.#generation) {
        this.cancel(); this.render(); this.notify();
        this.el("nostr-status").textContent = "Your remote sign-in is saved. Open your signer, then reconnect. You don’t need a new QR code.";
      }
    }
  }
  private async remote() {
    this.reset(); this.save(); const generation = this.#generation;
    this.render(); this.notify();
    try {
      const relay = new URL(this.el<HTMLInputElement>("nostr-relay").value);
      if (!["ws:", "wss:"].includes(relay.protocol) || relay.username || relay.password || relay.hash) throw new Error("Invalid relay");
      const key = generateSecretKey(); const uri = createNostrConnectURI({ clientPubkey: getPublicKey(key), relays: [relay.href], secret: hex(generateSecretKey()), perms: ["get_public_key", "sign_event:35129", "sign_event:32267", "sign_event:24242", "sign_event:25910", "nip44_encrypt", "nip44_decrypt"], name: "applet.broker", url: location.origin });
      this.drawQr(uri); this.el<HTMLAnchorElement>("nostr-open").href = uri;
      this.el("nostr-copy").onclick = () => { void navigator.clipboard.writeText(uri).then(() => { this.el("nostr-status").textContent = "Connection copied. Waiting for your signer…"; }).catch(() => { this.el("nostr-status").textContent = "Copy unavailable; scan the QR code or open your signer."; }); };
      this.el("nostr-status").textContent = "Waiting for approval in your Nostr signer…";
      const abort = new AbortController(); this.#abort = abort;
      const timer = setTimeout(() => abort.abort(), 300000);
      const pool = new SimplePool(); this.#pool = pool;
      try {
        const signer = await BunkerSigner.fromURI(key, uri, { pool, skipSwitchRelays: true, onauth: value => this.approve(value, generation) }, abort.signal);
        if (generation !== this.#generation) { await signer.close(); return; }
        this.#bunker = signer;
        const pubkey = await this.bounded(signer.getPublicKey(), abort, 30000);
        if (generation !== this.#generation) return;
        if (!/^[a-f0-9]{64}$/.test(pubkey)) throw new Error("Invalid signer identity");
        const nbunksec = encodeNbunksec({ pubkey: signer.bp.pubkey, local_key: hex(key), relays: signer.bp.relays, ...(signer.bp.secret ? { secret: signer.bp.secret } : {}) });
        bunkerSession(nbunksec);
        const persisted = this.save({ mode: "nip46", nbunksec, pubkey });
        this.use(this.remoteIdentity(pubkey, signer));
        if (!persisted) this.el("nostr-status").textContent = "Signed in for this visit. Browser storage is unavailable, so sign-in could not be remembered.";
      } finally { clearTimeout(timer); }
    } catch { if (generation === this.#generation) { this.cancel(); this.el("nostr-status").textContent = "Signer connection ended. Create a new QR code to try again."; } }
  }
  private drawQr(value: string) {
    const qr = qrcodegen.QrCode.encodeText(value, qrcodegen.QrCode.Ecc.MEDIUM);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", `0 0 ${qr.size + 8} ${qr.size + 8}`); svg.setAttribute("shape-rendering", "crispEdges");
    const background = document.createElementNS(svg.namespaceURI, "rect"); background.setAttribute("width", "100%"); background.setAttribute("height", "100%"); background.setAttribute("fill", "white"); svg.append(background);
    const cells: string[] = []; for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) cells.push(`M${x + 4},${y + 4}h1v1h-1z`);
    const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", cells.join(" ")); path.setAttribute("fill", "black"); svg.append(path); this.el("nostr-qr").replaceChildren(svg);
  }
  async sign(template: EventTemplate): Promise<Event> {
    const identity = this.#identity; if (!identity) throw new Error("Sign in before publishing.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([identity.sign(structuredClone(template)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Signer approval timed out. No publication was submitted.")), 120000); })]);
      const event = JSON.parse(JSON.stringify(result)) as Event;
      if (identity !== this.#identity || event.pubkey !== identity.pubkey || event.id !== getEventHash({ ...template, pubkey: identity.pubkey }) || !verifyEvent(event)) throw new Error("Signer returned a different identity or event. Publication stopped.");
      return event;
    } finally { clearTimeout(timer); }
  }
}
