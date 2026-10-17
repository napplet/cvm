import { profitCharge, resolveProfit, ProfitSettingSchema, ZERO_PROFIT, type ProfitPolicy, type ProfitSetting } from "../../model/profit";
import { quoteStatus, usdEquivalent, type ExchangeRate } from "../../currency/btc-usd";
import { exampleCharge, type Rate } from "./admin-rates";

export const profitMarkup = `<section class="profit-panel" aria-labelledby="profit-heading">
<div class="rates-heading"><h2 id="profit-heading">Profit margin</h2><span id="profit-badge" class="rates-mode"></span></div>
<p class="supporting">Added to base model cost across all models. Applies to new generations and revisions.</p>
<form id="profit-form" novalidate><div class="profit-controls"><div><label for="profit-mode">Charge profit as</label><select id="profit-mode"><option value="percentage">Percentage of base cost</option><option value="sats">Sats per 1,000 billed tokens</option><option value="usd">USD per 1,000 billed tokens</option></select></div><div><label id="profit-value-label" for="profit-value">Markup (%)</label><input id="profit-value" type="text" inputmode="decimal" aria-describedby="profit-help profit-error" value="0"></div></div>
<p id="profit-help" class="supporting"></p><p id="profit-error" role="status"></p>
<div class="profit-example"><p>Example · 10,000 input + 2,000 output tokens</p><dl><div><dt>Base cost</dt><dd id="profit-base"></dd><small id="profit-base-usd"></small></div><div><dt>Your profit</dt><dd id="profit-fee"></dd><small id="profit-fee-usd"></small></div><div><dt>Customer total</dt><dd id="profit-total"></dd><small id="profit-total-usd"></small></div></dl></div>
<p id="profit-conversion" class="supporting"></p><div class="rates-save"><button id="profit-save" class="primary" disabled>Save margin</button><span id="profit-dirty" hidden>Unsaved changes</span></div><p id="profit-feedback" role="status"></p></form>
<p class="supporting">Use 0 to disable. Fees round up to whole sats. No fee is added to zero-cost or rejected requests.</p></section>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function mountAdminProfit(pricing: { card: { kind: string; rates: Record<string, Rate>; supportedDimensions: string[] } }, saved: ProfitPolicy | undefined,
  save: (setting: ProfitSetting) => Promise<void>, exchangeRate?: ExchangeRate) {
  const original = saved?.setting ?? ZERO_PROFIT;
  const mode = el<HTMLSelectElement>("profit-mode"), input = el<HTMLInputElement>("profit-value"), button = el<HTMLButtonElement>("profit-save");
  mode.value = original.mode; input.value = original.value; mode.disabled = false; input.disabled = false;
  let saving = false;
  const unit = pricing.card.kind === "source_attributed_provider" ? "sats" : "test sats";
  function draft() {
    const parsed = ProfitSettingSchema.safeParse({ mode: mode.value, value: input.value.trim() });
    if (!parsed.success) throw new Error("Enter a nonnegative number with up to six decimal places.");
    const policy = resolveProfit(parsed.data, exchangeRate);
    const changed = JSON.stringify(parsed.data) !== JSON.stringify(original)
      || (parsed.data.mode === "usd" && policy.conversion?.usdPerBtc !== saved?.conversion?.usdPerBtc);
    return { setting: parsed.data, policy, changed };
  }
  function update(clearFeedback = true) {
    const isPercent = mode.value === "percentage", isUsd = mode.value === "usd";
    el("profit-value-label").textContent = isPercent ? "Markup (%)" : isUsd ? "Profit (USD / 1,000 tokens)" : "Profit (sats / 1,000 tokens)";
    el("profit-help").textContent = isPercent ? "Percentage added to base cost. A 20% markup turns 100 sats into 120 sats." : isUsd ? "Profit per 1,000 billed tokens, converted to sats when saved. That conversion stays fixed until you save again." : "Prorated over all billed tokens, including input, output and any separately billed cached or reasoning tokens.";
    el("profit-badge").textContent = Number(original.value) === 0 ? "No margin" : original.mode === "percentage" ? `${original.value}% markup` : `${original.mode === "usd" ? "$" : ""}${original.value}${original.mode === "sats" ? " sats" : " USD"} / 1,000 tokens`;
    let error = "", value: ReturnType<typeof draft> | undefined;
    try { value = draft(); } catch (cause) { error = (cause as Error).message === "FRESH_BTC_USD_QUOTE_REQUIRED" ? "A fresh BTC/USD quote is needed to save a USD margin. Try again when conversion is available." : (cause as Error).message; }
    input.setAttribute("aria-invalid", String(!!error)); el("profit-error").textContent = error;
    const base = BigInt(exampleCharge(pricing.card.rates, pricing.card.supportedDimensions, false));
    const tokens = (pricing.card.supportedDimensions.includes("input_tokens") ? 10000n : 0n) + (pricing.card.supportedDimensions.includes("output_tokens") ? 2000n : 0n);
    const fee = value ? profitCharge(base, tokens, value.policy) : undefined;
    for (const [name, amount] of [["base", base], ["fee", fee], ["total", fee === undefined ? undefined : base + fee]] as const) {
      el(`profit-${name}`).textContent = amount === undefined ? "—" : `${amount.toLocaleString()} ${unit}`;
      el(`profit-${name}-usd`).textContent = amount === undefined ? "" : usdEquivalent(amount.toString(), exchangeRate);
    }
    el("profit-conversion").textContent = isUsd && saved?.conversion
      ? `Saved conversion: 1 BTC = $${Number(saved.conversion.usdPerBtc).toLocaleString("en-US")} USD · Kraken · ${new Date(saved.conversion.fetchedAt).toLocaleString()}. Saving again pins the latest quote.`
      : isUsd ? "Saving pins the CVM’s current Kraken BTC/USD quote." : "";
    button.disabled = saving || !value?.changed || (isUsd && Number(input.value) > 0 && quoteStatus(exchangeRate) !== "fresh");
    el("profit-dirty").hidden = !value?.changed;
    if (clearFeedback) el("profit-feedback").textContent = "";
  }
  mode.onchange = () => update(); input.oninput = () => update();
  el<HTMLFormElement>("profit-form").onsubmit = async event => {
    event.preventDefault(); if (saving || button.disabled) return;
    const value = draft(); saving = true; button.disabled = true; mode.disabled = true; input.disabled = true;
    el("profit-feedback").textContent = "Saving margin…";
    try { await save(value.setting); el("profit-feedback").textContent = "Margin saved for new requests."; }
    catch (error) {
      saving = false; mode.disabled = false; input.disabled = false; update(false);
      el("profit-feedback").textContent = (error as Error).message === "CONFIGURATION_BUSY" ? "A job is running. Your draft is kept; save when it finishes." : "Margin could not be saved. Your draft is kept; try again.";
    }
  };
  update();
  return { setExchangeRate(next: ExchangeRate) { exchangeRate = next; update(false); } };
}
