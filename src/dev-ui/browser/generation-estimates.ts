import { GenerationEstimatesSchema, type GenerationEstimates, type GenerationEstimate } from "../generation-estimates-contract";
import type { ActivitySnapshot } from "./activity";

export const estimateMarkup = (placement: "create" | "revise") => `<section class="generation-estimate ${placement === "revise" ? "estimate-compact" : ""}" aria-label="${placement === "create" ? "Build" : "Revision"} estimates"><dl><div><dt>Estimated cost</dt><dd id="${placement}-estimate-cost">—</dd></div><div><dt>Estimated time</dt><dd id="${placement}-estimate-time">—</dd></div></dl><p id="${placement}-estimate-basis">Estimates will appear when the CVM connects.</p><p class="estimate-limit">Maximum: <span data-estimate-maximum></span> test sats per action</p></section>`;

const sats = (value: string) => BigInt(value).toLocaleString();
const duration = (seconds: number) => seconds < 60 ? `${Math.max(5, Math.ceil(seconds / 5) * 5)} sec` : `${Math.ceil(seconds / 30) / 2} min`;
const range = (low: string, high: string) => low === high ? low : `${low}–${high}`;
const cost = (estimate: GenerationEstimate) => `${range(sats(estimate.cost.low), sats(estimate.cost.high))} test sats`;

/** Presentation-only: all observations arrive over authenticated CVM service_info. */
export class GenerationEstimatesView {
  #data?: GenerationEstimates;
  #active?: GenerationEstimate | null;
  #kind?: "create" | "revise";
  #charge?: string;
  constructor(private readonly root: HTMLElement) {
    this.maximum();
    root.querySelector("#maximum")!.addEventListener("input", () => this.maximum());
  }
  private text(id: string, value: string) { this.root.querySelector<HTMLElement>(`#${id}`)!.textContent = value; }
  maximum() {
    const value = this.root.querySelector<HTMLInputElement>("#maximum")!.value;
    for (const element of this.root.querySelectorAll("[data-estimate-maximum]")) element.textContent = /^\d{1,9}$/u.test(value) ? sats(value) : "—";
  }
  set(value: unknown, forCurrentAction = false, placement?: "create" | "revise") {
    const parsed = GenerationEstimatesSchema.safeParse(value);
    const incoming = parsed.success ? parsed.data : undefined;
    this.#data = placement ? { unit: "test_sat", windowDays: 30, create: this.#data?.create ?? null, revise: this.#data?.revise ?? null, [placement]: incoming?.[placement] ?? null } : incoming;
    for (const kind of ["create", "revise"] as const) {
      if (placement && kind !== placement) continue;
      const estimate = this.#data?.[kind];
      this.text(`${kind}-estimate-cost`, estimate ? cost(estimate) : incoming ? "Not enough history" : "Unavailable");
      this.text(`${kind}-estimate-time`, estimate ? `About ${range(duration(estimate.seconds.low), duration(estimate.seconds.high))}` : incoming ? "Not enough history" : "Unavailable");
      this.text(`${kind}-estimate-basis`, !incoming ? "Estimates are unavailable right now. You can still build." : !estimate ? "Your completed builds will help estimate future requests. No extra model request is made." :
        `Based on your ${estimate.samples} recent ${estimate.basis === "revise" ? "revision" : "build"}${estimate.samples === 1 ? "" : "s"}${estimate.samples < 3 ? " · limited history" : ""}. Complexity and service load can change the result.`);
    }
    if (forCurrentAction && this.#kind) this.#active = this.#data?.[this.#kind];
  }
  begin(kind: string) {
    this.#charge = undefined;
    // Recovery/replay has an unknown original start time. Never restart an ETA.
    this.#kind = kind === "generate" ? "create" : kind === "revise" ? "revise" : undefined;
    this.#active = this.#kind ? this.#data?.[this.#kind] : undefined;
    this.text("progress-estimate", "");
  }
  charge(value: unknown) { if (typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/u.test(value)) this.#charge = value; }
  reset() { this.#active = undefined; this.#kind = undefined; this.#charge = undefined; this.text("progress-estimate", ""); }
  progress(snapshot: ActivitySnapshot) {
    let value = "";
    if (snapshot.state === "running") {
      if (!this.#kind) value = "Checking saved work · remaining time unavailable";
      else if (snapshot.stale) value = "Time estimate paused while waiting for an update";
      else if (!this.#active) value = "No time estimate yet";
      else {
        const { low, high } = this.#active.seconds;
        value = snapshot.elapsed >= high ? "Taking longer than recent runs" : low > snapshot.elapsed
          ? `About ${range(duration(low - snapshot.elapsed), duration(high - snapshot.elapsed))} remaining`
          : `About ${duration(high - snapshot.elapsed)} or less remaining`;
        value += ` · Estimated cost ${cost(this.#active)}`;
      }
    } else if (snapshot.state === "completed" && this.#charge !== undefined) value = `Actual charge: ${sats(this.#charge)} test sats`;
    this.text("progress-estimate", value);
  }
}
