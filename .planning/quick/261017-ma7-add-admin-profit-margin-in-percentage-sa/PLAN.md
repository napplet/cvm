---
status: complete
---
# Operator profit pricing

Add a global signed-admin profit setting: percentage markup on base cost, sats per 1,000 billed tokens, or USD per 1,000 billed tokens (user clarified the fixed-amount basis). Default zero. USD is converted with a fresh CVM Kraken quote when saving and pinned into each immutable price version. Preserve base model rates and price sync; apply the policy to ChatGPT, fixture and configured API runtimes. Include profit in authorization ceilings and exact receipt settlement, expose a separate service-fee cost line, and preserve existing job pins.

Build a responsive private-admin editor with explicit units, base/profit/customer-total example, validation, save feedback and pinned conversion. Verify arithmetic, cap safety, authorization, rollback/restart persistence, pricing sync independence and browser behavior. Update operator documentation and schema catalog, commit and push.
