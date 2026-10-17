# Accounts and providers

Model configuration belongs to the **CVM's private admin**, not the public website. People using the workspace see the active provider label and its availability; they never need your model account or key.

## Choose a mode

| Mode | What it runs | What you need |
| --- | --- | --- |
| Deterministic fixture | Sample model output through the real local pipeline | Nothing beyond the local installation |
| ChatGPT subscription | Real generation using the operator's OAuth account | Interactive sign-in in private admin; available account/model access |
| Configured OpenAI Responses | Real, billable API requests | API account, accepted model and validated pricing/profile evidence |
| Local model | No built-in endpoint setting yet | A provider adapter change; [implementation path](./local-models) |

Local Cashu/NWC test sats are separate from provider usage in every mode. An API key can incur real API charges even though the app's local balance uses test sats.

## Use your ChatGPT subscription

1. Start the CVM, then run `bun scripts/open-dev-admin.ts` from the repository root. For a named instance, prefix it with the same `NAPPLET_CVM_DEV_INSTANCE` value.
2. In private admin, open **Provider & rates**, then choose **Continue with ChatGPT** and complete the browser authorization.
3. Select the account and an available model. Selection applies automatically. Check the workspace provider label before generating.
4. Use the jobs view to inspect pending, active and finished actions, including individual job details.

<GuideScreenshot audience="operators" name="subscription" alt="Private Generation model panel with a demo ChatGPT account, selected model, Continue with ChatGPT and Reload models controls" caption="Check the active model above the account selector. Selecting an account or model applies it automatically; the example account is fictional." />

The CVM keeps OAuth state in its private local directory across restarts. Repeated sign-in is not part of the normal development loop. A genuine authentication failure can require reconnecting; a timeout, large response or worker failure does not by itself mean you are signed out.

The admin opener passes a local operator credential in a URL fragment, which the page removes. Do not copy that launch URL to others. **Lock admin** ends that browser's admin session. The public static export excludes the admin page.

Model availability is confirmed by a successful request. A listed model is not a guarantee of permission or remaining subscription allowance. Manage subscription limits in the account's ChatGPT settings; API-credit balances are separate.

## Use an API account

Private admin accepts an account label/key, model, model profile, price card and captured price sources. The current adapter accepts `gpt-5-mini` or `gpt-5-mini-2025-08-07` at the fixed OpenAI Responses endpoint. It does not accept arbitrary OpenAI-compatible endpoints.

Open **Add an API account** beneath Generation pricing. Enter a label and your key, then supply the complete provider configuration. The JSON placeholder only shows the required top-level structure; its empty objects are not a valid configuration.

<GuideScreenshot audience="operators" name="api-account" alt="Expanded Add an API account form with a sample label, empty API key field and Provider configuration JSON field" caption="The key is entered only in private admin. Prepare the profile, price card and evidence described below before adding the account." />

You can also supply these five environment variables before launching:

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | Private API key |
| `NAPPLET_CVM_OPENAI_MODEL` | One of the accepted model identifiers above |
| `NAPPLET_CVM_OPENAI_PROFILE` | JSON model profile |
| `NAPPLET_CVM_OPENAI_PRICE_CARD` | JSON price card |
| `NAPPLET_CVM_OPENAI_PRICE_SOURCES` | JSON captured provider and conversion evidence |

The three configuration objects are **JSON values, not file paths**. All five variables must be present together; partial or invalid configuration fails startup. An account selected in private admin takes precedence over the environment configuration.

Use the [downloadable schema catalog](../implementers/schemas) for `operatorConfiguration.modelProfile` and `priceCard`. The source-of-truth validator is [development-model-gateway.ts](https://github.com/napplet/cvm/blob/main/src/dev/development-model-gateway.ts). To prepare evidence:

1. Capture the provider's applicable price document and the conversion source used for sat rates. Record exact bytes and their SHA-256 digests, URLs, observation/effective times and freshness deadlines.
2. Set each `priceSources.provider` and `priceSources.conversion` object to `{ "url": "…", "capturedBytes": "…", "sha256": "…" }`; each must match its price-card provenance.
3. Use `provider: "openai_responses"`, card `kind: "source_attributed_provider"`, matching model/profile/card IDs, positive integer-string rational rates and a current validity window. A rate is sats per usage unit; all supported dimensions must be priced.
4. Set explicit input/output maxima in the profile, within the card's ceilings. `selection` is currently the literal `unselected`; it is a validated contract field, not the admin selection switch.
5. Save the account and select it while no action is active. Confirm the configured-provider label and review the authorization maximum before a paid test.

Do not reuse fixture rates as real-provider price evidence. The validator checks freshness, matching digests and bounds; it cannot decide whether your captured commercial pricing and conversion choice are appropriate.

## Change rates or models

Private admin allows synthetic development rates. Real API pricing requires a new validated price card/evidence set. Active work blocks configuration changes, and saved actions retain their original pricing/model pins. An update is not permission to change an existing operation's accounting.

Enter one price per **1,000 tokens** for each billed category. For example, Input `1` and Output `1` mean one test sat per 1,000 input tokens and one test sat per 1,000 output tokens. Tokens are pieces of text or code; input includes the prompt and context, and output includes generated code.

The **Example request** updates as you edit: 10,000 input tokens plus 2,000 output tokens at those prices costs 12 test sats. Each billed category rounds up independently to a whole sat. Decimal prices such as `0.5` are supported. Select **Save rates** to apply changes to new actions; an unsuccessful save keeps your draft.

Rates, the example request, job totals and job details also show **approximate USD**. The CVM fetches the free [Kraken BTC/USD ticker](https://docs.kraken.com/api-reference/market-data/get-ticker-information), which needs no API key, and returns it through encrypted ContextVM. The browser does not contact the exchange. The source, BTC price and time checked appear beside the conversion. Quotes are cached for five minutes; a failed refresh uses a labelled **last known** quote for up to one hour, then shows **USD unavailable**. Sat prices and controls continue working.

USD equivalents use the current quote, including when viewing old jobs; they are not historical dollar receipts. For test sats, they are illustrative amounts, not subscription charges or redeemable balances. Billing remains in exact sats, and quote refreshes never change saved rates or unsaved edits.

Only categories billed separately by the selected provider appear. For ChatGPT, cached input and reasoning are included in input/output totals. These are local test charges; changing them does not alter your subscription price or usage limits. API-account rates are read-only in this editor and require updated pricing evidence.

<GuideScreenshot audience="operators" name="rates" alt="Generation prices per 1,000 tokens in test sats and approximate USD, with a twelve-test-sat example and its dollar equivalent" caption="Sat prices stay authoritative. Approximate USD and the quote source make small token prices easier to compare. This illustration uses a sample BTC price of $80,000." />

The CVM keeps exact fractions internally. Rates with more than six decimal places per 1,000 tokens are labelled as rounded for display; untouched values retain their original precision when another field is saved.

## OpenAI price discovery

OpenAI's documented [Models API](https://developers.openai.com/api/reference/resources/models/methods/list) returns model metadata, without list prices. Its [Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) reports incurred API spending. No official model list-price API was found in the documentation reviewed on October 17, 2026; use the [published pricing table](https://developers.openai.com/api/docs/pricing) for API price-card evidence. The live BTC quote above is for display and does not replace the conversion evidence pinned to a billable API price card.

Run `bun run pricing:sync` from the repository root to set local ChatGPT development test-sat rates automatically. Run `bun run pricing:sync --dry-run` to inspect the proposed rates first. A named local instance uses the same `NAPPLET_CVM_DEV_INSTANCE` variable as the launcher. The script loads **every model offered by each signed-in, plan-enabled ChatGPT account**, reads their exact rows from one fetch of OpenAI's [published Standard pricing table](https://developers.openai.com/api/docs/pricing.md), and converts short-context USD-per-million-token prices using one fresh Kraken BTC/USD quote from the CVM. It saves all model-specific rational rates in one signed `cvm_admin` update, then verifies them. The correct rates become active whenever you select a model; existing jobs keep their original price card. The script reports the source SHA-256, quote and price for each model. Unchanged rates are skipped, so the command is suitable for a future scheduled job. An unavailable model price, stale quote, active work or changed pricing context stops the whole update without partial rates.

These public **API list prices are only a reference for synthetic local test sats**. They do not measure or charge the operator's ChatGPT subscription, and the command never changes a configured API account's evidence-backed price card. Cached/reasoning categories stay at their existing rates because this ChatGPT adapter bills input and output totals only.
