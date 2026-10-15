import type { DevPayments } from "../../scripts/dev-payments";
import { createDevelopmentFunding } from "../../scripts/dev-funding";
import { SourceProposalStore } from "./source-proposal-store";
import { DevelopmentModelGateway, configuredProviderFromEnvironment } from "./development-model-gateway";

/** Development-only source proposal composition. No provider credential is exported to browser code. */
export async function createDevelopmentModelComposition(config: DevPayments) {
  const funding = await createDevelopmentFunding(config);
  const proposals = new SourceProposalStore(funding.pool);
  const configured = await configuredProviderFromEnvironment({ apiKey: process.env.OPENAI_API_KEY, model: process.env.NAPPLET_CVM_OPENAI_MODEL, profile: process.env.NAPPLET_CVM_OPENAI_PROFILE ? JSON.parse(process.env.NAPPLET_CVM_OPENAI_PROFILE) : undefined, priceCard: process.env.NAPPLET_CVM_OPENAI_PRICE_CARD ? JSON.parse(process.env.NAPPLET_CVM_OPENAI_PRICE_CARD) : undefined, priceSources: process.env.NAPPLET_CVM_OPENAI_PRICE_SOURCES ? JSON.parse(process.env.NAPPLET_CVM_OPENAI_PRICE_SOURCES) : undefined });
  const gateway = new DevelopmentModelGateway({ store: proposals, ...(configured ? { configured } : {}) });
  return Object.freeze({ funding, proposals, gateway, providerLabel: gateway.label(), close: funding.close });
}
