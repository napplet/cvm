---
task: 261017-j7a
status: complete
---
# Model-specific development price sync

The private CVM operator now stores synthetic rates by ChatGPT model. `save_model_rates` validates and saves a whole batch under the signed operator identity; manual rate edits on a ChatGPT model update only that model. The runtime chooses the corresponding rates whenever the operator selects a model. Legacy/global fixture rates remain separate. Existing action price-card pins are unchanged.

`bun run pricing:sync` enumerates every available model across signed-in, plan-enabled ChatGPT accounts, fetches the official OpenAI Standard pricing table once, uses one fresh Kraken quote, requires an exact price row for every model, and saves the complete model set atomically. The dry run previews every model. Failed catalog/pricing/quote checks leave all rates unchanged. A repeat run with the same quote is a no-op.

## Verification

- Nine targeted tests passed with 101 assertions, including batch validation, model-specific persistence, exact price conversion, missing model price and stale quote.
- Live dry run covered all seven models offered by the signed-in account. Live signed batch apply saved seven model rates. Switching to `gpt-6-luna` activated its matching price card; original `gpt-6.1-sol` was restored. Repeat sync returned seven unchanged.
- Local service was idle before restart, then restarted successfully. VitePress docs build passed; no new TypeScript diagnostics beyond the existing 411-error baseline.

Source: https://developers.openai.com/api/docs/pricing.md ; quote: https://docs.kraken.com/api-reference/market-data/get-ticker-information
