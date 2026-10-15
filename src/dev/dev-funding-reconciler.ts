import type { createDevelopmentFunding } from "../../scripts/dev-funding";

type DevelopmentFunding = Awaited<ReturnType<typeof createDevelopmentFunding>>;

/**
 * Development-only NWC settlement observer. It has no ledger authority: it
 * discovers durable pending rows, then lets the existing coordinator observe
 * and credit the original local-NWC settlement identity exactly once. The
 * local receiver is the payee; this observer never treats an invoice or a
 * browser action as settlement proof.
 */
export class DevelopmentNwcSettlementReconciler {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #lastScan = Object.freeze({ checked: 0, observed: 0, deadlineReached: false, at: "" });

  constructor(private readonly app: DevelopmentFunding, private readonly intervalMs = 300, private readonly deadlineMs = 15_000) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.reconcilePending().catch(() => undefined); }, this.intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Safe bounded diagnostics: only counts and durable top-up observation work. */
  diagnostics(): Readonly<{ checked: number; observed: number; deadlineReached: boolean; at: string }> { return this.#lastScan; }

  async reconcilePending(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    const deadline = Date.now() + this.deadlineMs;
    let checked = 0;
    let observed = 0;
    try {
      const pending = await this.app.database.lightning.transact((state) => [...state.topUps.values()]
        .filter((topUp) => topUp.state === "pending" || topUp.state === "settled" || topUp.state === "reconciliation_pending")
        .map((topUp) => structuredClone(topUp)));
      for (const topUp of pending) {
        if (Date.now() >= deadline || topUp.state === "credited" || topUp.state === "failed") break;
        checked++;
        if (!topUp.protectedMaterialId) continue;
        await this.app.lightning.observeSettlement({ principal: topUp.principal, topUpId: topUp.topUpId });
        observed++;
      }
    } finally {
      this.#lastScan = Object.freeze({ checked, observed, deadlineReached: Date.now() >= deadline, at: new Date().toISOString() });
      this.#running = false;
    }
  }
}
