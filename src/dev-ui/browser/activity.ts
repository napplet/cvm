import { progressStages } from "../progress-contract";
import { formatWorkerDiagnostic } from "../../dev/worker-diagnostic";
import type { ClientActivity } from "./contextvm-client";

const toolLabels: Record<string, string> = { funded_admission: "Reserve capacity and funds", start_session: "Start generation", revise_session: "Revise napplet", resume_session: "Resume saved action", preview: "Open verified preview" };

export class ExecutionActivity {
  #running = false;
  #started = 0;
  #lastServer = 0;
  #waitingSince = 0;
  #requests = new Set<string | number>();
  #failedStage?: string;
  #failureDetail?: string;
  #generationResponded = false;
  #timer?: ReturnType<typeof setInterval>;
  constructor(private readonly root: HTMLElement, provider?: string) {
    root.innerHTML = `<h2 id="activity-heading">Live execution</h2><p id="activity-provider" class="supporting"></p><p id="activity-current" role="status" aria-live="polite">Ready to submit an action</p><p id="activity-clock" class="supporting"></p><p id="activity-connection" class="supporting"></p><ol id="activity-events" aria-label="Execution events"></ol><p class="supporting">Live updates describe work in progress. The session timeline below records durable results.</p>`;
    if (provider) this.provider(provider);
  }
  get running(): boolean { return this.#running; }
  get generationResponded(): boolean { return this.#generationResponded; }
  private text(id: string, text: string): void { this.root.querySelector<HTMLElement>(`#${id}`)!.textContent = text; }
  begin(label: string, provider: string): void {
    clearInterval(this.#timer); this.#running = true; this.#started = performance.now(); this.#lastServer = 0; this.#waitingSince = this.#started; this.#requests.clear();
    this.#failedStage = undefined;
    this.#failureDetail = undefined;
    this.#generationResponded = false;
    this.root.dataset.state = "running";
    this.root.querySelector("#activity-events")!.replaceChildren();
    this.provider(provider); this.text("activity-current", `${label} · submitting`); this.log("Browser: action submitted"); this.tick();
    this.#timer = setInterval(() => this.tick(), 1000);
    this.root.scrollIntoView({ block: "nearest" });
  }
  private provider(provider: string, model?: string): void {
    const fixture = provider === "Deterministic fixture" || provider === "deterministic_fixture";
    const label = provider === "openai_chatgpt_development" ? "ChatGPT plan" : provider === "openai_responses" ? "OpenAI Responses API" : provider;
    this.text("activity-provider", fixture ? "Deterministic fixture · no model request; builds a sample napplet" : `${label}${model ? ` · ${model}` : ""}`);
    this.root.dataset.fixture = String(fixture);
  }
  receive(event: ClientActivity): void {
    if (!this.#running) return;
    if (event.kind === "sent") {
      this.#requests.add(event.requestId); this.#waitingSince = performance.now(); this.#lastServer = 0;
      this.text("activity-current", `${toolLabels[event.tool] ?? "Request"} · waiting for server`);
      this.log(`Browser: ${toolLabels[event.tool] ?? "Request"} submitted over relay`); this.tick(); return;
    }
    const requestId = event.kind === "progress" ? event.progress.requestId : event.requestId;
    if (!this.#requests.has(requestId)) return;
    this.#lastServer = performance.now();
    if (event.kind === "response") {
      if (["start_session", "revise_session", "resume_session"].includes(event.tool)) this.#generationResponded = true;
      this.#requests.delete(requestId); this.log(`Server: ${toolLabels[event.tool] ?? "Request"} response received`); this.tick(); return;
    }
    const update = event.progress;
    this.root.dataset.lastServerSequence = String(update.sequence);
    if (update.provider) this.provider(update.provider, update.model);
    if (update.kind === "stage") {
      if (update.state === "failed") this.#failedStage ??= progressStages[update.stage];
      const diagnostic = update.state === "failed" && update.diagnostic ? formatWorkerDiagnostic(update.diagnostic) : undefined;
      if (diagnostic) this.#failureDetail = diagnostic;
      const label = `${progressStages[update.stage]} · ${update.state}${update.bytes === undefined ? "" : ` · ${update.bytes.toLocaleString()} bytes received`}${diagnostic ? ` · ${diagnostic}` : ""}`;
      this.text("activity-current", label); this.log(`Server: ${label}`, update.stage, update.state);
    }
    this.tick();
  }
  finish(message: string, state: "completed" | "failed" | "uncertain" = "completed"): void {
    if (!this.#running) return;
    if (state === "failed" && this.#failedStage) message += ` · ${this.#failedStage}`;
    if (state === "uncertain" && this.#generationResponded) message = "Generation stopped · provider outcome unconfirmed";
    this.#running = false; clearInterval(this.#timer); this.#requests.clear(); this.root.dataset.state = state;
    this.text("activity-current", message); this.text("activity-connection", state === "uncertain" ? this.#generationResponded ? "The server finished this request. Provider completion or usage could not be confirmed; this action will not be retried automatically." : "Outcome unconfirmed. Work may still be running; check session status before starting another action." : "");
    if (state === "failed" && this.#failureDetail) this.explainFailure(this.#failureDetail);
    this.log(message); this.tick();
  }
  explainFailure(message: string): void {
    if (this.#running || !["failed", "uncertain"].includes(this.root.dataset.state ?? "")) return;
    const detail = this.root.querySelector<HTMLElement>("#activity-connection")!;
    detail.textContent = [detail.textContent, message].filter(Boolean).join(" ");
  }
  private log(message: string, stage?: string, state?: string): void {
    const item = document.createElement("li"); item.textContent = `${Math.floor((performance.now() - this.#started) / 1000)}s · ${message}`;
    if (stage) item.dataset.stage = stage; if (state) item.dataset.state = state;
    const list = this.root.querySelector("#activity-events")!; list.append(item);
    while (list.children.length > 160) list.firstElementChild!.remove();
    list.scrollTop = list.scrollHeight;
  }
  private tick(): void {
    this.text("activity-clock", `${Math.floor((performance.now() - this.#started) / 1000)}s elapsed`);
    if (!this.#running) return;
    const seconds = Math.floor((performance.now() - (this.#lastServer || this.#waitingSince)) / 1000);
    this.root.dataset.stale = String(seconds >= 15);
    this.text("activity-connection", seconds >= 15 ? `No server update for ${seconds}s. Connection or work may be stalled; waiting for the original request.` : this.#lastServer ? `Server update ${seconds}s ago · heartbeat every 5s while processing` : `Waiting for server acknowledgement · ${seconds}s`);
  }
}
