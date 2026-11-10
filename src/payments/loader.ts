import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { FundingService } from "../funding/funding-service";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { PaymentAdapter, CreditGrantPort } from "./contracts";
import { adapterCreditGrants } from "./credits";
import { PaymentAdapterRegistry } from "./registry";
import { PaymentMethodIdSchema } from "./contracts";

export const PaymentModuleConfigSchema = z.object({
  id: PaymentMethodIdSchema,
  module: z.string().min(1).max(512).refine(isAbsolute),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type PaymentModuleConfig = Readonly<z.infer<typeof PaymentModuleConfigSchema>>;
export type PaymentAdapterHost = Readonly<{
  credits: CreditGrantPort;
  /** Trusted operator code may maintain its own durable provider state. Never pass this host to generated code. */
  pool: PostgresSqlPool & Pick<PostgresSqlClient, "query">;
  key: Uint8Array;
  realm: "test" | "real";
}>;
export interface PaymentAdapterModule {
  version: 1;
  create(host: PaymentAdapterHost, options: Readonly<Record<string, unknown>>): Promise<PaymentAdapter>;
}

export async function loadPaymentAdapters(input: Readonly<{
  modules: readonly PaymentModuleConfig[];
  funding: FundingService;
  host: Omit<PaymentAdapterHost, "credits">;
}>): Promise<PaymentAdapterRegistry> {
  const adapters: PaymentAdapter[] = [];
  try {
    for (const value of input.modules) {
      const config = PaymentModuleConfigSchema.parse(value);
      if (adapters.some(adapter => adapter.id === config.id)) throw new Error("PAYMENT_ADAPTER_ID_CONFLICT");
      const module = await import(pathToFileURL(config.module).href) as PaymentAdapterModule;
      if (module.version !== 1 || typeof module.create !== "function") throw new Error("PAYMENT_MODULE_VERSION_INVALID");
      const adapter = await module.create(Object.freeze({ ...input.host, key: new Uint8Array(input.host.key), credits: adapterCreditGrants(input.funding, config.id) }), config.options);
      if (adapter.id !== config.id) { await adapter.close?.(); throw new Error("PAYMENT_ADAPTER_ID_MISMATCH"); }
      adapters.push(adapter);
    }
    return new PaymentAdapterRegistry(adapters);
  } catch (error) {
    await Promise.allSettled(adapters.map(adapter => adapter.close?.()));
    throw error;
  }
}
