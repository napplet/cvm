import { PaymentMethodIdSchema, PaymentMethodSchema, PaymentResultSchema, type PaymentAdapter, type PaymentRequest } from "./contracts";

/** Routing has no payment-provider, exchange-rate, subscription or wallet logic. */
export class PaymentAdapterRegistry {
  readonly methods;
  readonly #routes = new Map<string, PaymentAdapter>();
  readonly #adapters: readonly PaymentAdapter[];

  constructor(adapters: readonly PaymentAdapter[]) {
    if (adapters.length > 16) throw new Error("PAYMENT_ADAPTER_LIMIT");
    const ids = new Set<string>();
    const methods = [];
    for (const adapter of adapters) {
      const id = PaymentMethodIdSchema.parse(adapter.id);
      if (ids.has(id) || typeof adapter.request !== "function" || adapter.methods.length < 1 || adapter.methods.length > 16) throw new Error("PAYMENT_ADAPTER_INVALID");
      ids.add(id);
      for (const input of adapter.methods) {
        const method = Object.freeze(PaymentMethodSchema.parse(input));
        if (this.#routes.has(method.id)) throw new Error("PAYMENT_METHOD_CONFLICT");
        this.#routes.set(method.id, adapter);
        methods.push(method);
      }
    }
    this.methods = Object.freeze(methods);
    this.#adapters = Object.freeze([...adapters]);
  }

  async request(input: PaymentRequest) {
    const adapter = this.#routes.get(input.method);
    if (!adapter) throw new Error("PAYMENT_METHOD_UNAVAILABLE");
    return Object.freeze(PaymentResultSchema.parse(await adapter.request(input)));
  }

  async list(input: Readonly<{ accountId: string }>) {
    return (await Promise.all(this.#adapters.map(adapter => adapter.statuses?.list(input) ?? []))).flat();
  }

  async reconcile(): Promise<void> {
    const outcomes = await Promise.allSettled(this.#adapters.map(adapter => adapter.reconcile?.()));
    if (outcomes.some(result => result.status === "rejected")) throw new Error("PAYMENT_RECONCILIATION_INCOMPLETE");
  }

  async close(): Promise<void> {
    const outcomes = await Promise.allSettled(this.#adapters.map(adapter => adapter.close?.()));
    if (outcomes.some(result => result.status === "rejected")) throw new Error("PAYMENT_ADAPTER_CLOSE_FAILED");
  }
}
