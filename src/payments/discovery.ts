import { buildContextVmAnnouncement } from "../contextvm/announcement";
import type { ContextVmTransportPort } from "../contextvm/sdk-bridge";
import type { PaymentMethod } from "./contracts";

/** Discovery describes installed capabilities; no payment method is mandatory. */
export function configurePaymentDiscovery(transport: Pick<ContextVmTransportPort, "configureAnnouncement">, methods: readonly PaymentMethod[]): void {
  const names = ["account_status", "top_up", "funded_admission", "start_session", "revise_session", "resume_session", "session_status", "preview", "publication"] as const;
  transport.configureAnnouncement(buildContextVmAnnouncement({
    topUpCap: { minimum: "1", maximum: String(Number.MAX_SAFE_INTEGER), unit: "sat" },
    pmis: methods.map(method => method.id), paymentInteraction: ["transparent", "explicit_gating"],
    tools: names.map(name => { const available = name === "top_up" ? methods.length > 0 : name !== "publication"; return { name, available, planned: !available }; }),
  }));
}
