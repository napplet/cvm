import type { ContextVmTransportPort } from "../contextvm/sdk-bridge";

/** Staged production is private even though its relay is publicly reachable.
 * Deny every business invocation outside the mounted certification identity
 * before the durable invocation journal, funding rails, or worker authority.
 * There is deliberately no request/env switch for opening public traffic;
 * that needs a separately verified cutover authority. */
export class ProductionCertificationIngress {
  readonly #pubkey: string;
  constructor(pubkey: string) {
    if (!/^[a-f0-9]{64}$/u.test(pubkey)) throw new Error("PRODUCTION_CERTIFICATION_PRINCIPAL_INVALID");
    this.#pubkey = pubkey;
  }
  wrap(source: ContextVmTransportPort): ContextVmTransportPort {
    return Object.freeze<ContextVmTransportPort>({
      onInbound: handler => source.onInbound(async envelope => {
        if (envelope.verifiedClientPubkey !== this.#pubkey) {
          await source.sendResponse(envelope.verifiedClientPubkey, { jsonrpc: "2.0", id: envelope.request.id, error: { code: -32003, message: "Production certification is private" } }, envelope.requestEventId);
          return;
        }
        await handler(envelope);
      }),
      configureAnnouncement: value => source.configureAnnouncement(value),
      sendResponse: (pubkey, response, eventId) => source.sendResponse(pubkey, response, eventId),
      sendNotification: (pubkey, notification, eventId) => source.sendNotification(pubkey, notification, eventId),
      canonicalInvocation: (pubkey, method, params) => source.canonicalInvocation(pubkey, method, params),
    });
  }
}
