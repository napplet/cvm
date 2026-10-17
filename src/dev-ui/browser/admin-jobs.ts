import { quoteCaption, usdEquivalent, type ExchangeRate } from "../../currency/btc-usd";
type Command = (args: unknown) => Promise<any>;
const labels: Record<string, string> = { all: "All", pending: "Pending", active: "Active", review: "Needs review", finished: "Finished" };
const states: Record<string, string> = { saved: "Awaiting funds", bound: "Check admission", prepared: "Preparing", active: "Running", usage_unknown: "Receipt missing", billing_invariant_failed: "Billing mismatch", verified: "Ready", failed: "Stopped", completed: "Completed", expired: "Expired" };
export const jobsMarkup = `<section class="admin-jobs" aria-labelledby="jobs-heading">
  <div class="jobs-heading"><div><p class="eyebrow">Operations</p><h2 id="jobs-heading">Jobs</h2></div><button id="jobs-refresh">Refresh</button></div>
  <div id="jobs-overview" class="jobs-overview"></div>
  <p id="jobs-exchange" class="supporting"></p>
  <div class="jobs-toolbar"><div class="job-tabs" role="group" aria-label="Job state">${Object.entries(labels).map(([state, label]) => `<button data-state="${state}" aria-label="${label}" aria-pressed="${state === "all"}">${label}<span aria-hidden="true" data-count="${state}">0</span></button>`).join("")}</div>
  <label class="job-search"><span class="sr-only">Search jobs</span><input id="jobs-search" type="search" maxlength="160" placeholder="Search applet, request or ID"></label></div>
  <p id="jobs-status" role="status"></p><div class="job-table"><table><thead><tr><th>Applet / request</th><th>Status</th><th>Cost</th><th>Recorded</th></tr></thead><tbody id="jobs"></tbody></table></div>
  <div class="jobs-pagination"><p id="jobs-range"></p><div><button id="jobs-prev">Previous</button><button id="jobs-next">Next</button></div></div>
</section>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") { const item = document.createElement(tag); item.textContent = text; item.className = className; return item; }
const amount = (value: unknown) => { try { return BigInt(String(value)).toLocaleString(); } catch { return "—"; } };
const unit = (row: any) => ["development_test", "deterministic_fixture"].includes(row.price_kind) ? "test sats" : "sats";
const money = (value: unknown, row: any) => `${amount(value)} ${unit(row)}`;
const date = (value: unknown) => value ? new Date(String(value)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
function metric(label: string, value: string | HTMLElement, note?: string) { const root = node("div", "", "job-metric"); const strong = node("strong"); strong.append(value); root.append(node("span", label), strong); if (note) root.append(node("small", note)); return root; }
function facts(entries: [string, unknown][]) { const root = node("dl"); for (const [label, value] of entries) root.append(node("dt", label), node("dd", value == null ? "—" : String(value))); return root; }

export function mountAdminJobs(command: Command) {
  let exchangeRate: ExchangeRate | undefined;
  function moneyValue(value: unknown, row: any) {
    const root = node("span", "", "money-value");
    root.append(node("span", money(value, row)));
    const usd = node("span", usdEquivalent(String(value), exchangeRate), "usd-equivalent"); usd.dataset.usdSats = String(value); root.append(usd);
    return root;
  }
  function updateCurrency() {
    document.querySelectorAll<HTMLElement>("[data-usd-sats]").forEach(item => item.textContent = usdEquivalent(item.dataset.usdSats!, exchangeRate));
    el("jobs-exchange").textContent = `${quoteCaption(exchangeRate)} USD values use today’s quote; test-sat equivalents are illustrative.`;
  }
  let state = "all", offset = 0, search = "", request = 0, rendered = "", searchTimer: ReturnType<typeof setTimeout>;
  let selectedJob = 0;
  async function job(id: string, kind: string) {
    const version = ++selectedJob;
    const dialog = el<HTMLDialogElement>("job-detail"), root = el("job-facts");
    root.replaceChildren(node("p", "Loading job…", "supporting"));
    if (!dialog.open) dialog.showModal();
    try {
      const result = await command({ action: "job", id, kind });
      if (version !== selectedJob) return;
      const row = result.job;
      root.replaceChildren();
      if (!row) { root.append(node("p", "Job not found.")); return; }
      root.append(node("p", row.action_label ?? "Job", "eyebrow"), node("h3", row.title ?? "Applet"));
      const badge = node("span", states[row.state] ?? row.state, `job-badge ${row.category ?? "pending"}`); root.append(badge);
      if (row.request_text) root.append(node("p", row.request_text, "job-prompt"));
      const metrics = node("div", "", "job-detail-metrics");
      if (kind === "pending") metrics.append(metric("Approved maximum", moneyValue(row.maximum_sat, row)), metric("Reserved", "Nothing yet"));
      else {
        metrics.append(metric(row.billing_status === "waived" ? "Test charge waived" : "Confirmed charge", row.receipt_charge == null || row.billing_status === "unresolved" ? "Not settled" : moneyValue(row.receipt_charge, row)), metric("Still reserved", moneyValue(row.held_sat, row)), metric("Action maximum", moneyValue(row.reservation_sat, row)));
      }
      root.append(metrics);
      if (row.billing_status === "unresolved") {
        const warning = node("section", "", "job-review");
        warning.append(node("h4", row.state === "usage_unknown" ? "A provider receipt is missing" : "Billing needs review"), node("p", "An interrupted response can end before its usage receipt arrives. Reserved funds remain protected. Checking saved receipts never starts another model request."));
        const button = node("button", "Check receipt"); const feedback = node("p"); feedback.setAttribute("role", "status");
        button.disabled = row.state !== "usage_unknown";
        button.onclick = async () => {
          button.disabled = true; feedback.textContent = "Checking recorded evidence…";
          try {
            const { recovery } = await command({ action: "check_receipt", id });
            if (recovery.outcome === "settled" || recovery.outcome === "not_required") {
              await job(id, kind); await refresh();
              el("job-facts").prepend(node("p", recovery.outcome === "settled" ? `Receipt recovered · ${money(recovery.charged, row)} settled using this job’s original rates.` : "Job status updated.", "job-success"));
            } else feedback.textContent = recovery.outcome === "missing" ? `No receipt in the saved evidence. ${money(row.held_sat, row)} remain reserved. No new generation was started.` : recovery.outcome === "conflict" ? "Recorded evidence does not match the billing contract. Funds remain reserved for review." : "Receipt check unavailable or already in progress. Try again shortly.";
          } catch { feedback.textContent = "Receipt check failed. Funds remain reserved. Try again."; }
          finally { button.disabled = false; }
        };
        warning.append(button, feedback); root.append(warning);
      }
      if (row.billing_status === "waived") root.append(node("p", "The operator absorbed this interrupted development request. Zero test charge does not mean zero subscription usage.", "job-review"));
      const usage = row.usage_receipt?.usage;
      root.append(node("h4", "Usage & execution"));
      if (usage?.length) root.append(facts(usage.map((line: any) => [line.dimension.replaceAll("_", " "), amount(line.units)])));
      else root.append(node("p", kind === "pending" ? "No model request has started." : "No token breakdown was recorded.", "supporting"));
      root.append(facts([["Model", row.model], ["Recorded", date(row.created_at)], ["Settled", row.settled_at ? date(row.settled_at) : "Not settled"], ["Worker", row.worker?.map((item: any) => states[item.state] ?? item.state).join(", ") || "No worker result"], ["Versions", row.artifacts?.map((item: any) => `Version ${item.version}`).join(", ") || "No new version"]]));
      if (row.diagnostic_json?.code) root.append(facts([["Diagnostic", row.diagnostic_json.code], ["Stage", row.diagnostic_json.phase]]));
      const technical = node("details"); technical.append(node("summary", "Identifiers & ledger"));
      technical.append(facts([["Job", row.id], ["Session", row.session_id], ["Account", row.account_id], ["Operation", row.operation_id], ["Profile", row.profile_id], ["Price version", row.price_card_id], ["Receipt", row.provider_receipt_reference]]));
      if (row.billing?.length) {
        const list = node("ul", "", "job-ledger");
        for (const line of row.billing) { const item = node("li", `${line.kind.replaceAll("_", " ")} · ${date(line.committed_at)}`); item.append(moneyValue(line.amount_sat, row)); list.append(item); }
        technical.append(list);
      }
      root.append(technical);
    } catch { if (version === selectedJob) root.replaceChildren(node("p", "Could not load this job. Close and try again.")); }
  }
  async function refresh() {
    const version = ++request;
    el("jobs-status").textContent = rendered ? "Updating…" : "Loading jobs…";
    el("jobs").setAttribute("aria-busy", "true");
    try {
      const result = await command({ action: "jobs", status: state, offset, search });
      if (version !== request) return;
      if (offset && !result.jobs.length && result.total <= offset) { offset = Math.max(0, Math.floor((result.total - 1) / 50) * 50); return await refresh(); }
      const snapshot = JSON.stringify({ state, offset, search, result });
      if (snapshot !== rendered) {
        rendered = snapshot;
        const counts = result.counts ?? {};
        for (const category of Object.keys(labels)) el("admin-content").querySelector(`[data-count="${category}"]`)!.textContent = String(category === "all" ? Object.values(counts).reduce<number>((sum, n) => sum + Number(n), 0) : counts[category] ?? 0);
        const totals = result.totals ?? [];
        const totalText = (field: string) => {
          const sums = new Map<string, bigint>();
          for (const row of totals) sums.set(unit(row), (sums.get(unit(row)) ?? 0n) + BigInt(row[field]));
          const root = node("span");
          for (const [label, value] of sums) root.append(moneyValue(value, { price_kind: label === "test sats" ? "development_test" : "source_attributed_provider" }));
          if (!sums.size) root.textContent = "—";
          return root;
        };
        el("jobs-overview").replaceChildren(metric("Confirmed charges", totalText("charged_sat"), search ? "Matching jobs" : "All recorded jobs"), metric("Reserved for review", totalText("review_held_sat"), `${counts.review ?? 0} ${counts.review === 1 ? "job needs" : "jobs need"} attention`), metric("Active actions", String(counts.active ?? 0), `${counts.pending ?? 0} pending`));
        el("jobs").replaceChildren(...result.jobs.map((row: any) => {
          const tr = node("tr"); tr.dataset.category = row.category;
          const name = node("td", "", "job-name"); const button = node("button", row.title ?? "Applet", "job-open"); button.dataset.jobId = row.id;
          button.onclick = () => void job(row.id, row.kind);
          name.append(button, node("span", `${row.action_label ?? "Job"} · ${row.id.slice(-8)}`, "job-secondary"));
          if (row.request_text) name.append(node("span", row.request_text, "job-excerpt"));
          const status = node("td"); status.dataset.label = "Status"; status.append(node("span", states[row.state] ?? row.state, `job-badge ${row.category}`));
          const cost = node("td", "", "job-cost"); cost.dataset.label = "Cost";
          if (row.kind === "pending") cost.append(node("strong", "Not charged"), node("span", "Awaiting admission", "job-secondary"));
          else if (row.billing_status === "unresolved") cost.append(moneyValue(row.held_sat, row), node("span", "Reserved · unsettled", "job-secondary"));
          else if (row.receipt_charge != null) cost.append(moneyValue(row.receipt_charge, row), node("span", row.billing_status === "waived" ? "Operator absorbed" : "Settled", "job-secondary"));
          else cost.append(moneyValue(row.held_sat, row), node("span", "Reserved", "job-secondary"));
          const recorded = node("td", date(row.created_at), "job-recorded"); recorded.dataset.label = "Recorded";
          tr.append(name, status, cost, recorded); return tr;
        }));
        if (!result.jobs.length) { const tr = node("tr"); const td = node("td", search ? "No jobs match your search." : state === "review" ? "No jobs need billing review." : `No ${state === "all" ? "" : state + " "}jobs yet.`, "jobs-empty"); td.colSpan = 4; tr.append(td); el("jobs").append(tr); }
        el("jobs-range").textContent = result.total ? `${offset + 1}–${offset + result.jobs.length} of ${result.total} jobs` : "0 jobs";
        el<HTMLButtonElement>("jobs-prev").disabled = offset === 0;
        el<HTMLButtonElement>("jobs-next").disabled = offset + result.jobs.length >= result.total;
      }
      el("jobs-status").textContent = "Updated just now · refreshes every 5 seconds";
    } catch { if (version === request) el("jobs-status").textContent = "Could not refresh jobs. Your last results are still shown. Try Refresh."; }
    finally { if (version === request) el("jobs").setAttribute("aria-busy", "false"); }
  }
  document.querySelectorAll<HTMLButtonElement>("[data-state]").forEach(button => button.onclick = () => { state = button.dataset.state!; offset = 0; document.querySelectorAll("[data-state]").forEach(item => item.setAttribute("aria-pressed", String(item === button))); void refresh(); });
  el<HTMLInputElement>("jobs-search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { search = el<HTMLInputElement>("jobs-search").value.trim(); offset = 0; void refresh(); }, 250); };
  el("jobs-refresh").onclick = () => void refresh();
  el("jobs-prev").onclick = () => { offset = Math.max(0, offset - 50); void refresh(); };
  el("jobs-next").onclick = () => { offset += 50; void refresh(); };
  el("job-close").onclick = () => { ++selectedJob; el<HTMLDialogElement>("job-detail").close(); };
  updateCurrency();
  return { refresh, setExchangeRate(next: ExchangeRate) { exchangeRate = next; updateCurrency(); } };
}
