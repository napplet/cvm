---
status: complete
---
# Sync prices for all available ChatGPT models

1. Store synthetic development rates keyed by model in the CVM private operator state. Provide a signed batch admin action that validates and saves the entire catalog atomically. Preserve existing global fixture/legacy rates and make manual ChatGPT rate edits model-specific.
2. Have the package script enumerate all models available to the signed-in ChatGPT account(s), parse every exact row from one official OpenAI Standard pricing fetch, convert with one fresh Kraken quote, and batch-save. Fail without partial update when any available model lacks a price; support dry-run and unchanged no-op.
3. Verify model switching picks its own price card, rate persistence across restart, invalid/missing catalog failures, live dry-run/apply/idempotence, docs, state, commit and push.
