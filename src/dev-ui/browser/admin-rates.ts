import { quoteCaption, usdEquivalent, type ExchangeRate } from "../../currency/btc-usd";
import { profitCharge, type ProfitPolicy } from "../../model/profit";
export type Rate = { numerator: string; denominator: string };
type Pricing = { card: { id: string; kind: string; rates: Record<string, Rate>; supportedDimensions: string[]; profit?: ProfitPolicy }; profile: { provider: string } };
const titles: Record<string, [string, string]> = {
  input_tokens: ["Input", "Your prompt, instructions and context sent to the model."],
  output_tokens: ["Output", "Generated code and other text returned by the model."],
  cached_tokens: ["Cached input", "Reused input billed separately by this provider."],
  reasoning_tokens: ["Reasoning", "Internal reasoning billed separately by this provider."],
};
const scale = 1_000_000n;

/** Display precision never changes the saved rate. Only explicit edits convert. */
export function displayPerThousand(rate: Rate): { value: string; approximate: boolean } {
  const numerator = BigInt(rate.numerator) * 1000n * scale, denominator = BigInt(rate.denominator);
  const rounded = (numerator + denominator - 1n) / denominator;
  const fraction = (rounded % scale).toString().padStart(6, "0").replace(/0+$/, "");
  return { value: `${rounded / scale}${fraction ? "." + fraction : ""}`, approximate: numerator % denominator !== 0n };
}
export function rateFromPerThousand(value: string): Rate {
  if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value)) throw new Error("Enter a positive price, such as 1 or 0.5 (up to six decimal places).");
  const [whole, fraction = ""] = value.split(".");
  let numerator = BigInt(whole! + fraction), denominator = 1000n * 10n ** BigInt(fraction.length);
  if (!numerator) throw new Error("Enter a price greater than zero.");
  let a = numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a; denominator /= a;
  return { numerator: numerator.toString(), denominator: denominator.toString() };
}
export function exampleCharge(rates: Record<string, Rate>, dimensions: readonly string[], grouped = true): string {
  return Object.entries({ input_tokens: 10000n, output_tokens: 2000n }).reduce((sum, [dimension, tokens]) => {
    if (!dimensions.includes(dimension) || !rates[dimension]) return sum;
    const rate = rates[dimension]!;
    return sum + (tokens * BigInt(rate.numerator) + BigInt(rate.denominator) - 1n) / BigInt(rate.denominator);
  }, 0n)[grouped ? "toLocaleString" : "toString"]();
}

export const ratesMarkup = `<div id="rates-panel"><div class="rates-heading"><h2>Generation pricing</h2><span id="rates-mode" class="rates-mode"></span></div>
<p id="rates-explanation" class="supporting"></p>
<form id="rates-form" novalidate>
  <div class="rates-unit-heading"><h3>Base price per 1,000 tokens</h3><p class="supporting">Before the service fee. Tokens are small pieces of text or code.</p></div>
  <div id="rate-fields"></div><p id="rates-included" class="supporting"></p>
  <div class="rates-example"><div><strong>Example request</strong><p>10,000 input + 2,000 output tokens</p></div><div><output id="rates-example-cost" aria-live="polite"></output><span id="rates-example-usd" class="usd-equivalent"></span></div></div>
  <p id="rates-exchange" class="supporting"></p><p id="rates-currency-note" class="supporting"></p>
  <p id="rates-rounding" class="supporting"></p>
  <div class="rates-save"><button id="rates-save" class="primary" disabled>Save rates</button><span id="rates-dirty" hidden>Unsaved changes</span></div>
  <p id="rates-feedback" role="status"></p>
</form>
<p class="supporting">Changes apply to new actions. Existing jobs keep their original rates.</p>
<details class="rate-version"><summary>Price version</summary><p id="price-version" class="supporting"></p></details></div>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = "") { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; }

export function mountAdminRates(pricing: Pricing, save: (rates: Record<string, Rate>) => Promise<Pricing>, exchangeRate?: ExchangeRate): { setExchangeRate(next: ExchangeRate): void } {
  const original = structuredClone(pricing.card.rates);
  const editable = pricing.card.kind !== "source_attributed_provider";
  const unit = editable ? "test sats" : "sats";
  const fields: { name: string; input: HTMLInputElement; initial: string; help: HTMLElement; usd: HTMLElement }[] = [];
  let successor: ReturnType<typeof mountAdminRates> | undefined;
  let saving = false;
  el("rates-mode").textContent = editable ? "Local test pricing" : "API price card";
  el("rates-explanation").textContent = editable
    ? pricing.profile.provider === "openai_chatgpt_development" ? "Set what the CVM charges in local test sats. These rates do not change your ChatGPT subscription or its usage limits." : "Set what the CVM charges in local test sats for fixture runs."
    : "These prices come from the API account’s validated price card. To change them, add an updated API configuration with pricing evidence.";
  el("rate-fields").replaceChildren();
  for (const name of pricing.card.supportedDimensions) {
    if (!original[name]) continue;
    const [title, description] = titles[name] ?? [name, "Provider-reported usage."];
    const row = node("div", "", "rate-row");
    const text = node("div", "", "rate-description");
    const label = node("label", title); label.htmlFor = `rate-${name}`; text.append(label, node("p", description));
    const control = node("div", "", "rate-control"); const input = node("input", "");
    const display = displayPerThousand(original[name]!);
    input.id = label.htmlFor; input.name = name; input.type = "text"; input.inputMode = "decimal"; input.value = display.value; input.readOnly = !editable;
    input.setAttribute("aria-label", `${title} price (${unit} per 1,000 tokens)`);
    const suffix = node("span", `${unit} / 1,000 tokens`); suffix.id = `rate-unit-${name}`;
    const help = node("p", display.approximate ? "Rounded for display. Your exact saved rate is kept unless you edit this field." : "", "rate-field-help"); help.id = `rate-help-${name}`;
    input.setAttribute("aria-describedby", `${suffix.id} ${help.id}`);
    const usd = node("span", "", "usd-equivalent"); usd.id = `rate-usd-${name}`;
    input.setAttribute("aria-describedby", `${suffix.id} ${usd.id} ${help.id}`);
    control.append(input, suffix, usd); row.append(text, control, help); el("rate-fields").append(row);
    fields.push({ name, input, initial: display.value, help, usd }); input.oninput = () => update();
  }
  el("rates-included").textContent = pricing.profile.provider === "openai_chatgpt_development" ? "Cached input and reasoning are included in the input and output totals for this provider." : "";
  el("rates-rounding").textContent = `Each billed token category rounds up to a whole ${editable ? "test sat" : "sat"}.`;
  el("price-version").textContent = pricing.card.id;
  el("rates-save").hidden = !editable;
  el("rates-currency-note").textContent = editable ? "USD is an illustrative equivalent of test sats, not a subscription charge. Billing stays in sats." : "USD is an approximate equivalent at the current BTC price. Billing stays in sats.";
  function draft() {
    const rates = structuredClone(original); let valid = true, dirty = false;
    for (const field of fields) {
      const changed = field.input.value !== field.initial; dirty ||= changed;
      let error = "";
      if (changed) {
        try { rates[field.name] = rateFromPerThousand(field.input.value.trim()); }
        catch (cause) { valid = false; error = (cause as Error).message; }
        field.help.textContent = error;
      } else field.help.textContent = displayPerThousand(original[field.name]!).approximate ? "Rounded for display. Your exact saved rate is kept unless you edit this field." : "";
      field.input.setAttribute("aria-invalid", String(!!error)); field.input.setCustomValidity(error);
    }
    return { rates, valid, dirty };
  }
  function update() {
    const value = draft();
    updateCurrency(value);
    el("rates-example-cost").textContent = value.valid ? `${customerExample(value.rates).toLocaleString()} ${unit}` : "Enter valid prices";
    el<HTMLButtonElement>("rates-save").disabled = !editable || !value.dirty || !value.valid || saving;
    el("rates-dirty").hidden = !value.dirty;
    el("rates-feedback").textContent = "";
  }
  function updateCurrency(value = draft()) {
    for (const field of fields) {
      const rate = value.rates[field.name]!;
      field.usd.textContent = field.input.validity.valid ? usdEquivalent((BigInt(rate.numerator) * 1000n).toString(), exchangeRate, rate.denominator) : "—";
    }
    el("rates-example-usd").textContent = value.valid ? usdEquivalent(customerExample(value.rates).toString(), exchangeRate) : "—";
    el("rates-exchange").textContent = quoteCaption(exchangeRate);
  }
  function customerExample(rates: Record<string, Rate>) { const base = BigInt(exampleCharge(rates, pricing.card.supportedDimensions, false)); const tokens = (pricing.card.supportedDimensions.includes("input_tokens") ? 10000n : 0n) + (pricing.card.supportedDimensions.includes("output_tokens") ? 2000n : 0n); return base + profitCharge(base, tokens, pricing.card.profit); }
  el<HTMLFormElement>("rates-form").onsubmit = async event => {
    event.preventDefault(); const value = draft();
    if (!editable || saving || !value.dirty || !value.valid) { if (!value.valid) fields.find(field => !field.input.validity.valid)?.input.focus(); return; }
    saving = true; el<HTMLButtonElement>("rates-save").disabled = true;
    fields.forEach(field => field.input.disabled = true);
    el("rates-feedback").textContent = "Saving rates…";
    try {
      const next = await save(value.rates); successor = mountAdminRates(next, save, exchangeRate);
      el("rates-feedback").textContent = "Rates saved for new actions.";
    } catch (error) {
      saving = false; fields.forEach(field => field.input.disabled = false); update();
      el("rates-feedback").textContent = error instanceof Error && error.message === "CONFIGURATION_BUSY" ? "A job is running. Your changes are kept here; save again when it finishes." : "Rates could not be saved. Your changes are kept here; try again.";
    }
  };
  update();
  return { setExchangeRate(next: ExchangeRate) { exchangeRate = next; if (successor) successor.setExchangeRate(next); else updateCurrency(); } };
}
