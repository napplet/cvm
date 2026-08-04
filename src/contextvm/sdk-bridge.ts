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
  sendResponse(clientPubkey: string, response: ContextVmWireResponse, requestEventId: string): Promise<void>;
  sendNotification(clientPubkey: string, notification: ContextVmWireNotification, requestEventId: string): Promise<void>;
  canonicalInvocation(clientPubkey: string, method: string, params: unknown): Readonly<{ clientPubkey: string; invocationHash: string }>;
}

const InboundMessageSchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string().min(1),
  params: z.unknown(),
}).passthrough();

/**
 * SDK-only transport compatibility layer. It deliberately configures a single
 * context callback: the SDK's in-memory correlations can route a reply but
 * never decide account authority or replay of a financial business effect.
 */
export class ContextVmSdkBridge implements ContextVmTransportPort {
  constructor(private readonly transport: NostrServerTransport) {}

  onInbound(handler: (input: ContextVmInboundEnvelope) => Promise<void>): void {
    this.transport.onmessage = undefined;
    this.transport.onmessageWithContext = (message, context) => {
      const parsed = InboundMessageSchema.parse(message);
      const requestEventId = this.requestEventId(parsed.params);
      const event = this.transport.getNostrRequestEvent(requestEventId);
      if (!event || event.id !== requestEventId) return;
      return handler({
        verifiedClientPubkey: context.clientPubkey,
        requestEventId,
        rawEvent: { id: event.id, tags: event.tags.map((tag) => [...tag]) },
        request: { id: parsed.id, method: parsed.method, params: parsed.params },
      });
    };
  }

  configureAnnouncement(announcement: ContextVmAnnouncement): void {
    const pricing = announcement.tags.filter((tag) => tag[0] === "cap").map((tag) => [...tag]);
    const extra = announcement.tags.filter((tag) => tag[0] !== "cap").map((tag) => [...tag]);
    this.transport.setAnnouncementExtraTags(extra);
    this.transport.setAnnouncementPricingTags(pricing);
    this.transport.setSupportedPaymentInteraction("optional");
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

  private requestEventId(params: unknown): string {
    const candidate = z.object({
      _meta: z.object({ requestEventId: z.string().min(1) }).strict(),
    }).passthrough().safeParse(params);
    if (!candidate.success) throw new Error("CONTEXTVM_REQUEST_EVENT_ID_REQUIRED");
    return candidate.data._meta.requestEventId;
  }
}
