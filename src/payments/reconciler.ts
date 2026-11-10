import type { PaymentAdapterRegistry } from "./registry";

/** A bounded adapter polling lifecycle, with no provider-specific state or ledger authority. */
export class PaymentReconciler {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #failed = false;
  constructor(private readonly payments: PaymentAdapterRegistry, private readonly intervalMs = 2_000) {}
  start(): void {
    if (!this.#timer) this.#timer = setInterval(() => { void this.reconcilePending().catch(() => undefined); }, this.intervalMs);
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  diagnostics() { return Object.freeze({ running: this.#running, failed: this.#failed }); }
  async reconcilePending(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try { await this.payments.reconcile(); this.#failed = false; }
    catch { this.#failed = true; throw new Error("PAYMENT_RECONCILIATION_INCOMPLETE"); }
    finally { this.#running = false; }
  }
}
