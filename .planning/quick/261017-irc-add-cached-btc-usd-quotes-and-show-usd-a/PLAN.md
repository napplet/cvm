---
status: complete
---
# BTC/USD equivalents in CVM admin

Use the GSD quick workflow inline. Verify OpenAI price discovery against official documentation; use Kraken's free, unauthenticated XBT/USD ticker for indicative conversion.

1. Add a bounded, cached CVM-side quote reader with freshness, retry cooldown and coalescing. Expose via the existing authenticated/encrypted `cvm_admin` protocol. No browser exchange requests or new HTTP API.
2. Show sats and approximate USD together in pricing rows, the example request, job totals, rows and details. Display source/freshness; preserve rates and billing, distinguish illustrative test-sat equivalents. Refresh quotes without resetting edits.
3. Test conversion, cache/failure behavior, authorization and browser rendering/responsiveness. Update illustrated operator docs, refresh idle local preview, commit and push main.

The exchange quote is display-only. It neither replaces validated API price evidence nor changes historical sat charges. OpenAI price automation is not part of this change: no documented list-price endpoint was found; Models exposes metadata, Costs reports historical spend.
