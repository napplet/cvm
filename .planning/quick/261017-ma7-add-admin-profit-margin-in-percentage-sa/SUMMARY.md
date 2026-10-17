---
task: 261017-ma7
status: complete
---
# Operator profit margin

Private admin now offers percentage markup on base cost, sats per 1,000 billed tokens, or USD per 1,000 billed tokens. The user explicitly chose the per-thousand-token basis for fixed amounts. The responsive editor shows base cost, profit and customer total in sats and indicative USD, validates drafts, preserves them on rejected saves, and displays the saved USD conversion. Default remains zero.

The signed `cvm_admin.save_profit` command stores the global policy privately and blocks changes during active work. Base model rates and pricing sync remain independent. USD converts with a fresh CVM Kraken quote when saved, with the exact fraction and quote pinned into immutable derived price-card/profile versions. ChatGPT, fixture, selected API and environment-configured API runtimes use the policy; old actions retain their existing pins.

Receipt pricing adds one separately disclosed service-fee line. Fixed amounts prorate over the sum of normalized, nonoverlapping billed token categories and round up once. Percentage markup uses the base cost. Authorization ceilings include profit. Zero-cost/rejected requests incur no fee, while paid model attempts whose build later fails still settle their recorded usage and applicable profit. Customer per-request cost breakdowns include the service fee. No schema migration or new HTTP API.

## Verification

- 47 focused unit/integration tests, 321 assertions passed: exact arithmetic, fractional rounding, split-category fee rounding, cap enforcement, pinned USD, original prices preserved, authorized saves, rollback/restart and pricing-sync independence, existing provider and accounting behavior.
- Real browser rate and profit editors passed all modes, current/pinned quote behavior, validation, zero-disable, busy retry and 320/375/768/1280 layouts.
- Composed OAuth fixture passed with actual signed CVM, local Cashu/relay/SQL, Docker builds and Paja. At 5 sats per 1,000 billed tokens, three 2,000-token requests each settled 13 sats (3 base + 10 profit), replay caused no extra debit, restart retained the policy, build failure settled, and interrupted response charged zero.
- Live admin refreshed at http://127.0.0.1:49371/admin; live browser confirms 12,000-token example adds 60 test sats at 5 sats/1,000, USD editor is available, and saved margin stays zero. No live model inference or margin mutation.
- Operator guide includes a real component screenshot; contract catalog verified. VitePress build and 1,335 links/assets/fragments across 38 pages passed. TypeScript has zero added normalized diagnostics versus the existing 411-error baseline.

The composed journey exposed a pre-existing diagnostic-console low-funds continuation/session-binding issue; see FOLLOWUP.md. Execution proof uses sufficient local funding in faucet-supported batches. Production verification remains deferred.
