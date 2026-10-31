import { z } from "zod";
import { createRuntime, type RuntimeAdapter } from "@kehto/runtime";
import { prepareNappletSrcdoc } from "@kehto/shell";
import { verifyEvent } from "nostr-tools/pure";
import { verifyDirectArtifactDelivery } from "./direct-delivery";

const liveDomains = Object.freeze(["storage"]);
const activeFrames = new WeakSet<HTMLIFrameElement>();
const Approval = z.object({ reviewSha256: z.string().regex(/^[a-f0-9]{64}$/u), domains: z.array(z.string().min(1).max(32)).max(32) }).strict();
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
type Verified = Awaited<ReturnType<typeof verifyDirectArtifactDelivery>>;
async function review(verified: Verified) {
  const { artifact, capabilities } = verified.delivery;
  return Object.freeze({ reviewSha256: await digest({ artifact, required: [...capabilities.required].sort(), optional: [...capabilities.optional].sort() }),
    artifactId: artifact.artifactId, artifactHash: artifact.artifactHash,
    required: Object.freeze([...capabilities.required]), optional: Object.freeze([...capabilities.optional]), available: liveDomains,
    missingRequired: Object.freeze(capabilities.required.filter(domain => !liveDomains.includes(domain))),
    missingOptional: Object.freeze(capabilities.optional.filter(domain => !liveDomains.includes(domain))) });
}

/** Display this exact review and obtain host-owned consent before mounting.
 * No domains are granted by loading or reviewing the delivered source. */
export async function reviewDirectPreview(source: unknown, expected: Readonly<{ sessionId: string; artifactId: string }>) {
  return review(await verifyDirectArtifactDelivery(source, expected));
}

/** Actual upstream kernel with private, ephemeral preview persistence. No
 * development signer, owner signer, shell secret, relay or remote backend is
 * installed. The browser host owns only source binding and NAP-SHELL transport;
 * the upstream kernel owns all granted domain RPCs and ACL enforcement. */
export async function mountDirectPreview(input: Readonly<{ iframe: HTMLIFrameElement; source: unknown; expected: Readonly<{ sessionId: string; artifactId: string }>;
  approval: unknown; signal?: AbortSignal }>) {
  const verified = await verifyDirectArtifactDelivery(input.source, input.expected), checked = await review(verified), approval = Approval.parse(input.approval);
  const domains = Object.freeze([...approval.domains]);
  if (approval.reviewSha256 !== checked.reviewSha256 || new Set(domains).size !== domains.length
    || domains.some(domain => !liveDomains.includes(domain) || ![...checked.required, ...checked.optional].includes(domain))
    || checked.required.some(domain => !domains.includes(domain)) || checked.missingRequired.length) throw new Error("DIRECT_PREVIEW_CONSENT_OR_COMPATIBILITY_REQUIRED");
  const frame = input.iframe;
  if (input.signal?.aborted || frame.ownerDocument.defaultView !== window || !frame.isConnected || activeFrames.has(frame)
    || frame.srcdoc || frame.hasAttribute("src")) throw new Error("DIRECT_PREVIEW_FRESH_FRAME_REQUIRED");
  const names = verified.delivery.ownerManifestTemplate.tags.filter(tag => tag[0] === "d");
  if (names.length !== 1 || names[0]!.length !== 2 || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(names[0]![1]!)) throw new Error("DIRECT_PREVIEW_IDENTITY_REQUIRED");
  const dTag = names[0]![1]!, contentHash = verified.delivery.artifact.artifactHash, windowId = `preview:${crypto.randomUUID()}`;
  const memory = new Map<string, string>(), encoder = new TextEncoder();
  const size = (key: string, value: string) => encoder.encode(key).length + encoder.encode(value).length;
  const used = (exclude?: string) => [...memory.entries()].reduce((total, [key, value]) => total + (key === exclude ? 0 : size(key, value)), 0);
  let closed = false, initialized = false, settled = false;
  const denied = () => { throw new Error("DIRECT_PREVIEW_CAPABILITY_UNAVAILABLE"); };
  frame.setAttribute("sandbox", "allow-scripts"); frame.referrerPolicy = "no-referrer";
  frame.removeAttribute("allow"); frame.removeAttribute("allowfullscreen");
  const child = frame.contentWindow;
  if (!child) throw new Error("DIRECT_PREVIEW_FRAME_REQUIRED");
  const prepared = prepareNappletSrcdoc(new TextDecoder("utf-8", { fatal: true }).decode(verified.bytes), { domains,
    csp: { connectOrigins: [], directives: { "img-src": ["data:", "blob:"], "font-src": ["data:"], "frame-src": ["'none'"], "worker-src": ["'none'"], "media-src": ["'none'"] } } });
  const adapter: RuntimeAdapter = {
    sendToNapplet(target, message) { if (!closed && initialized && target === windowId && frame.isConnected && frame.contentWindow === child) child.postMessage(message, "*"); },
    isDomainAllowed(target, domain) { return !closed && initialized && target === windowId && domains.includes(domain); },
    auth: { getUserPubkey: () => null, getSigner: () => null }, config: { getNappUpdateBehavior: () => "silent-reprompt" },
    hotkeys: { executeHotkeyFromForward: denied }, crypto: { verifyEvent: async event => verifyEvent(event), randomUUID: () => crypto.randomUUID(), randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) },
    aclPersistence: { load: () => null, persist() {} }, manifestPersistence: { load: () => null, persist() {} },
    statePersistence: { get: key => memory.get(key) ?? null,
      set(key, value) { if (closed || typeof key !== "string" || typeof value !== "string" || (!memory.has(key) && memory.size >= 512) || used(key) + size(key, value) > 262_144) return false; memory.set(key, value); return true; },
      remove: key => { memory.delete(key); }, clear: prefix => { for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key); },
      keys: prefix => [...memory.keys()].filter(key => key.startsWith(prefix)),
      calculateBytes: (prefix, exclude) => [...memory.entries()].reduce((total, [key, value]) => total + (key.startsWith(prefix) && key !== `${prefix}${exclude}` ? size(key, value) : 0), 0) },
    windowManager: { createWindow: () => null }, relayConfig: { addRelay: denied, removeRelay: denied, getRelayConfig: () => ({ discovery: [], super: [], outbox: [] }), getNip66Suggestions: () => [] },
  };
  const runtime = createRuntime(adapter);
  // Upstream's historical field name carries current content identity, as in
  // its verified direct-pointer API. No CVM legacy aggregate is constructed.
  runtime.sessionRegistry.register(windowId, { pubkey: "", windowId, origin: "null", type: "nip5d", dTag, aggregateHash: contentHash,
    registeredAt: Date.now(), instanceId: crypto.randomUUID(), provenance: "nip-5d" });
  if (domains.includes("storage")) {
    runtime.aclState.grant("", dTag, contentHash, "state:read");
    runtime.aclState.grant("", dTag, contentHash, "state:write");
  }
  let resolveReady: () => void = () => {}, rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const close = () => {
    if (closed) return; closed = true; initialized = false;
    clearTimeout(timer); observer.disconnect(); window.removeEventListener("message", receive); input.signal?.removeEventListener("abort", close);
    frame.removeEventListener("load", load);
    try { runtime.destroyWindow(windowId); runtime.destroy(); } finally {
      memory.clear(); activeFrames.delete(frame); frame.remove();
      if (!settled) { settled = true; rejectReady(new Error("DIRECT_PREVIEW_CLOSED_BEFORE_READY")); }
    }
  };
  let loads = 0;
  const load = () => { if (++loads > 1) close(); };
  const receive = (event: MessageEvent) => {
    if (closed || event.source !== child || event.origin !== "null") return;
    if (!frame.isConnected || frame.contentWindow !== child || frame.getAttribute("sandbox") !== "allow-scripts" || frame.srcdoc !== prepared || frame.hasAttribute("src")) { close(); return; }
    try {
      const value: unknown = event.data;
      if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 65_536) return;
      const envelope = z.object({ type: z.string().min(1).max(128) }).passthrough().parse(value);
      if (envelope.type === "shell.ready") {
        if (initialized || Object.keys(envelope).length !== 1) return;
        initialized = true;
        child.postMessage({ type: "shell.init", capabilities: { domains }, services: [] }, "*");
        clearTimeout(timer); settled = true; resolveReady(); return;
      }
      if (initialized) runtime.handleMessage(windowId, value);
    } catch { /* Untrusted iframe payloads cannot establish another identity. */ }
  };
  const observer = new MutationObserver(() => { if (!frame.isConnected || frame.srcdoc !== prepared || frame.getAttribute("sandbox") !== "allow-scripts" || frame.hasAttribute("src")) close(); });
  const timer = setTimeout(close, 10_000);
  activeFrames.add(frame); window.addEventListener("message", receive); input.signal?.addEventListener("abort", close, { once: true }); frame.addEventListener("load", load);
  frame.srcdoc = prepared;
  observer.observe(frame.ownerDocument, { subtree: true, childList: true, attributes: true, attributeFilter: ["srcdoc", "src", "sandbox"] });
  try { await ready; } catch (error) { close(); throw error; }
  return Object.freeze({ artifactId: verified.delivery.artifact.artifactId, artifactHash: contentHash, domains, close });
}
