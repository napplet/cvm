import { GenerationEstimatesSchema, type GenerationEstimates, type GenerationEstimate } from "../generation-estimates-contract";
import type { ActivitySnapshot } from "./activity";

export const estimateMarkup = (placement: "create" | "revise") => `<section id="${placement}-estimates" class="generation-estimate ${placement === "revise" ? "estimate-compact" : ""}" aria-label="${placement === "create" ? "Build" : "Revision"} estimates">${placement === "revise" ? '<p class="estimate-heading">Next revision <span>Estimated</span></p>' : ""}<dl><div><dt>Estimated cost</dt><dd id="${placement}-estimate-cost">—</dd></div><div><dt>Estimated time</dt><dd id="${placement}-estimate-time">—</dd></div></dl><details class="estimate-explanation"><summary>How this is estimated</summary><p id="${placement}-estimate-basis">Estimates will appear when the CVM connects.</p></details><p class="estimate-limit">Maximum <span data-estimate-maximum></span> test sats per action</p></section>`;

const sats = (value: string) => BigInt(value).toLocaleString();
const range = (low: string, high: string) => low === high ? low : `${low}–${high}`;
const roundedSeconds = (value: number) => Math.max(5, Math.ceil(value / 5) * 5);
/** Share the unit across the range, keeping it attached to its value on wrap. */
export function formatDurationRange(low: number, high: number): string {
  const lower = roundedSeconds(low), upper = roundedSeconds(high);
  if (lower >= 60) return `${range(String(Math.floor(lower / 30) / 2), String(Math.ceil(upper / 30) / 2))}\u00a0min`;
  return `${range(String(lower), String(upper))}\u00a0sec`;
}
const cost = (estimate: GenerationEstimate) => `${range(sats(estimate.cost.low), sats(estimate.cost.high))}\u00a0test sats`;

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
      this.text(`${kind}-estimate-time`, estimate ? formatDurationRange(estimate.seconds.low, estimate.seconds.high) : incoming ? "Not enough history" : "Unavailable");
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
  get currentCost() { return this.#active ? cost(this.#active) : "Not enough history"; }
  progress(snapshot: ActivitySnapshot): string {
    let value = "", remaining = "";
    if (snapshot.state === "running") {
      if (!this.#kind) { value = "Checking saved work · remaining time unavailable"; remaining = "Checking saved work"; }
      else if (snapshot.stale) { value = "Time estimate paused while waiting for an update"; remaining = "Waiting for an update"; }
      else if (!this.#active) { value = "No time estimate yet"; remaining = "Not enough history"; }
      else {
        const { low, high } = this.#active.seconds;
        remaining = snapshot.elapsed >= high ? "Longer than usual" : low > snapshot.elapsed
          ? formatDurationRange(low - snapshot.elapsed, high - snapshot.elapsed)
          : `Up to ${formatDurationRange(high - snapshot.elapsed, high - snapshot.elapsed)}`;
        value = snapshot.elapsed >= high ? "Taking longer than recent runs" : `About ${remaining.replace(/^Up to /u, "")} ${low > snapshot.elapsed ? "remaining" : "or less remaining"}`;
        value += ` · Estimated cost ${cost(this.#active)}`;
      }
    } else if (snapshot.state === "completed" && this.#charge !== undefined) value = `Actual charge: ${sats(this.#charge)} test sats`;
    this.text("progress-estimate", value);
    return remaining;
  }
}
