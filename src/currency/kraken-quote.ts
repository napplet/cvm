import { QUOTE_FRESH_MS, quoteStatus, type BtcUsdQuote, type ExchangeRate } from "./btc-usd";

export const KRAKEN_BTC_USD_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";

/** Shared across admin requests. No keys, prompts, accounts or amounts leave the CVM. */
export class KrakenQuoteReader {
  #quote?: BtcUsdQuote;
  #retryAt = 0;
  #pending?: Promise<ExchangeRate>;
  constructor(private readonly request: (url: string, init: RequestInit) => Promise<Response> = fetch, private readonly now = Date.now) {}
  #snapshot(): ExchangeRate {
    const status = quoteStatus(this.#quote ? { status: "fresh", quote: this.#quote } : undefined, this.now());
    return status === "unavailable" ? { status } : { status, quote: { ...this.#quote! } };
  }
  async read(): Promise<ExchangeRate> {
    if (this.#pending) return this.#pending;
    if (this.now() < this.#retryAt) return this.#snapshot();
    this.#pending = this.#refresh();
    try { return await this.#pending; } finally { this.#pending = undefined; }
  }
  async #refresh(): Promise<ExchangeRate> {
    this.#retryAt = this.now() + 60_000;
    try {
      const response = await this.request(KRAKEN_BTC_USD_URL, { signal: AbortSignal.timeout(5000), redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("QUOTE_UNAVAILABLE"); }
      const reader = response.body.getReader(); let size = 0, text = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 16_384) throw new Error("QUOTE_TOO_LARGE");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body = JSON.parse(text), price = body?.result?.XXBTZUSD?.c?.[0];
      if (!Array.isArray(body?.error) || body.error.length || typeof price !== "string" || !/^[0-9]{1,12}(?:\.[0-9]{1,8})?$/.test(price) || Number(price) <= 0) throw new Error("INVALID_QUOTE");
      this.#quote = { source: "Kraken", usdPerBtc: price, fetchedAt: this.now() };
      this.#retryAt = this.now() + QUOTE_FRESH_MS;
    } catch { /* An outage cannot block sat pricing or accounting. */ }
    return this.#snapshot();
  }
}
