---
status: complete
---
# Sync development sat rates from OpenAI pricing

The current private admin runs a ChatGPT subscription model and accepts synthetic test-sat rates via signed `cvm_admin.save_rates`. OpenAI's public pricing Markdown has a Standard table with an exact `gpt-6.1-sol` row. It is API benchmark pricing, not the subscription bill.

1. Parse the exact selected model row from the official Standard/short-context table with bounded fetch and strict failure on ambiguity/layout changes. Convert USD per million tokens to rational sats per token using a fresh Kraken quote returned by the CVM.
2. Add `bun run pricing:sync` as a noninteractive script. Read the local operator credential, obtain current model/rates and quote through CVM, then save via signed admin tool. Support `--dry-run`, skip unchanged rates, display source digest, quote, old/new rates, and explicit synthetic-price wording. Never send credentials externally or overwrite configured API price cards.
3. Test parsing, exact math, unsupported models, stale quote, failure paths and signed live dry run. Update operator docs and GSD state, commit and push main.

No LLM is needed because the Markdown table provides exact structured values. A cron job can later run the same idempotent command; failure leaves the previous card intact.
