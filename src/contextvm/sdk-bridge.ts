import { verifyEvent } from "nostr-tools/pure";
import { computeCanonicalInvocationIdentity } from "@contextvm/sdk/payments/canonical-identity";
import type { NostrServerTransport } from "@contextvm/sdk/transport";
import { z } from "zod";
import type { ContextVmAnnouncement } from "./announcement";

export type ContextVmWireResponse = Readonly<{
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: Readonly<{ code: number; message: string }>;
}>;

export type ContextVmWireNotification = Readonly<{
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}>;

export type ContextVmInboundEnvelope = Readonly<{
  verifiedClientPubkey: string;
  requestEventId: string;
  rawEvent: Readonly<{ id: string; tags: readonly (readonly string[])[] }>;
  request: Readonly<{ id: string | number | null; method: string; params: unknown }>;
}>;

export interface ContextVmTransportPort {
  onInbound(handler: (input: ContextVmInboundEnvelope) => Promise<void>): void;
  configureAnnouncement(announcement: ContextVmAnnouncement): void;
  /** V2 discovery is only enabled by a ready, project-owned facade. */
  configurePricedContinuationAvailability?(available: boolean): void;
  sendResponse(clientPubkey: string, response: ContextVmWireResponse, requestEventId: string): Promise<void>;
  sendNotification(clientPubkey: string, notification: ContextVmWireNotification, requestEventId: string): Promise<void>;
  canonicalInvocation(clientPubkey: string, method: string, params: unknown): Readonly<{ clientPubkey: string; invocationHash: string }>;
}

/**
 * Explicit per-request V2 negotiation.  `nappletCvm` is project-owned MCP
 * metadata; the matching tag is part of the SDK-verified signed Nostr event.
 * Both are required so a mutable JSON-RPC metadata object cannot upgrade a
 * legacy request by itself.
 */
export const PRICED_CONTINUATION_META_KEY = "nappletCvm";
export const PRICED_CONTINUATION_VERSION = "v2";
export const PRICED_CONTINUATION_EVENT_TAG = Object.freeze(["cvm", "napplet-cvm.priced-continuation", PRICED_CONTINUATION_VERSION] as const);

export type PricedContinuationNegotiation = "absent" | "verified" | "invalid";

export function pricedContinuationNegotiation(params: unknown, tags: readonly (readonly string[])[]): PricedContinuationNegotiation {
  const values = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : undefined;
  const metadata = values?._meta && typeof values._meta === "object" && !Array.isArray(values._meta) ? values._meta as Record<string, unknown> : undefined;
  const requested = metadata?.[PRICED_CONTINUATION_META_KEY];
  const signedTag = tags.find(tag => tag[0] === PRICED_CONTINUATION_EVENT_TAG[0] && tag[1] === PRICED_CONTINUATION_EVENT_TAG[1]);
  if (requested === undefined && !signedTag) return "absent";
  if (!requested || typeof requested !== "object" || Array.isArray(requested)
    || (requested as Record<string, unknown>).pricedContinuation !== PRICED_CONTINUATION_VERSION
    || !signedTag || signedTag.length !== 3 || signedTag[2] !== PRICED_CONTINUATION_VERSION) return "invalid";
  return "verified";
}

const InboundMessageSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
}).passthrough();

const RequestEventMetaSchema = z.object({
  requestEventId: z.string().min(1).optional(),
  contextvm: z.object({ requestEventId: z.string().min(1).optional() }).passthrough().optional(),
}).passthrough();

/**
 * SDK-only transport compatibility layer. It deliberately configures a single
 * context callback: the SDK's in-memory correlations can route a reply but
 * never decide account authority or replay of a financial business effect.
 */
export class ContextVmSdkBridge implements ContextVmTransportPort {
  /**
   * Diagnostic-only signed facts used by the development harness.  It carries
   * no secret material and is deliberately overwritten rather than retained.
   */
  lastInbound?: Readonly<{ verifiedClientPubkey: string; requestEventId: string; method: string }>;
  readonly observedMethods = new Set<string>();
  #availableTools = new Set<string>();
  #pricedContinuationAvailable = false;

  constructor(private readonly transport: NostrServerTransport, private readonly extraTools: readonly string[] = []) {}

  onInbound(handler: (input: ContextVmInboundEnvelope) => Promise<void>): void {
    this.transport.onmessage = undefined;
    this.transport.onmessageWithContext = (message, context) => {
      // The SDK dispatches this callback without awaiting it.  Always consume
      // malformed wire input here so parsing errors cannot become unhandled
      // promise rejections in the Nostr event loop.
      void this.handleInbound(message, context.clientPubkey, handler).catch(() => undefined);
    };
  }

  configureAnnouncement(announcement: ContextVmAnnouncement): void {
    this.#availableTools = new Set(announcement.metadata.tools.filter(tool => tool.available && tool.invocable).map(tool => tool.name));
    const pricing = announcement.tags.filter((tag) => tag[0] === "cap").map((tag) => [...tag]);
    const extra = announcement.tags.filter((tag) => tag[0] !== "cap").map((tag) => [...tag]);
    this.transport.setAnnouncementExtraTags(extra);
    this.transport.setAnnouncementPricingTags(pricing);
    this.transport.setSupportedPaymentInteraction("optional");
  }

  configurePricedContinuationAvailability(available: boolean): void {
    this.#pricedContinuationAvailable = available === true;
  }

  async sendResponse(clientPubkey: string, response: ContextVmWireResponse, requestEventId: string): Promise<void> {
    await this.transport.sendTargetedResponse(clientPubkey, response as never, requestEventId);
  }

  async sendNotification(clientPubkey: string, notification: ContextVmWireNotification, requestEventId: string): Promise<void> {
    await this.transport.sendNotification(clientPubkey, notification as never, requestEventId);
  }

  canonicalInvocation(clientPubkey: string, method: string, params: unknown) {
    return computeCanonicalInvocationIdentity(clientPubkey, method, params);
  }

  private async handleInbound(message: unknown, clientPubkey: string, handler: (input: ContextVmInboundEnvelope) => Promise<void>): Promise<void> {
    const parsedResult = InboundMessageSchema.safeParse(message);
    if (!parsedResult.success) return;
    const parsed = parsedResult.data;
    this.observedMethods.add(parsed.method);
    // JSON-RPC notifications intentionally have no id and therefore cannot be
    // treated as a failed request or replied to by the bridge.
    if (parsed.id === undefined) return;
    const requestEventId = this.requestEventId(parsed.params);
    if (!requestEventId) return;
    const event = this.transport.getNostrRequestEvent(requestEventId);
    if (!event || event.id !== requestEventId || event.pubkey !== clientPubkey || !verifyEvent(event)) return;
    this.lastInbound = Object.freeze({ verifiedClientPubkey: clientPubkey, requestEventId, method: parsed.method });
    if (parsed.method === "initialize") {
      await this.sendResponse(clientPubkey, {
        jsonrpc: "2.0", id: parsed.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "napplet-cvm-development", version: "0.1.0" } },
      }, requestEventId);
      return;
    }
    if (parsed.method === "tools/list") {
      const negotiation = pricedContinuationNegotiation(parsed.params, event.tags);
      if (negotiation === "invalid") {
        await this.sendResponse(clientPubkey, { jsonrpc: "2.0", id: parsed.id, error: { code: -32602, message: "invalid ContextVM priced-continuation negotiation" } }, requestEventId);
        return;
      }
      const tools = ["account_status", "top_up", "funded_admission", "approve_session_cap", "start_session", "revise_session", "resume_session", "session_status", "preview", "publication"]
        .filter(name => this.#availableTools.has(name));
      if (negotiation === "verified" && this.#pricedContinuationAvailable) tools.push("prepare_resume", "resume_session_v2");
      await this.sendResponse(clientPubkey, {
        jsonrpc: "2.0", id: parsed.id,
        result: { tools: tools.concat(this.extraTools).map((name) => ({ name })) },
      }, requestEventId);
      return;
    }
    if (parsed.method !== "tools/call") {
      await this.sendResponse(clientPubkey, { jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: "ContextVM method unavailable" } }, requestEventId);
      return;
    }
    await handler({
      verifiedClientPubkey: clientPubkey,
      requestEventId,
      rawEvent: { id: event.id, tags: event.tags.map((tag) => [...tag]) },
      request: { id: parsed.id, method: parsed.method, params: parsed.params ?? {} },
    });
  }

  private requestEventId(params: unknown): string | undefined {
    if (!params || typeof params !== "object") return undefined;
    const values = params as Record<string, unknown>;
    if (typeof values.requestEventId === "string" && values.requestEventId.length > 0) return values.requestEventId;
    const candidate = RequestEventMetaSchema.safeParse(values._meta);
    return candidate.success ? candidate.data.requestEventId ?? candidate.data.contextvm?.requestEventId : undefined;
  }
}
