import type { ProjectSpend, RequestCost } from "../project-costs-contract";

export const formatCost = (value: string) => `${BigInt(value).toLocaleString()} test sats`;
export const spendMarkup = (place: string) => `<div class="project-spend" data-spend="${place}" hidden><span>Total spent</span><strong data-spend-value>—</strong><span data-spend-note></span></div>`;
export function renderSpend(root: HTMLElement, total?: ProjectSpend): void {
  root.querySelectorAll<HTMLElement>("[data-spend]").forEach(el => {
    el.hidden = !total;
    if (!total) return;
    el.querySelector("[data-spend-value]")!.textContent = formatCost(total.confirmed);
    el.querySelector("[data-spend-note]")!.textContent = total.pending
      ? `${total.pending} request${total.pending === 1 ? "" : "s"} awaiting cost · confirmed total only`
      : `${total.requests} request${total.requests === 1 ? "" : "s"} · confirmed`;
  });
}
function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className?: string) {
  const element = document.createElement(tag); element.textContent = value;
  if (className) element.className = className;
  return element;
}
const labels = { input_tokens: "Input", output_tokens: "Output", cached_tokens: "Cached input", reasoning_tokens: "Reasoning" };

/** A request and its result share one receipt. Showing that receipt once avoids
 * implying that the status reply is a second paid model request. */
export function requestCostElement(request: RequestCost): HTMLLIElement {
  const item = document.createElement("li"); item.className = "request-message"; item.dataset.requestId = request.id; item.dataset.state = request.state;
  const heading = document.createElement("div"); heading.className = "request-message-heading";
  heading.append(text("span",`Request ${request.number} · ${request.kind === "create" ? "Create" : "Revision"}`),text("time",new Date(request.createdAt).toLocaleDateString()));
  const prompt = text("p",request.prompt ?? (request.kind === "create" ? "Create the first version" : "Revise this applet"),"request-prompt");
  item.append(heading,prompt);
  if (!request.prompt) item.append(text("p","Original prompt unavailable.","request-note"));
  const outcome = request.state === "verified" ? `Version ${request.version} ready` : request.state === "failed" ? "Attempt stopped" : ["active","prepared"].includes(request.state) ? "In progress" : "Outcome needs checking";
  item.append(text("p",outcome,"request-outcome"));
  const footer = document.createElement("div"); footer.className = "request-charge";
  footer.append(text("span",request.charge === null ? "Request cost" : "Actual cost"),text("strong",request.charge === null ? "Awaiting confirmation" : formatCost(request.charge)));
  item.append(footer);
  const details = document.createElement("details"); details.className = "request-cost-details";
  details.append(text("summary","Cost breakdown"));
  if (request.lines.length) {
    const list = document.createElement("dl");
    for (const line of request.lines) {
      const row = document.createElement("div"); const term = text("dt",`${labels[line.dimension]} · ${BigInt(line.units).toLocaleString()} tokens`);
      term.append(text("small",`${BigInt(line.numerator).toLocaleString()} test sats / ${BigInt(line.denominator).toLocaleString()} tokens`));
      row.append(term,text("dd",formatCost(line.charge))); list.append(row);
    }
    details.append(list,text("p","Each usage category is rounded up to a whole test sat at the rate saved for this request.","request-note"));
  } else details.append(text("p",request.charge === null ? "The CVM has not confirmed this charge. It is not included in Total spent yet." : request.charge === "0" ? "No local test charge was recorded. The provider may still have counted subscription usage." : "The charge is recorded, but a token breakdown is not available for this request.","request-note"));
  details.append(text("p",`Approved maximum: ${formatCost(request.maximum)}. The maximum is not an extra charge.`,"request-note"));
  if (request.state === "failed" && request.charge !== null && request.charge !== "0") details.append(text("p","This attempt incurred model usage even though it did not produce a verified version.","request-note"));
  details.append(text("p","One charge covers this request and its result. Local test sats do not represent a subscription bill.","request-note"));
  item.append(details); return item;
}
