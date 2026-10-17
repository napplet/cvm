---
task: 261017-j26
status: complete
---
# Automatic development price sync

Added `bun run pricing:sync` and `--dry-run`. The script reads the active ChatGPT development model and a fresh Kraken quote through signed CVM admin calls, fetches OpenAI's official Markdown Standard pricing table, extracts the exact short-context model row, converts USD per million tokens to exact rational test sats per token, and saves via signed `cvm_admin.save_rates`. It reports source SHA-256, quote, calculated prices and price-card IDs. It skips unchanged rates and fails closed on missing/ambiguous prices, stale quotes, configured API mode, changed context or rejected save. No LLM is needed because the official table is structured.

This is synthetic local development pricing benchmarked to public API list prices; it does not represent the operator's ChatGPT subscription bill. Configured API price cards remain evidence-backed and untouched. The operator guide explains the command and distinction.

## Verification

- Nine focused parser, math, quote, operator and sync tests passed (92 assertions); repeat sync was idempotent.
- Live dry run and apply through signed local CVM succeeded for `gpt-6.1-sol`; new price card `development-chatgpt-v2-1bb044328709351162c5e62a-card` saved. A second live run returned `unchanged`.
- Local CVM readiness passed; VitePress docs build passed; `git diff --check` clean.
- TypeScript has no new errors versus the existing 411-diagnostic baseline.

Source: https://developers.openai.com/api/docs/pricing.md ; conversion: https://docs.kraken.com/api-reference/market-data/get-ticker-information
